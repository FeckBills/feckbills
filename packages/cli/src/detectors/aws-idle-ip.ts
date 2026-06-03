import type { Finding } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AwsAddress, AwsDetectorContext } from "./aws-types.js";
import { PRICING_NOTE, eipMonthlyGbp } from "../pricing/aws-resources.js";

/**
 * Unassociated Elastic IPs. Since AWS began charging for all public IPv4
 * (Feb 2024), an allocated EIP that isn't associated with a running resource is
 * billed at ~$0.005/hr for nothing — pure waste until released.
 */
export const awsIdleIp: Detector<AwsDetectorContext> = {
  id: "aws.idle-ip",
  provider: "aws",
  title: "Unassociated Elastic IPs",

  async run(ctx: AwsDetectorContext): Promise<DetectorResult> {
    const addresses = await ctx.resources.unassociatedAddresses();
    const rate = eipMonthlyGbp();
    const findings = addresses.map((a) => buildFinding(ctx, a, rate));
    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(ctx: AwsDetectorContext, a: AwsAddress, saving: number): Finding {
  const label = a.name ?? a.publicIp;
  return {
    detectorId: awsIdleIp.id,
    provider: ctx.provider,
    resourceId: `aws-eip://${a.region}/${a.allocationId}`,
    resourceName: `${label} (${a.publicIp})`,
    region: a.region,
    service: "Elastic IP",
    category: "orphaned",
    severity: "low",
    title: `Unassociated Elastic IP: ${label}`,
    detail:
      `Elastic IP ${a.publicIp} (${a.region}) is allocated but associated with nothing. ` +
      `AWS bills unassociated public IPv4 addresses, so it's costing you while idle.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.9,
    metrics: { publicIp: a.publicIp, allocationId: a.allocationId, pricingNote: PRICING_NOTE },
    suggestedAction: `Release it: aws ec2 release-address --allocation-id ${a.allocationId} --region ${a.region}`,
  };
}
