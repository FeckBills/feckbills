import type { Currency, Finding, Provider } from "@feckbills/core";
import type { GroupedSeries, TimeSeriesQuery } from "../providers/gcp/monitoring.js";

/**
 * The only thing a detector needs to pull metrics. Both the live
 * `MonitoringClient` and the fixture source implement it, so detectors run
 * identically against real GCP and against canned data (`--fixture`).
 */
export interface MetricSource {
  query(q: TimeSeriesQuery): Promise<GroupedSeries[]>;
}

export interface UnattachedDisk {
  id: string;
  name: string;
  sizeGb: number;
  /** pd-balanced | pd-ssd | pd-standard | … */
  type: string;
  zone: string;
  region: string;
  /** ISO timestamp the disk was last detached, if known. */
  lastDetach: string | null;
  created: string | null;
}

export interface IdleAddress {
  id: string;
  name: string;
  address: string;
  region: string;
  addressType: string;
  created: string | null;
}

export interface SnapshotInfo {
  id: string;
  name: string;
  /** Source-disk size (GiB). */
  sizeGb: number;
  /** Actual stored bytes (GiB) — what you're billed for; falls back to sizeGb. */
  storageGb: number;
  ageDays: number | null;
  /** True when the disk this snapshot was taken from no longer exists. */
  orphaned: boolean;
}

export interface StoppedVmDisk {
  instanceName: string;
  zone: string;
  region: string;
  diskName: string;
  sizeGb: number;
  diskType: string;
  boot: boolean;
}

export interface RunningInstance {
  id: string;
  name: string;
  zone: string;
  region: string;
  machineType: string;
}

/**
 * Compute Engine reads a detector needs. Both the live `GcpComputeClient` and
 * the fixture implement it, so detectors run identically against real GCP and
 * canned data.
 */
export interface ComputeSource {
  unattachedDisks(): Promise<UnattachedDisk[]>;
  idleAddresses(): Promise<IdleAddress[]>;
  snapshots(): Promise<SnapshotInfo[]>;
  stoppedInstanceDisks(): Promise<StoppedVmDisk[]>;
  runningInstances(): Promise<RunningInstance[]>;
}

export interface DetectorContext {
  provider: Provider;
  projectId: string;
  windowDays: number;
  currency: Currency;
  metrics: MetricSource;
  compute: ComputeSource;
  env: NodeJS.ProcessEnv;
}

export interface DetectorResult {
  findings: Finding[];
  /**
   * Optional: monthly spend this detector can account for, derived from metrics
   * (e.g. total GKE compute reserved). Summed across detectors into the scan's
   * `estimatedMonthlySpend` so the console can show waste-as-%.
   */
  estimatedMonthlySpend?: number;
}

/**
 * A detector, generic over the context shape it consumes. GCP detectors use the
 * default (GCP-shaped) `DetectorContext`; AWS detectors specialise to
 * `AwsDetectorContext` (see `aws-types.ts`). The scan assembler is generic over
 * the same `Ctx`, so each provider's detectors are type-checked against the
 * sources they actually receive.
 */
export interface Detector<Ctx = DetectorContext> {
  id: string;
  provider: Provider;
  /** Short human title for the report and logs. */
  title: string;
  run(ctx: Ctx): Promise<DetectorResult>;
}
