import type { GroupedSeries, TimeSeriesQuery } from "./monitoring.js";
import type {
  ComputeSource,
  IdleAddress,
  MetricSource,
  RunningInstance,
  SnapshotInfo,
  StoppedVmDisk,
  UnattachedDisk,
} from "../../detectors/types.js";

const BYTES_PER_GIB = 1024 ** 3;

/**
 * Canned k8s_container time-series so the whole scan → report loop runs green
 * with zero credentials (`--fixture`). Models three workloads:
 *   - prod-batch:   wildly over-provisioned (the headline finding)
 *   - api-server:   mildly over-provisioned
 *   - cache:        healthy (must NOT be flagged — guards against false positives)
 *
 * Returns flat-ish series; the detector's aligners/reducers are a no-op here
 * because we pre-aggregate to one series per workload, exactly as REDUCE_SUM
 * over the group-by fields would.
 */
const WORKLOADS = [
  { ns: "batch", container: "prod-batch", reqCpu: 4, useCpu: 0.15, reqGib: 8, useGib: 0.6 },
  { ns: "api", container: "api-server", reqCpu: 2, useCpu: 1.0, reqGib: 4, useGib: 1.4 },
  { ns: "cache", container: "redis", reqCpu: 1, useCpu: 0.85, reqGib: 2, useGib: 1.8 },
];

const CLUSTER = "acme-prod";
const LOCATION = "europe-west2";

function series(value: number, points = 60): number[] {
  // Slight jitter so percentile maths exercises real spread, deterministic
  // (index-based, no Math.random — keeps fixtures reproducible).
  return Array.from({ length: points }, (_, i) => value * (0.9 + 0.2 * ((i % 10) / 9)));
}

function labelsFor(w: (typeof WORKLOADS)[number]): Record<string, string> {
  return {
    cluster_name: CLUSTER,
    location: LOCATION,
    namespace_name: w.ns,
    container_name: w.container,
  };
}

export class FixtureMetricSource implements MetricSource {
  async query(q: TimeSeriesQuery): Promise<GroupedSeries[]> {
    const pick = (sel: (w: (typeof WORKLOADS)[number]) => number): GroupedSeries[] =>
      WORKLOADS.map((w) => ({ labels: labelsFor(w), points: series(sel(w)) }));

    if (q.metricType.endsWith("/cpu/request_cores")) return pick((w) => w.reqCpu);
    if (q.metricType.endsWith("/cpu/core_usage_time")) return pick((w) => w.useCpu);
    if (q.metricType.endsWith("/memory/request_bytes")) return pick((w) => w.reqGib * BYTES_PER_GIB);
    if (q.metricType.endsWith("/memory/used_bytes")) return pick((w) => w.useGib * BYTES_PER_GIB);
    // Idle VM CPU utilisation (fraction) for the idle-instances detector.
    if (q.metricType.endsWith("instance/cpu/utilization")) {
      return [{ labels: { instance_id: "111" }, points: series(0.02) }];
    }
    return [];
  }
}

/** Canned Compute resources so `--fixture` exercises the orphaned-resource detectors too. */
export class FixtureComputeSource implements ComputeSource {
  async unattachedDisks(): Promise<UnattachedDisk[]> {
    return [
      { id: "1", name: "data-old", sizeGb: 200, type: "pd-ssd", zone: "europe-west2-a", region: "europe-west2", lastDetach: "2026-04-20T00:00:00Z", created: null },
      { id: "2", name: "pvc-demo-1234", sizeGb: 100, type: "pd-balanced", zone: "europe-west2-b", region: "europe-west2", lastDetach: null, created: "2026-03-01T00:00:00Z" },
    ];
  }

  async idleAddresses(): Promise<IdleAddress[]> {
    return [
      { id: "3", name: "legacy-lb-ip", address: "34.0.0.1", region: "europe-west2", addressType: "EXTERNAL", created: null },
    ];
  }

  async snapshots(): Promise<SnapshotInfo[]> {
    return [
      { id: "s1", name: "snap-deleted-db", sizeGb: 200, storageGb: 140, ageDays: 220, orphaned: true },
      { id: "s2", name: "weekly-backup", sizeGb: 100, storageGb: 60, ageDays: 120, orphaned: false },
    ];
  }

  async stoppedInstanceDisks(): Promise<StoppedVmDisk[]> {
    return [
      { instanceName: "old-worker", zone: "europe-west2-a", region: "europe-west2", diskName: "old-worker-boot", sizeGb: 50, diskType: "pd-ssd", boot: true },
    ];
  }

  async runningInstances(): Promise<RunningInstance[]> {
    return [
      { id: "111", name: "idle-vm-1", zone: "europe-west2-a", region: "europe-west2", machineType: "e2-standard-4" },
    ];
  }
}
