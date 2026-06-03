import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorResult } from "./types.js";
import type { AzureDetectorContext, AzureVm } from "./azure-types.js";
import { PRICING_NOTE, azureComputeRates, priceReclaimable, vmSpecs } from "../pricing/azure-resources.js";

const IDLE_THRESHOLD = 5; // peak "Percentage CPU" < 5% over the window = idle
const MIN_MONTHLY_SAVING_GBP = 1;

/**
 * Idle virtual machines. A running VM whose peak CPU stays under ~5% across the
 * window is a deallocate/downsize candidate. Both halves come from APIs we
 * already use (VM list + Monitor "Percentage CPU").
 *
 * Carefully scoped:
 *   - We only flag VMs we have metrics for (no data ≠ idle).
 *   - Confidence is moderate: a VM may be a deliberate standby / failover /
 *     batch box, so the fix says to verify.
 */
export const azureIdleInstances: Detector<AzureDetectorContext> = {
  id: "azure.idle-instances",
  provider: "azure",
  title: "Idle virtual machines",

  async run(ctx: AzureDetectorContext): Promise<DetectorResult> {
    const vms = await ctx.resources.runningVms();
    if (vms.length === 0) return { findings: [] };

    const peakById = await ctx.resources.cpuPeakByVm(
      vms.map((v) => ({ id: v.id })),
      ctx.windowDays,
    );

    const rates = azureComputeRates(ctx.env);
    const findings: Finding[] = [];
    for (const vm of vms) {
      const peak = peakById.get(vm.id);
      if (peak === undefined) continue; // no metrics → don't guess
      if (peak >= IDLE_THRESHOLD) continue;

      const { vcpu, gib } = vmSpecs(vm.vmSize);
      const saving = priceReclaimable(vcpu, gib, rates);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, vm, peak, vcpu, gib, saving));
    }

    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(
  ctx: AzureDetectorContext,
  vm: AzureVm,
  peak: number,
  vcpu: number,
  gib: number,
  saving: number,
): Finding {
  const pct = Math.round(peak);
  return {
    detectorId: azureIdleInstances.id,
    provider: ctx.provider,
    resourceId: vm.id,
    resourceName: `${vm.name} (${vm.vmSize}, ${vm.location})`,
    region: vm.location,
    service: "Virtual Machine",
    category: "idle",
    severity: severityFor(saving),
    title: `Idle VM: ${vm.name}`,
    detail:
      `VM "${vm.name}" (${vm.vmSize}, ~${vcpu} vCPU / ${gib.toFixed(0)} GiB, ${vm.location}) ` +
      `peaked at only ${pct}% CPU over ${ctx.windowDays}d. If it's not a deliberate standby/batch box, deallocate or downsize it.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.6,
    metrics: { peakCpuPct: pct, vcpu, gib, vmSize: vm.vmSize, pricingNote: PRICING_NOTE },
    suggestedAction: `Verify it's unused, then deallocate it: az vm deallocate --ids ${vm.id}`,
  };
}

function severityFor(saving: number): Severity {
  if (saving >= 100) return "high";
  if (saving >= 20) return "medium";
  return "low";
}
