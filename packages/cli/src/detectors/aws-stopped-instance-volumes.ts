import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AwsDetectorContext, AwsStoppedInstanceVolume } from "./aws-types.js";
import { PRICING_NOTE, ebsMonthlyGbp } from "../pricing/aws-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.5;

/**
 * EBS volumes attached to stopped EC2 instances (CLAUDE.md §5: "stopped EC2
 * still paying for attached EBS"). A stopped instance costs nothing for
 * compute, but you keep paying for every attached volume. Caveat: an instance
 * may be stopped deliberately, so confidence is moderate and the fix says to
 * verify.
 */
export const awsStoppedInstanceVolumes: Detector<AwsDetectorContext> = {
  id: "aws.stopped-instance-volumes",
  provider: "aws",
  title: "EBS on stopped instances",

  async run(ctx: AwsDetectorContext): Promise<DetectorResult> {
    const volumes = await ctx.resources.stoppedInstanceVolumes();
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

function buildFinding(ctx: AwsDetectorContext, v: AwsStoppedInstanceVolume, saving: number): Finding {
  return {
    detectorId: awsStoppedInstanceVolumes.id,
    provider: ctx.provider,
    resourceId: `aws-stopped-ebs://${v.region}/${v.volumeId}`,
    resourceName: `${v.volumeId} (instance ${v.instanceName})`,
    region: v.region,
    service: "EC2 / EBS",
    category: "idle",
    severity: severityFor(saving),
    title: `EBS on stopped instance: ${v.instanceName}`,
    detail:
      `Instance "${v.instanceName}" (${v.region}) is stopped, but its ${v.root ? "root " : ""}volume ` +
      `${v.volumeId} (${v.sizeGb} GiB ${v.type}) is still billed for capacity. ` +
      `If the instance is abandoned, terminate it and delete its volumes; if it's stopped on purpose, this is expected.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.6,
    metrics: { sizeGb: v.sizeGb, volumeType: v.type, root: v.root, instanceId: v.instanceId, pricingNote: PRICING_NOTE },
    suggestedAction: `Verify the instance is abandoned, then: aws ec2 terminate-instances --instance-ids ${v.instanceId} --region ${v.region}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 50) return "high";
  if (saving >= 10) return "medium";
  return "low";
}
