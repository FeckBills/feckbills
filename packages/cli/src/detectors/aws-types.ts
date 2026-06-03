import type { Currency, Provider } from "@feckbills/core";

/**
 * AWS resource reads a detector needs. Both the live `AwsResourceClient`
 * (EC2 + CloudWatch) and the fixture implement it, so AWS detectors run
 * identically against a real account and against canned data (`--fixture`).
 *
 * The shapes mirror the GCP `ComputeSource` concepts one-to-one — unattached
 * block storage, unassociated public IPs, snapshots, storage on stopped
 * compute, and running compute — but in AWS terms (EBS volumes, Elastic IPs,
 * EBS snapshots, stopped EC2, running EC2). Each item carries its own region,
 * because one AWS scan can span many regions.
 */

/** An unattached EBS volume (status "available"). */
export interface AwsVolume {
  id: string;
  /** Name tag, if any. */
  name: string | null;
  sizeGb: number;
  /** gp3 | gp2 | io1 | io2 | st1 | sc1 | standard */
  type: string;
  az: string;
  region: string;
  created: string | null;
}

/** An Elastic IP allocated but not associated with anything. */
export interface AwsAddress {
  allocationId: string;
  publicIp: string;
  /** Name tag, if any. */
  name: string | null;
  region: string;
}

export interface AwsSnapshot {
  id: string;
  /** Name tag, if any. */
  name: string | null;
  /** Source-volume size (GiB) — what EBS snapshots are billed on (full-volume list price). */
  sizeGb: number;
  ageDays: number | null;
  /** True when the volume this snapshot was taken from no longer exists. */
  orphaned: boolean;
  region: string;
}

/** An EBS volume still attached to a stopped EC2 instance. */
export interface AwsStoppedInstanceVolume {
  instanceId: string;
  instanceName: string;
  volumeId: string;
  sizeGb: number;
  type: string;
  /** True for the instance's root volume. */
  root: boolean;
  az: string;
  region: string;
}

export interface AwsRunningInstance {
  id: string;
  name: string | null;
  /** e.g. t3.large, m5.xlarge */
  instanceType: string;
  az: string;
  region: string;
}

export interface AwsResourceSource {
  unattachedVolumes(): Promise<AwsVolume[]>;
  unassociatedAddresses(): Promise<AwsAddress[]>;
  snapshots(): Promise<AwsSnapshot[]>;
  stoppedInstanceVolumes(): Promise<AwsStoppedInstanceVolume[]>;
  runningInstances(): Promise<AwsRunningInstance[]>;
  /**
   * Peak CPU utilisation (%) over the window for each instance, keyed by
   * instance id. Instances with no datapoints are omitted (no data ≠ idle).
   */
  cpuPeakByInstance(
    instances: { id: string; region: string }[],
    windowDays: number,
  ): Promise<Map<string, number>>;
}

export interface AwsDetectorContext {
  provider: Provider;
  /** AWS account id. */
  accountId: string;
  windowDays: number;
  currency: Currency;
  resources: AwsResourceSource;
  env: NodeJS.ProcessEnv;
}
