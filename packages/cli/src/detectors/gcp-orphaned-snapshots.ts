import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorContext, DetectorResult, SnapshotInfo } from "./types.js";
import { PRICING_NOTE, snapshotMonthlyGbp } from "../pricing/gcp-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.2;
const STALE_DAYS = 90;

/**
 * Orphaned & stale snapshots (CLAUDE.md §5). Snapshots are easy to accumulate
 * and forget. We only flag two clear cases — and we're careful, because a
 * snapshot is often a legitimate backup:
 *   - orphaned: the source disk no longer exists (high confidence)
 *   - stale: older than 90 days (low confidence, "verify it's still needed")
 */
export const gcpOrphanedSnapshots: Detector = {
  id: "gcp.orphaned-snapshots",
  provider: "gcp",
  title: "Orphaned & stale snapshots",

  async run(ctx: DetectorContext): Promise<DetectorResult> {
    const snaps = await ctx.compute.snapshots();
    const findings: Finding[] = [];

    for (const s of snaps) {
      const stale = s.ageDays != null && s.ageDays >= STALE_DAYS;
      if (!s.orphaned && !stale) continue;

      const saving = snapshotMonthlyGbp(s.storageGb);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, s, saving));
    }

    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(ctx: DetectorContext, s: SnapshotInfo, saving: number): Finding {
  const ageText = s.ageDays != null ? `${s.ageDays}d old` : "age unknown";
  const detail = s.orphaned
    ? `Snapshot "${s.name}" (${s.storageGb.toFixed(0)} GiB stored, ${ageText}) — its source disk no longer exists, so it's almost certainly an orphaned leftover.`
    : `Snapshot "${s.name}" (${s.storageGb.toFixed(0)} GiB stored) is ${ageText}. If it's not part of a retention policy you still need, it's reclaimable — verify before deleting.`;

  return {
    detectorId: gcpOrphanedSnapshots.id,
    provider: ctx.provider,
    resourceId: `gce-snapshot://${s.name}`,
    resourceName: s.name,
    region: "global",
    service: "Snapshot",
    category: "orphaned",
    severity: severityFor(saving),
    title: s.orphaned ? `Orphaned snapshot: ${s.name}` : `Stale snapshot: ${s.name}`,
    detail,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: s.orphaned ? 0.8 : 0.4,
    metrics: { storageGb: round(s.storageGb), sourceDiskGb: s.sizeGb, ageDays: s.ageDays, orphaned: s.orphaned, pricingNote: PRICING_NOTE },
    suggestedAction: `Confirm it isn't a needed backup, then: gcloud compute snapshots delete ${s.name}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 20) return "medium";
  return "low";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
