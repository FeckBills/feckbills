import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AwsDetectorContext, AwsSnapshot } from "./aws-types.js";
import { PRICING_NOTE, snapshotMonthlyGbp } from "../pricing/aws-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.2;
const STALE_DAYS = 90;

/**
 * Orphaned & stale EBS snapshots. Snapshots are easy to accumulate and forget.
 * We flag two clear cases, and stay careful because a snapshot is often a
 * legitimate backup:
 *   - orphaned: the source volume no longer exists (high confidence)
 *   - stale: older than 90 days (low confidence, "verify it's still needed")
 *
 * Priced on the source-volume size (a conservative upper bound — AWS bills only
 * changed blocks, but that data isn't in the describe call).
 */
export const awsOrphanedSnapshots: Detector<AwsDetectorContext> = {
  id: "aws.orphaned-snapshots",
  provider: "aws",
  title: "Orphaned & stale EBS snapshots",

  async run(ctx: AwsDetectorContext): Promise<DetectorResult> {
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

function buildFinding(ctx: AwsDetectorContext, s: AwsSnapshot, saving: number): Finding {
  const label = s.name ?? s.id;
  const ageText = s.ageDays != null ? `${s.ageDays}d old` : "age unknown";
  const detail = s.orphaned
    ? `Snapshot ${s.id}${s.name ? ` ("${s.name}")` : ""} (${s.sizeGb} GiB source, ${ageText}) — its source volume no longer exists, so it's almost certainly an orphaned leftover.`
    : `Snapshot ${s.id}${s.name ? ` ("${s.name}")` : ""} (${s.sizeGb} GiB source) is ${ageText}. If it's not part of a retention policy you still need, it's reclaimable — verify before deleting.`;
  return {
    detectorId: awsOrphanedSnapshots.id,
    provider: ctx.provider,
    resourceId: `aws-snapshot://${s.region}/${s.id}`,
    resourceName: `${label} (${s.region})`,
    region: s.region,
    service: "EBS Snapshot",
    category: "orphaned",
    severity: severityFor(saving),
    title: s.orphaned ? `Orphaned snapshot: ${label}` : `Stale snapshot: ${label}`,
    detail,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: s.orphaned ? 0.8 : 0.4,
    metrics: { sizeGb: s.sizeGb, ageDays: s.ageDays, orphaned: s.orphaned, snapshotId: s.id, pricingNote: PRICING_NOTE },
    suggestedAction: `Confirm it isn't a needed backup, then: aws ec2 delete-snapshot --snapshot-id ${s.id} --region ${s.region}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 20) return "medium";
  return "low";
}
