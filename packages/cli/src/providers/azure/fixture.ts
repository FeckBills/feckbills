import type {
  AzureDisk,
  AzureIp,
  AzureResourceSource,
  AzureSnapshot,
  AzureVm,
  AzureVmDisk,
} from "../../detectors/azure-types.js";

const LOC = "uksouth";
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000";
const RG = `${SUB}/resourceGroups/acme-prod/providers`;

/**
 * Canned Azure resources so `--fixture --provider azure` exercises the whole
 * Azure scan → report loop with zero credentials. One clear case per detector,
 * plus a healthy VM (high CPU) that must NOT be flagged idle.
 */
export class FixtureAzureResourceSource implements AzureResourceSource {
  async unattachedDisks(): Promise<AzureDisk[]> {
    return [
      { id: `${RG}/Microsoft.Compute/disks/data-old`, name: "data-old", sizeGb: 512, sku: "Premium_LRS", location: LOC, created: "2026-03-01T00:00:00Z" },
      { id: `${RG}/Microsoft.Compute/disks/scratch`, name: "scratch", sizeGb: 128, sku: "StandardSSD_LRS", location: LOC, created: "2026-04-10T00:00:00Z" },
    ];
  }

  async idleIps(): Promise<AzureIp[]> {
    return [{ id: `${RG}/Microsoft.Network/publicIPAddresses/legacy-lb-ip`, name: "legacy-lb-ip", ipAddress: "20.0.0.1", sku: "Standard", location: LOC }];
  }

  async snapshots(): Promise<AzureSnapshot[]> {
    return [
      { id: `${RG}/Microsoft.Compute/snapshots/db-deleted`, name: "db-deleted", sizeGb: 512, ageDays: 240, orphaned: true, location: LOC },
      { id: `${RG}/Microsoft.Compute/snapshots/weekly-backup`, name: "weekly-backup", sizeGb: 128, ageDays: 120, orphaned: false, location: LOC },
    ];
  }

  async deallocatedVmDisks(): Promise<AzureVmDisk[]> {
    return [
      { vmName: "old-worker", diskId: `${RG}/Microsoft.Compute/disks/old-worker_osdisk`, diskName: "old-worker_osdisk", sizeGb: 127, sku: "Premium_LRS", os: true, location: LOC },
    ];
  }

  async runningVms(): Promise<AzureVm[]> {
    return [
      { id: `${RG}/Microsoft.Compute/virtualMachines/idle-api-1`, name: "idle-api-1", vmSize: "Standard_D4s_v3", location: LOC },
      { id: `${RG}/Microsoft.Compute/virtualMachines/web-1`, name: "web-1", vmSize: "Standard_B2s", location: LOC },
    ];
  }

  async cpuPeakByVm(): Promise<Map<string, number>> {
    return new Map([
      [`${RG}/Microsoft.Compute/virtualMachines/idle-api-1`, 3],
      [`${RG}/Microsoft.Compute/virtualMachines/web-1`, 58],
    ]);
  }
}
