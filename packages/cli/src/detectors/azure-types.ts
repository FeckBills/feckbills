import type { Currency, Provider } from "@feckbills/core";

/**
 * Azure resource reads a detector needs. Both the live `AzureResourceClient`
 * (ARM Compute/Network/Monitor) and the fixture implement it, so Azure
 * detectors run identically against a real subscription and canned data
 * (`--fixture`).
 *
 * The shapes mirror the GCP/AWS source concepts one-to-one — unattached block
 * storage, unassociated public IPs, snapshots, storage on stopped compute, and
 * running compute — in Azure terms (managed disks, public IP addresses,
 * snapshots, deallocated VMs). Each item carries its full ARM resource id so
 * fixes can use `az ... --ids <id>`.
 */

/** An unattached managed disk (diskState "Unattached"). */
export interface AzureDisk {
  id: string;
  name: string;
  sizeGb: number;
  /** Standard_LRS | StandardSSD_LRS | Premium_LRS | UltraSSD_LRS | … */
  sku: string;
  location: string;
  created: string | null;
}

/** A public IP address not associated with any resource. */
export interface AzureIp {
  id: string;
  name: string;
  ipAddress: string | null;
  /** Basic | Standard */
  sku: string;
  location: string;
}

export interface AzureSnapshot {
  id: string;
  name: string;
  sizeGb: number;
  ageDays: number | null;
  /** True when the disk this snapshot was taken from no longer exists. */
  orphaned: boolean;
  location: string;
}

/** A managed disk still attached to a deallocated/stopped VM. */
export interface AzureVmDisk {
  vmName: string;
  diskId: string;
  diskName: string;
  sizeGb: number;
  sku: string;
  /** True for the OS disk. */
  os: boolean;
  location: string;
}

export interface AzureVm {
  id: string;
  name: string;
  /** e.g. Standard_D2s_v3 */
  vmSize: string;
  location: string;
}

export interface AzureResourceSource {
  unattachedDisks(): Promise<AzureDisk[]>;
  idleIps(): Promise<AzureIp[]>;
  snapshots(): Promise<AzureSnapshot[]>;
  deallocatedVmDisks(): Promise<AzureVmDisk[]>;
  runningVms(): Promise<AzureVm[]>;
  /**
   * Peak "Percentage CPU" over the window for each VM, keyed by ARM id. VMs with
   * no datapoints are omitted (no data ≠ idle).
   */
  cpuPeakByVm(vms: { id: string }[], windowDays: number): Promise<Map<string, number>>;
}

export interface AzureDetectorContext {
  provider: Provider;
  /** Azure subscription id. */
  subscriptionId: string;
  windowDays: number;
  currency: Currency;
  resources: AzureResourceSource;
  env: NodeJS.ProcessEnv;
}
