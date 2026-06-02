import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorContext, DetectorResult, StoppedVmDisk } from "./types.js";
import { PRICING_NOTE, diskMonthlyGbp } from "../pricing/gcp-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.5;

/**
 * Disks attached to stopped (TERMINATED) VMs (CLAUDE.md §5: "stopped EC2 still
 * paying for attached EBS" — the GCP equivalent). A stopped VM costs nothing
 * for compute, but you keep paying for its disks. Caveat: a VM may be stopped
 * deliberately, so confidence is moderate and the fix says to verify.
 */
export const gcpStoppedVmDisks: Detector = {
  id: "gcp.stopped-vm-disks",
  provider: "gcp",
  title: "Disks on stopped VMs",

  async run(ctx: DetectorContext): Promise<DetectorResult> {
    const disks = await ctx.compute.stoppedInstanceDisks();
    const findings: Finding[] = [];

    for (const d of disks) {
      const saving = diskMonthlyGbp(d.sizeGb, d.diskType);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, d, saving));
    }

    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(ctx: DetectorContext, d: StoppedVmDisk, saving: number): Finding {
  return {
    detectorId: gcpStoppedVmDisks.id,
    provider: ctx.provider,
    resourceId: `gce-stopped-disk://${d.zone}/${d.diskName}`,
    resourceName: `${d.diskName} (VM ${d.instanceName})`,
    region: d.region,
    service: "Compute Engine",
    category: "idle",
    severity: severityFor(saving),
    title: `Stopped VM disk: ${d.instanceName}`,
    detail:
      `VM "${d.instanceName}" (${d.zone}) is stopped, but its ${d.boot ? "boot " : ""}disk ` +
      `"${d.diskName}" (${d.sizeGb} GiB ${d.diskType}) is still billed for capacity. ` +
      `If the VM is abandoned, delete it and its disks; if it's stopped on purpose, this is expected.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.6,
    metrics: { sizeGb: d.sizeGb, diskType: d.diskType, boot: d.boot, instance: d.instanceName, pricingNote: PRICING_NOTE },
    suggestedAction: `Verify the VM is abandoned, then: gcloud compute instances delete ${d.instanceName} --zone ${d.zone}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 50) return "high";
  if (saving >= 10) return "medium";
  return "low";
}
