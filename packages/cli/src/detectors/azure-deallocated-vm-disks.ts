import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AzureDetectorContext, AzureVmDisk } from "./azure-types.js";
import { PRICING_NOTE, diskMonthlyGbp } from "../pricing/azure-resources.js";

const MIN_MONTHLY_SAVING_GBP = 0.5;

/**
 * Managed disks attached to deallocated/stopped VMs. A deallocated VM costs
 * nothing for compute, but you keep paying for every attached disk. Caveat: a
 * VM may be stopped deliberately, so confidence is moderate and the fix says to
 * verify.
 */
export const azureDeallocatedVmDisks: Detector<AzureDetectorContext> = {
  id: "azure.deallocated-vm-disks",
  provider: "azure",
  title: "Disks on deallocated VMs",

  async run(ctx: AzureDetectorContext): Promise<DetectorResult> {
    const disks = await ctx.resources.deallocatedVmDisks();
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

function buildFinding(ctx: AzureDetectorContext, d: AzureVmDisk, saving: number): Finding {
  return {
    detectorId: azureDeallocatedVmDisks.id,
    provider: ctx.provider,
    resourceId: d.diskId,
    resourceName: `${d.diskName} (VM ${d.vmName})`,
    region: d.location,
    service: "Virtual Machine / Disk",
    category: "idle",
    severity: severityFor(saving),
    title: `Deallocated VM disk: ${d.vmName}`,
    detail:
      `VM "${d.vmName}" (${d.location}) is deallocated, but its ${d.os ? "OS " : "data "}disk ` +
      `"${d.diskName}" (${d.sizeGb} GiB ${d.sku}) is still billed for capacity. ` +
      `If the VM is abandoned, delete it and its disks; if it's stopped on purpose, this is expected.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.6,
    metrics: { sizeGb: d.sizeGb, sku: d.sku, os: d.os, vm: d.vmName, pricingNote: PRICING_NOTE },
    suggestedAction: `Verify the VM is abandoned, then: az disk delete --ids ${d.diskId} --yes`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 50) return "high";
  if (saving >= 10) return "medium";
  return "low";
}
