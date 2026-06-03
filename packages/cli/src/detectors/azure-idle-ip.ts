import type { Finding } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AzureDetectorContext, AzureIp } from "./azure-types.js";
import { PRICING_NOTE, ipMonthlyGbp } from "../pricing/azure-resources.js";

/**
 * Unassociated public IP addresses. Azure bills a reserved public IP that isn't
 * attached to a NIC / load balancer / gateway — pure waste until released.
 */
export const azureIdleIp: Detector<AzureDetectorContext> = {
  id: "azure.idle-ip",
  provider: "azure",
  title: "Unassociated public IPs",

  async run(ctx: AzureDetectorContext): Promise<DetectorResult> {
    const ips = await ctx.resources.idleIps();
    const rate = ipMonthlyGbp();
    const findings = ips.map((ip) => buildFinding(ctx, ip, rate));
    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(ctx: AzureDetectorContext, ip: AzureIp, saving: number): Finding {
  return {
    detectorId: azureIdleIp.id,
    provider: ctx.provider,
    resourceId: ip.id,
    resourceName: `${ip.name}${ip.ipAddress ? ` (${ip.ipAddress})` : ""}`,
    region: ip.location,
    service: "Public IP",
    category: "orphaned",
    severity: "low",
    title: `Unassociated public IP: ${ip.name}`,
    detail:
      `${ip.sku} public IP "${ip.name}"${ip.ipAddress ? ` (${ip.ipAddress})` : ""} (${ip.location}) ` +
      `is associated with nothing, but reserved public IPs are billed while idle.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.9,
    metrics: { ipAddress: ip.ipAddress, sku: ip.sku, pricingNote: PRICING_NOTE },
    suggestedAction: `Release it: az network public-ip delete --ids ${ip.id}`,
  };
}
