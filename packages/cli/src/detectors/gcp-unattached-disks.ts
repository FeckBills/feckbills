import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorContext, DetectorResult, UnattachedDisk } from "./types.js";
import { PRICING_NOTE, diskMonthlyGbp } from "../pricing/gcp-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.5;

/**
 * Unattached persistent disks — classic "lost resource" (CLAUDE.md §5). A disk
 * with no `users` isn't mounted by any VM, but you still pay for the capacity.
 *
 * Caveat baked in: GKE-managed `pvc-*` disks may be bound PersistentVolumes
 * that are simply unmounted right now (no pod scheduled) rather than truly
 * orphaned — so we flag them at lower confidence with a "verify the PVC" note.
 */
export const gcpUnattachedDisks: Detector = {
  id: "gcp.unattached-disks",
  provider: "gcp",
  title: "Unattached persistent disks",

  async run(ctx: DetectorContext): Promise<DetectorResult> {
    const disks = await ctx.compute.unattachedDisks();
    const findings: Finding[] = [];

    for (const d of disks) {
      const saving = diskMonthlyGbp(d.sizeGb, d.type);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, d, saving));
    }

    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function isGkePvc(name: string): boolean {
  return name.startsWith("pvc-");
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

function buildFinding(ctx: DetectorContext, d: UnattachedDisk, saving: number): Finding {
  const pvc = isGkePvc(d.name);
  const age = daysSince(d.lastDetach) ?? daysSince(d.created);
  const ageText = age != null ? ` (unattached ~${age}d)` : "";

  const detail = pvc
    ? `GKE-managed disk "${d.name}" (${d.sizeGb} GiB ${d.type}, ${d.zone}) is attached to no VM${ageText}. ` +
      `It may be a Retain-policy leftover or a temporarily-unmounted PersistentVolume — verify its PersistentVolumeClaim is unused before deleting.`
    : `Disk "${d.name}" (${d.sizeGb} GiB ${d.type}, ${d.zone}) is attached to no VM${ageText} but still billed for capacity.`;

  return {
    detectorId: gcpUnattachedDisks.id,
    provider: ctx.provider,
    resourceId: `gce-disk://${d.zone}/${d.name}`,
    resourceName: `${d.name} (${d.zone})`,
    region: d.region,
    service: "Persistent Disk",
    category: "orphaned",
    severity: severityFor(saving),
    title: `Unattached disk: ${d.name}`,
    detail,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: pvc ? 0.6 : 0.85,
    metrics: { sizeGb: d.sizeGb, diskType: d.type, zone: d.zone, unattachedDays: age, pricingNote: PRICING_NOTE },
    suggestedAction: pvc
      ? `Confirm the PVC is unused, then delete: gcloud compute disks delete ${d.name} --zone ${d.zone}`
      : `Snapshot if needed, then: gcloud compute disks delete ${d.name} --zone ${d.zone}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 50) return "high";
  if (saving >= 10) return "medium";
  return "low";
}
