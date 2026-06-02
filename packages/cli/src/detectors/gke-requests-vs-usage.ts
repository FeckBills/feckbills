import type { Finding, Severity } from "@feckbills/core";
import type { Detector, DetectorContext, DetectorResult } from "./types.js";
import type { GroupedSeries } from "../providers/gcp/monitoring.js";
import { gkeRates, priceReclaimable } from "../pricing/gke.js";
import { max, median, percentile } from "../util/stats.js";

const RESOURCE = "k8s_container";
const GROUP_BY = [
  "resource.label.cluster_name",
  "resource.label.location",
  "resource.label.namespace_name",
  "resource.label.container_name",
];

const METRICS = {
  cpuRequest: "kubernetes.io/container/cpu/request_cores",
  cpuUsage: "kubernetes.io/container/cpu/core_usage_time", // CUMULATIVE → ALIGN_RATE = cores
  memRequest: "kubernetes.io/container/memory/request_bytes",
  memUsage: "kubernetes.io/container/memory/used_bytes",
} as const;

const BYTES_PER_GIB = 1024 ** 3;

/**
 * Tunables. We compare requests against the **P95** of actual usage — not the
 * mean — so we never recommend cutting below a workload's real peaks. A
 * workload is only flagged if it's both meaningfully under-utilised AND the
 * reclaimable spend clears a floor, to keep the report about money, not noise.
 */
const USAGE_PERCENTILE = 95;
const UTIL_FLAG_THRESHOLD = 0.6; // flag when P95 usage < 60% of requests
const MIN_MONTHLY_SAVING_GBP = 1; // ignore sub-£1/mo dust

/**
 * GKE-managed system workloads we must NOT report. The "balloon" pods are
 * deliberate node-autoscaling headroom (they reserve capacity on purpose), and
 * everything in kube-system / gke-managed-* is platform plumbing the customer
 * can't right-size anyway. Flagging these is noise that destroys trust.
 * Override with FECKBILLS_GKE_INCLUDE_SYSTEM=true.
 */
const SYSTEM_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease"]);
const SYSTEM_NAMESPACE_PREFIXES = [
  "gke-managed",
  "gke-gmp-system",
  "gmp-system",
  "gatekeeper-system",
  "config-management",
  "anthos",
];

function isSystemNamespace(ns: string): boolean {
  if (SYSTEM_NAMESPACES.has(ns)) return true;
  return SYSTEM_NAMESPACE_PREFIXES.some((p) => ns === p || ns.startsWith(`${p}-`) || ns.startsWith(p));
}

/**
 * The wedge (CLAUDE.md §5, §13 step 2): pod resource *requests* far exceeding
 * actual *usage*. Both sides come from Cloud Monitoring, grouped to the
 * container level across all replicas, over the scan window.
 */
export const gkeRequestsVsUsage: Detector = {
  id: "gke.requests-vs-usage",
  provider: "gcp",
  title: "GKE over-provisioned pod requests (requests ≫ usage)",

  async run(ctx: DetectorContext): Promise<DetectorResult> {
    const [cpuReq, cpuUse, memReq, memUse] = await Promise.all([
      ctx.metrics.query({
        metricType: METRICS.cpuRequest,
        resourceType: RESOURCE,
        windowDays: ctx.windowDays,
        perSeriesAligner: "ALIGN_MEAN",
        crossSeriesReducer: "REDUCE_SUM",
        groupByFields: GROUP_BY,
      }),
      ctx.metrics.query({
        metricType: METRICS.cpuUsage,
        resourceType: RESOURCE,
        windowDays: ctx.windowDays,
        perSeriesAligner: "ALIGN_RATE",
        crossSeriesReducer: "REDUCE_SUM",
        groupByFields: GROUP_BY,
      }),
      ctx.metrics.query({
        metricType: METRICS.memRequest,
        resourceType: RESOURCE,
        windowDays: ctx.windowDays,
        perSeriesAligner: "ALIGN_MEAN",
        crossSeriesReducer: "REDUCE_SUM",
        groupByFields: GROUP_BY,
      }),
      ctx.metrics.query({
        metricType: METRICS.memUsage,
        resourceType: RESOURCE,
        windowDays: ctx.windowDays,
        perSeriesAligner: "ALIGN_MEAN",
        crossSeriesReducer: "REDUCE_SUM",
        groupByFields: GROUP_BY,
      }),
    ]);

    const rates = gkeRates(ctx.env);
    const workloads = new Map<string, WorkloadAgg>();

    indexBy(workloads, cpuReq, (w, pts) => (w.cpuRequestCores = max(pts)));
    indexBy(workloads, cpuUse, (w, pts) => (w.cpuUsageP95 = percentile(pts, USAGE_PERCENTILE)));
    indexBy(workloads, memReq, (w, pts) => (w.memRequestBytes = max(pts)));
    indexBy(workloads, memUse, (w, pts) => (w.memUsageP95 = percentile(pts, USAGE_PERCENTILE)));

    const includeSystem = ctx.env.FECKBILLS_GKE_INCLUDE_SYSTEM === "true";
    const findings: Finding[] = [];
    // Total compute the customer's own workloads RESERVE (requests × rate) —
    // the denominator for "what % of your GKE compute is reclaimable". Derived
    // from metrics, no billing API needed.
    let reservedMonthly = 0;

    for (const w of workloads.values()) {
      // Don't report GKE-managed system workloads — not the customer's to fix,
      // and "balloon" capacity-reservation pods are over-provisioned by design.
      if (!includeSystem && isSystemNamespace(w.namespace)) continue;

      // Skip workloads with no requests set — can't be "over-provisioned"
      // relative to nothing (that's a different detector: missing requests).
      if (w.cpuRequestCores <= 0 && w.memRequestBytes <= 0) continue;

      reservedMonthly += priceReclaimable(w.cpuRequestCores, w.memRequestBytes / BYTES_PER_GIB, rates);

      const cpuUtil = w.cpuRequestCores > 0 ? w.cpuUsageP95 / w.cpuRequestCores : 1;
      const memUtil = w.memRequestBytes > 0 ? w.memUsageP95 / w.memRequestBytes : 1;

      const cpuOver = cpuUtil < UTIL_FLAG_THRESHOLD;
      const memOver = memUtil < UTIL_FLAG_THRESHOLD;
      if (!cpuOver && !memOver) continue;

      const wasteCores = Math.max(0, w.cpuRequestCores - w.cpuUsageP95);
      const wasteGib = Math.max(0, (w.memRequestBytes - w.memUsageP95) / BYTES_PER_GIB);
      const saving = priceReclaimable(wasteCores, wasteGib, rates);
      if (saving < MIN_MONTHLY_SAVING_GBP) continue;

      const worstUtil = Math.min(cpuOver ? cpuUtil : 1, memOver ? memUtil : 1);
      findings.push(buildFinding(ctx, w, { cpuUtil, memUtil, wasteCores, wasteGib, saving, worstUtil, rates }));
    }

    // Biggest savings first — the report leads with money.
    findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving);
    return { findings, estimatedMonthlySpend: round(reservedMonthly) };
  },
};

interface WorkloadAgg {
  key: string;
  cluster: string;
  location: string;
  namespace: string;
  container: string;
  cpuRequestCores: number;
  cpuUsageP95: number;
  memRequestBytes: number;
  memUsageP95: number;
}

function workloadKey(labels: Record<string, string>): string {
  const cluster = labels.cluster_name ?? "?";
  const location = labels.location ?? "?";
  const ns = labels.namespace_name ?? "?";
  const container = labels.container_name ?? "?";
  return `${cluster}/${location}/${ns}/${container}`;
}

function ensure(map: Map<string, WorkloadAgg>, labels: Record<string, string>): WorkloadAgg {
  const key = workloadKey(labels);
  let w = map.get(key);
  if (!w) {
    w = {
      key,
      cluster: labels.cluster_name ?? "?",
      location: labels.location ?? "?",
      namespace: labels.namespace_name ?? "?",
      container: labels.container_name ?? "?",
      cpuRequestCores: 0,
      cpuUsageP95: 0,
      memRequestBytes: 0,
      memUsageP95: 0,
    };
    map.set(key, w);
  }
  return w;
}

function indexBy(
  map: Map<string, WorkloadAgg>,
  series: GroupedSeries[],
  apply: (w: WorkloadAgg, points: number[]) => void,
): void {
  for (const s of series) {
    if (s.points.length === 0) continue;
    apply(ensure(map, s.labels), s.points);
  }
}

function buildFinding(
  ctx: DetectorContext,
  w: WorkloadAgg,
  m: {
    cpuUtil: number;
    memUtil: number;
    wasteCores: number;
    wasteGib: number;
    saving: number;
    worstUtil: number;
    rates: ReturnType<typeof gkeRates>;
  },
): Finding {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const cores = (x: number) => x.toFixed(2);
  const gib = (x: number) => x.toFixed(2);

  const detail =
    `Container "${w.container}" (namespace ${w.namespace}, cluster ${w.cluster}/${w.location}) ` +
    `requests ${cores(w.cpuRequestCores)} vCPU and ${gib(w.memRequestBytes / BYTES_PER_GIB)} GiB across all replicas, ` +
    `but P${USAGE_PERCENTILE} usage over ${ctx.windowDays}d was only ${cores(w.cpuUsageP95)} vCPU (${pct(m.cpuUtil)}) ` +
    `and ${gib(w.memUsageP95 / BYTES_PER_GIB)} GiB (${pct(m.memUtil)}). ` +
    `Reclaimable: ${cores(m.wasteCores)} vCPU + ${gib(m.wasteGib)} GiB.`;

  return {
    detectorId: gkeRequestsVsUsage.id,
    provider: ctx.provider,
    resourceId: `gke://${w.key}`,
    resourceName: `${w.namespace}/${w.container} @ ${w.cluster}`,
    region: w.location,
    service: "GKE",
    category: "over-provisioned",
    severity: severityFor(m.saving, m.worstUtil),
    title: `Over-provisioned GKE workload: ${w.namespace}/${w.container}`,
    detail,
    estimatedMonthlySaving: m.saving,
    currency: ctx.currency,
    confidence: confidenceFor(ctx.windowDays, m.worstUtil),
    metrics: {
      cpuRequestCores: round(w.cpuRequestCores),
      cpuUsageP95Cores: round(w.cpuUsageP95),
      cpuUtilisation: round(m.cpuUtil),
      memRequestGib: round(w.memRequestBytes / BYTES_PER_GIB),
      memUsageP95Gib: round(w.memUsageP95 / BYTES_PER_GIB),
      memUtilisation: round(m.memUtil),
      reclaimableVcpu: round(m.wasteCores),
      reclaimableGib: round(m.wasteGib),
      windowDays: ctx.windowDays,
      pricingSource: m.rates.source,
    },
    suggestedAction:
      `Lower requests toward observed P${USAGE_PERCENTILE} + headroom ` +
      `(≈ ${cores(w.cpuUsageP95 * 1.2)} vCPU / ${gib((w.memUsageP95 / BYTES_PER_GIB) * 1.2)} GiB), or enable VPA in recommendation mode to right-size automatically.`,
  };
}

function severityFor(saving: number, worstUtil: number): Severity {
  if (saving >= 200 || worstUtil < 0.1) return "high";
  if (saving >= 50 || worstUtil < 0.3) return "medium";
  return "low";
}

function confidenceFor(windowDays: number, worstUtil: number): number {
  // Longer windows and lower utilisation → more confident it's genuinely idle.
  const windowFactor = Math.min(1, windowDays / 14);
  const utilFactor = 1 - worstUtil; // lower util, higher confidence
  return round(0.5 + 0.5 * windowFactor * Math.max(0.2, utilFactor));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// re-exported for the fixture/tests that want the same median semantics
export { median };
