import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorContext, DetectorResult, RunningInstance } from "./types.js";
import { gkeRates, priceReclaimable } from "../pricing/gke.js";
import { PRICING_NOTE } from "../pricing/gcp-resources.js";
import { max } from "../util/stats.js";

const CPU_METRIC = "compute.googleapis.com/instance/cpu/utilization";
const IDLE_THRESHOLD = 0.05; // peak CPU < 5% over the window = idle
const MIN_MONTHLY_SAVING_GBP = 1;

/**
 * Idle Compute Engine VMs (CLAUDE.md §5). A running VM whose peak CPU stays
 * under ~5% across the window is a stop/downsize candidate. Both halves come
 * from APIs we already use (Compute instance list + Monitoring CPU).
 *
 * Carefully scoped:
 *   - GKE node VMs (gke-*) are excluded — that's the GKE detector's job, and
 *     "idle" at the VM level says nothing about the pods they run.
 *   - We only flag VMs we have metrics for (no data ≠ idle).
 *   - Confidence is moderate: a VM may be a deliberate standby / failover / batch
 *     box, so the fix says to verify.
 */
export const gcpIdleInstances: Detector = {
  id: "gcp.idle-instances",
  provider: "gcp",
  title: "Idle Compute Engine VMs",

  async run(ctx: DetectorContext): Promise<DetectorResult> {
    const instances = (await ctx.compute.runningInstances()).filter((i) => !i.name.startsWith("gke-"));
    if (instances.length === 0) return { findings: [] };

    const series = await ctx.metrics.query({
      metricType: CPU_METRIC,
      resourceType: "gce_instance",
      windowDays: ctx.windowDays,
      perSeriesAligner: "ALIGN_MEAN",
      crossSeriesReducer: "REDUCE_NONE",
      groupByFields: ["resource.label.instance_id"],
    });
    const peakById = new Map<string, number>();
    for (const s of series) {
      const id = s.labels.instance_id;
      if (id) peakById.set(id, max(s.points));
    }

    const rates = gkeRates(ctx.env);
    const findings: Finding[] = [];
    for (const inst of instances) {
      const peak = peakById.get(inst.id);
      if (peak === undefined) continue; // no metrics → don't guess
      if (peak >= IDLE_THRESHOLD) continue;

      const { vcpu, gib } = machineSpecs(inst.machineType);
      const saving = priceReclaimable(vcpu, gib, rates);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;
      findings.push(buildFinding(ctx, inst, peak, vcpu, gib, saving));
    }

    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings };
  },
};

function buildFinding(
  ctx: DetectorContext,
  inst: RunningInstance,
  peak: number,
  vcpu: number,
  gib: number,
  saving: number,
): Finding {
  const pct = Math.round(peak * 100);
  return {
    detectorId: gcpIdleInstances.id,
    provider: ctx.provider,
    resourceId: `gce-instance://${inst.zone}/${inst.name}`,
    resourceName: `${inst.name} (${inst.machineType}, ${inst.zone})`,
    region: inst.region,
    service: "Compute Engine",
    category: "idle",
    severity: severityFor(saving),
    title: `Idle VM: ${inst.name}`,
    detail:
      `VM "${inst.name}" (${inst.machineType}, ~${vcpu} vCPU / ${gib.toFixed(0)} GiB, ${inst.zone}) ` +
      `peaked at only ${pct}% CPU over ${ctx.windowDays}d. If it's not a deliberate standby/batch box, stop or downsize it.`,
    estimatedMonthlySaving: saving,
    currency: ctx.currency,
    confidence: 0.6,
    metrics: { peakCpuUtilisation: round(peak), vcpu, gib: round(gib), machineType: inst.machineType, pricingNote: PRICING_NOTE },
    suggestedAction: `Verify it's unused, then stop it: gcloud compute instances stop ${inst.name} --zone ${inst.zone}`,
  };
}

/** Approximate vCPU + memory (GiB) for a machine type. Estimate — for pricing only. */
export function machineSpecs(type: string): { vcpu: number; gib: number } {
  const fixed: Record<string, [number, number]> = {
    "e2-micro": [2, 1],
    "e2-small": [2, 2],
    "e2-medium": [2, 4],
    "f1-micro": [1, 0.6],
    "g1-small": [1, 1.7],
  };
  const f = fixed[type];
  if (f) return { vcpu: f[0], gib: f[1] };

  const custom = type.match(/-custom-(\d+)-(\d+)/);
  if (custom) return { vcpu: Number(custom[1]), gib: Number(custom[2]) / 1024 };

  const m = type.match(/-(standard|highmem|highcpu)-(\d+)$/);
  if (m) {
    const n = Number(m[2]);
    const perVcpu = m[1] === "highmem" ? 8 : m[1] === "highcpu" ? 1 : 4;
    return { vcpu: n, gib: n * perVcpu };
  }

  const trailing = type.match(/-(\d+)$/);
  const vcpu = trailing ? Number(trailing[1]) : 2;
  return { vcpu, gib: vcpu * 4 };
}

function severityFor(saving: number): Severity {
  if (saving >= 100) return "high";
  if (saving >= 20) return "medium";
  return "low";
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
