import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AzureDetectorContext, AzureSnapshot } from "./azure-types.js";
import { PRICING_NOTE, snapshotMonthlyGbp } from "../pricing/azure-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.2;
const STALE_DAYS = 90;

/**
 * Orphaned & stale managed-disk snapshots. We flag two clear cases, and stay
 * careful because a snapshot is often a legitimate backup:
 *   - orphaned: the source disk no longer exists (high confidence)
 *   - stale: older than 90 days (low confidence, "verify it's still needed")
 */
export const azureOrphanedSnapshots: Detector<AzureDetectorContext> = {
  id: "azure.orphaned-snapshots",
  provider: "azure",
  title: "Orphaned & stale snapshots",

  async run(ctx: AzureDetectorContext): Promise<DetectorResult> {
    const snaps = await ctx.resources.snapshots();
    const findings: Finding[] = [];
    for (const s of snaps) {
      const stale = s.ageDays != null && s.ageDays >= STALE_DAYS;
      if (!s.orphaned && !stale) continue;
      const saving = snapshotMonthlyGbp(s.sizeGb);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, s, saving));
    }
    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(ctx: AzureDetectorContext, s: AzureSnapshot, saving: number): Finding {
  const ageText = s.ageDays != null ? `${s.ageDays}d old` : "age unknown";
  const detail = s.orphaned
    ? `Snapshot "${s.name}" (${s.sizeGb} GiB, ${ageText}) — its source disk no longer exists, so it's almost certainly an orphaned leftover.`
    : `Snapshot "${s.name}" (${s.sizeGb} GiB) is ${ageText}. If it's not part of a retention policy you still need, it's reclaimable — verify before deleting.`;
  return {
    detectorId: azureOrphanedSnapshots.id,
    provider: ctx.provider,
    resourceId: s.id,
    resourceName: `${s.name} (${s.location})`,
    region: s.location,
    service: "Snapshot",
    category: "orphaned",
    severity: severityFor(saving),
    title: s.orphaned ? `Orphaned snapshot: ${s.name}` : `Stale snapshot: ${s.name}`,
    detail,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: s.orphaned ? 0.8 : 0.4,
    metrics: { sizeGb: s.sizeGb, ageDays: s.ageDays, orphaned: s.orphaned, pricingNote: PRICING_NOTE },
    suggestedAction: `Confirm it isn't a needed backup, then: az snapshot delete --ids ${s.id}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 20) return "medium";
  return "low";
}
