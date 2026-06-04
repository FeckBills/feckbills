import { GoogleAuth } from "google-auth-library";
import type { MetricSource } from "../../detectors/types.js";
import { gkeRates, priceReclaimable } from "../../pricing/gke.js";
import { isSystemNamespace } from "../../detectors/gke-requests-vs-usage.js";

/**
 * GKE namespace activity — "which namespaces are actually used". Built entirely
 * from read-only Cloud Monitoring + the Compute backend-service list (no kube
 * API): per-namespace reserved vs used CPU, network I/O, and real request
 * traffic joined from the HTTP(S) load balancers. Feeds the activity heatmap
 * and the zombie-namespace / idle-LB detectors.
 */

const BYTES_PER_GIB = 1024 ** 3;

export interface NamespaceActivity {
  namespace: string;
  /** GKE cluster this namespace lives in (Monitoring `cluster_name`). A project
   *  can run several clusters, each with its own `prod`/`default`/etc. */
  cluster: string;
  /** Cluster location (region or zone) — disambiguates same-named clusters. */
  location: string;
  reservedCores: number;
  reservedGib: number;
  usedCores: number;
  /** usedCores / reservedCores, 0–1 (null if nothing reserved). */
  utilisation: number | null;
  netInKiBs: number;
  netOutKiBs: number;
  /** External requests/sec across this namespace's LB backends. */
  reqPerSec: number;
  /** Reclaimable £/mo if the whole namespace is dead (its reserved compute). */
  reservedMonthlyGbp: number;
  system: boolean;
  /** A common cluster add-on (idle-by-design infra) — not a reclaim candidate. */
  addon: boolean;
  /** Near-zero usage + network + traffic over the window (non-system, non-add-on). */
  idle: boolean;
  /** used-CPU cores per time bucket, chronological — the heatmap row. */
  series: number[];
}

/** Aim for ~24 heatmap columns regardless of window length. */
const HEATMAP_COLS = 24;

/**
 * Well-known cluster add-ons that are *meant* to sit near-idle (periodic or
 * event-driven work) — flagging them as reclaimable is a false positive that
 * erodes trust, same lesson as the GKE system-namespace exclusion.
 */
const COMMON_ADDONS = new Set([
  "cert-manager",
  "external-dns",
  "tailscale",
  "kube-green",
  "ingress-nginx",
  "metrics-server",
  "external-secrets",
  "reloader",
]);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** A namespace is identified by (cluster, location, name) — a bare name can
 *  recur across clusters. We key the per-metric maps by this composite so two
 *  clusters' `prod` namespaces never merge. All three are DNS-1123 labels, so
 *  `/` can't appear in any of them. */
const SEP = "/";
const nsKey = (cluster: string, location: string, namespace: string) => `${cluster}${SEP}${location}${SEP}${namespace}`;
const splitNsKey = (key: string): { cluster: string; location: string; namespace: string } => {
  const [cluster, location, namespace] = key.split(SEP);
  return { cluster: cluster ?? "", location: location ?? "", namespace: namespace ?? "" };
};

/** Map each LB backend-service name → its k8s `namespace/service` (from the
 *  backend service's GKE-populated `description`). The join key for LB metrics. */
export async function backendServiceMap(projectId: string): Promise<Map<string, { namespace: string; service: string }>> {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/compute.readonly"] });
  const client = await auth.getClient();
  const map = new Map<string, { namespace: string; service: string }>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://compute.googleapis.com/compute/v1/projects/${projectId}/aggregated/backendServices`);
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await client.request<{
      items?: Record<string, { backendServices?: { name?: string; description?: string }[] }>;
      nextPageToken?: string;
    }>({ url: url.toString() });
    for (const scope of Object.values(res.data.items ?? {})) {
      for (const bs of scope.backendServices ?? []) {
        if (!bs.name) continue;
        const svc = parseServiceName(bs.description);
        if (svc) map.set(bs.name, svc);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return map;
}

function parseServiceName(description: string | undefined): { namespace: string; service: string } | null {
  if (!description) return null;
  try {
    const j = JSON.parse(description) as Record<string, unknown>;
    const ref = j["kubernetes.io/service-name"]; // "namespace/service"
    if (typeof ref !== "string" || !ref.includes("/")) return null;
    const [namespace, service] = ref.split("/");
    return { namespace: namespace!, service: service ?? "" };
  } catch {
    return null;
  }
}

/** One grouped, reduced Monitoring query → `cluster/location/namespace → points[]`
 *  (chronological). Grouping by cluster + location keeps same-named namespaces in
 *  different clusters distinct, instead of summing them into one row. */
async function seriesByNamespace(
  metrics: MetricSource,
  metricType: string,
  resourceType: string,
  windowDays: number,
  alignmentSeconds: number,
  aligner: "ALIGN_RATE" | "ALIGN_MEAN",
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  try {
    const series = await metrics.query({
      metricType,
      resourceType,
      windowDays,
      alignmentSeconds,
      perSeriesAligner: aligner,
      crossSeriesReducer: "REDUCE_SUM",
      groupByFields: ["resource.label.cluster_name", "resource.label.location", "resource.label.namespace_name"],
    });
    for (const s of series) {
      const ns = s.labels.namespace_name;
      if (!ns) continue;
      // Monitoring returns newest-first; reverse for a chronological heatmap row.
      out.set(nsKey(s.labels.cluster_name ?? "", s.labels.location ?? "", ns), [...s.points].reverse());
    }
  } catch {
    // A missing metric (e.g. no GKE in the project) just yields an empty map.
  }
  return out;
}

/** External requests/sec per namespace, joined from LB backends. */
async function requestsByNamespace(
  metrics: MetricSource,
  backends: Map<string, { namespace: string; service: string }>,
  windowDays: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const series = await metrics.query({
      metricType: "loadbalancing.googleapis.com/https/request_count",
      resourceType: "https_lb_rule",
      windowDays,
      alignmentSeconds: 3600,
      perSeriesAligner: "ALIGN_RATE",
      crossSeriesReducer: "REDUCE_SUM",
      groupByFields: ["resource.label.backend_target_name"],
    });
    for (const s of series) {
      const backend = s.labels.backend_target_name;
      const ns = backend ? backends.get(backend)?.namespace : undefined;
      if (!ns) continue;
      out.set(ns, (out.get(ns) ?? 0) + mean(s.points));
    }
  } catch {
    // No LBs / metric off → no traffic attributed.
  }
  return out;
}

const IDLE_USED_CORES = 0.02;
const IDLE_NET_KIBS = 50;
const IDLE_REQ_PER_SEC = 0.01;

/** Full per-namespace activity report, sorted by reclaimable £/mo (desc). */
export async function namespaceReport(
  metrics: MetricSource,
  projectId: string,
  windowDays: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NamespaceActivity[]> {
  const alignmentSeconds = Math.max(3600, Math.round((windowDays * 86400) / HEATMAP_COLS));
  const backends = await backendServiceMap(projectId);
  const [reservedCores, reservedBytes, usedSeries, netIn, netOut, reqs] = await Promise.all([
    seriesByNamespace(metrics, "kubernetes.io/container/cpu/request_cores", "k8s_container", windowDays, alignmentSeconds, "ALIGN_MEAN"),
    seriesByNamespace(metrics, "kubernetes.io/container/memory/request_bytes", "k8s_container", windowDays, alignmentSeconds, "ALIGN_MEAN"),
    seriesByNamespace(metrics, "kubernetes.io/container/cpu/core_usage_time", "k8s_container", windowDays, alignmentSeconds, "ALIGN_RATE"),
    seriesByNamespace(metrics, "kubernetes.io/pod/network/received_bytes_count", "k8s_pod", windowDays, alignmentSeconds, "ALIGN_RATE"),
    seriesByNamespace(metrics, "kubernetes.io/pod/network/sent_bytes_count", "k8s_pod", windowDays, alignmentSeconds, "ALIGN_RATE"),
    requestsByNamespace(metrics, backends, windowDays),
  ]);

  // The metric maps are keyed by cluster/location/namespace; `reqs` only by
  // namespace name (LB backends carry no cluster), so it's joined separately.
  const keys = new Set<string>([...reservedCores.keys(), ...usedSeries.keys(), ...netIn.keys(), ...netOut.keys()]);
  const rates = gkeRates(env);

  const rows: NamespaceActivity[] = [];
  for (const key of keys) {
    const { cluster, location, namespace } = splitNsKey(key);
    const rCores = mean(reservedCores.get(key) ?? []);
    const rGib = mean(reservedBytes.get(key) ?? []) / BYTES_PER_GIB;
    const series = usedSeries.get(key) ?? [];
    const used = mean(series);
    const inK = mean(netIn.get(key) ?? []) / 1024;
    const outK = mean(netOut.get(key) ?? []) / 1024;
    // Can't attribute LB traffic to a specific cluster — apply it to every
    // cluster sharing the name. Conservative: it only ever suppresses an idle flag.
    const req = reqs.get(namespace) ?? 0;
    const system = isSystemNamespace(namespace);
    const addon = COMMON_ADDONS.has(namespace);
    const idle =
      !system && !addon && rCores > 0 && used < IDLE_USED_CORES && inK + outK < IDLE_NET_KIBS && req < IDLE_REQ_PER_SEC;
    rows.push({
      namespace,
      cluster,
      location,
      reservedCores: rCores,
      reservedGib: rGib,
      usedCores: used,
      utilisation: rCores > 0 ? used / rCores : null,
      netInKiBs: inK,
      netOutKiBs: outK,
      reqPerSec: req,
      reservedMonthlyGbp: priceReclaimable(rCores, rGib, rates),
      system,
      addon,
      idle,
      series,
    });
  }

  // Group by cluster, then by reclaimable £/mo within each — the order both the
  // terminal report and the console's per-cluster sections render in.
  return rows.sort((a, b) =>
    a.cluster === b.cluster ? b.reservedMonthlyGbp - a.reservedMonthlyGbp : a.cluster.localeCompare(b.cluster),
  );
}
