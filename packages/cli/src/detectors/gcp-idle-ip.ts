import type { Finding } from "@feckbills/core";
import type { Detector, DetectorContext, DetectorResult, IdleAddress } from "./types.js";
import { PRICING_NOTE, idleIpMonthlyGbp } from "../pricing/gcp-resources.js";

/**
 * Reserved-but-idle static external IPs (CLAUDE.md §5). GCP bills a reserved
 * static IP that isn't attached to anything — pure waste until released.
 */
export const gcpIdleIp: Detector = {
  id: "gcp.idle-ip",
  provider: "gcp",
  title: "Reserved-but-idle static IPs",

  async run(ctx: DetectorContext): Promise<DetectorResult> {
    const addresses = await ctx.compute.idleAddresses();
    const rate = idleIpMonthlyGbp();
    const findings = addresses.map((a) => buildFinding(ctx, a, rate));
    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(ctx: DetectorContext, a: IdleAddress, saving: number): Finding {
  const scope = a.region === "global" ? "global" : a.region;
  return {
    detectorId: gcpIdleIp.id,
    provider: ctx.provider,
    resourceId: `gce-address://${scope}/${a.name}`,
    resourceName: `${a.name} (${a.address})`,
    region: a.region,
    service: "External IP",
    category: "orphaned",
    severity: "low",
    title: `Idle static IP: ${a.name}`,
    detail: `Reserved ${a.addressType.toLowerCase()} static IP ${a.address} (${scope}) is not attached to any resource, but reserved IPs are billed while idle.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.9,
    metrics: { address: a.address, scope, addressType: a.addressType, pricingNote: PRICING_NOTE },
    suggestedAction:
      a.region === "global"
        ? `Release it: gcloud compute addresses delete ${a.name} --global`
        : `Release it: gcloud compute addresses delete ${a.name} --region ${a.region}`,
  };
}
