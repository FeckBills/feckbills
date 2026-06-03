import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AwsDetectorContext, AwsVolume } from "./aws-types.js";
import { PRICING_NOTE, ebsMonthlyGbp } from "../pricing/aws-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.5;

/**
 * Unattached EBS volumes — the AWS classic "lost resource". A volume in the
 * `available` state is mounted by no instance, but you still pay for every
 * provisioned GiB.
 */
export const awsUnattachedVolumes: Detector<AwsDetectorContext> = {
  id: "aws.unattached-volumes",
  provider: "aws",
  title: "Unattached EBS volumes",

  async run(ctx: AwsDetectorContext): Promise<DetectorResult> {
    const volumes = await ctx.resources.unattachedVolumes();
    const findings: Finding[] = [];
    for (const v of volumes) {
      const saving = ebsMonthlyGbp(v.sizeGb, v.type);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, v, saving));
    }
    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

function buildFinding(ctx: AwsDetectorContext, v: AwsVolume, saving: number): Finding {
  const label = v.name ?? v.id;
  const age = daysSince(v.created);
  const ageText = age != null ? ` (created ~${age}d ago)` : "";
  return {
    detectorId: awsUnattachedVolumes.id,
    provider: ctx.provider,
    resourceId: `aws-ebs://${v.region}/${v.id}`,
    resourceName: `${label} (${v.region})`,
    region: v.region,
    service: "EBS",
    category: "orphaned",
    severity: severityFor(saving),
    title: `Unattached EBS volume: ${label}`,
    detail:
      `EBS volume ${v.id}${v.name ? ` ("${v.name}")` : ""} (${v.sizeGb} GiB ${v.type}, ${v.az}) ` +
      `is in the "available" state — attached to no instance${ageText} — but still billed for capacity.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.85,
    metrics: { sizeGb: v.sizeGb, volumeType: v.type, az: v.az, volumeId: v.id, pricingNote: PRICING_NOTE },
    suggestedAction: `Snapshot if needed, then: aws ec2 delete-volume --volume-id ${v.id} --region ${v.region}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 50) return "high";
  if (saving >= 10) return "medium";
  return "low";
}
