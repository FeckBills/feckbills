import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AzureDetectorContext, AzureDisk } from "./azure-types.js";
import { PRICING_NOTE, diskMonthlyGbp } from "../pricing/azure-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.5;

/**
 * Unattached managed disks — Azure's "lost resource". A disk in the
 * `Unattached` state is mounted by no VM, but you still pay for the provisioned
 * tier.
 */
export const azureUnattachedDisks: Detector<AzureDetectorContext> = {
  id: "azure.unattached-disks",
  provider: "azure",
  title: "Unattached managed disks",

  async run(ctx: AzureDetectorContext): Promise<DetectorResult> {
    const disks = await ctx.resources.unattachedDisks();
    const findings: Finding[] = [];
    for (const d of disks) {
      const saving = diskMonthlyGbp(d.sizeGb, d.sku);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, d, saving));
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

function buildFinding(ctx: AzureDetectorContext, d: AzureDisk, saving: number): Finding {
  const age = daysSince(d.created);
  const ageText = age != null ? ` (created ~${age}d ago)` : "";
  return {
    detectorId: azureUnattachedDisks.id,
    provider: ctx.provider,
    resourceId: d.id,
    resourceName: `${d.name} (${d.location})`,
    region: d.location,
    service: "Managed Disk",
    category: "orphaned",
    severity: severityFor(saving),
    title: `Unattached disk: ${d.name}`,
    detail:
      `Managed disk "${d.name}" (${d.sizeGb} GiB ${d.sku}, ${d.location}) is in the "Unattached" ` +
      `state — mounted by no VM${ageText} — but still billed for its provisioned tier.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.85,
    metrics: { sizeGb: d.sizeGb, sku: d.sku, pricingNote: PRICING_NOTE },
    suggestedAction: `Snapshot if needed, then: az disk delete --ids ${d.id} --yes`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 50) return "high";
  if (saving >= 10) return "medium";
  return "low";
}
