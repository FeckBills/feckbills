import { ComputeManagementClient, type Disk, type VirtualMachine } from "@azure/arm-compute";
import { NetworkManagementClient } from "@azure/arm-network";
import { MonitorClient } from "@azure/arm-monitor";
import type { DefaultAzureCredential } from "@azure/identity";
import type {
  AzureDisk,
  AzureIp,
  AzureResourceSource,
  AzureSnapshot,
  AzureVm,
  AzureVmDisk,
} from "../../detectors/azure-types.js";
import { peakCpuByVm } from "./monitor.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

function daysSince(date: Date | undefined): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function rgFromId(id: string | undefined): string | null {
  const m = (id ?? "").match(/resourceGroups\/([^/]+)/i);
  return m ? m[1]! : null;
}

/** "…/PowerState/deallocated" → "deallocated". */
function powerStateOf(statuses: { code?: string }[] | undefined): string | null {
  const s = (statuses ?? []).find((x) => x.code?.startsWith("PowerState/"));
  return s?.code ? s.code.split("/")[1]! : null;
}

/**
 * Read-only Azure client over ARM Compute/Network/Monitor for a single
 * subscription. Disks and VMs are listed once and cached because they each feed
 * multiple detectors; VM power state comes from a per-VM instance-view read.
 * Uses DefaultAzureCredential (az login / env SP / managed identity) — Reader
 * role is enough.
 */
export class AzureResourceClient implements AzureResourceSource {
  private readonly compute: ComputeManagementClient;
  private readonly network: NetworkManagementClient;
  private readonly monitor: MonitorClient;

  private disksPromise: Promise<Disk[]> | null = null;
  private vmsPromise: Promise<VirtualMachine[]> | null = null;
  private powerPromise: Promise<Map<string, string | null>> | null = null;

  constructor(credential: DefaultAzureCredential, subscriptionId: string) {
    this.compute = new ComputeManagementClient(credential, subscriptionId);
    this.network = new NetworkManagementClient(credential, subscriptionId);
    this.monitor = new MonitorClient(credential, subscriptionId);
  }

  private rawDisks(): Promise<Disk[]> {
    this.disksPromise ??= collect(this.compute.disks.list());
    return this.disksPromise;
  }

  private rawVms(): Promise<VirtualMachine[]> {
    this.vmsPromise ??= collect(this.compute.virtualMachines.listAll());
    return this.vmsPromise;
  }

  /** ARM id → power state ("running" | "deallocated" | "stopped" | …). */
  private powerStates(): Promise<Map<string, string | null>> {
    this.powerPromise ??= (async () => {
      const vms = await this.rawVms();
      const out = new Map<string, string | null>();
      await Promise.all(
        vms.map(async (vm) => {
          const rg = rgFromId(vm.id);
          if (!vm.id || !rg || !vm.name) return;
          try {
            const view = await this.compute.virtualMachines.instanceView(rg, vm.name);
            out.set(vm.id, powerStateOf(view.statuses));
          } catch {
            out.set(vm.id, null);
          }
        }),
      );
      return out;
    })();
    return this.powerPromise;
  }

  async unattachedDisks(): Promise<AzureDisk[]> {
    const disks = await this.rawDisks();
    return disks
      .filter((d) => d.diskState === "Unattached")
      .map((d) => ({
        id: d.id ?? "",
        name: d.name ?? "(unnamed)",
        sizeGb: d.diskSizeGB ?? 0,
        sku: d.sku?.name ?? "unknown",
        location: d.location ?? "",
        created: d.timeCreated ? d.timeCreated.toISOString() : null,
      }));
  }

  async idleIps(): Promise<AzureIp[]> {
    const ips = await collect(this.network.publicIPAddresses.listAll());
    return ips
      .filter((ip) => !ip.ipConfiguration)
      .map((ip) => ({
        id: ip.id ?? "",
        name: ip.name ?? "(unnamed)",
        ipAddress: ip.ipAddress ?? null,
        sku: ip.sku?.name ?? "Basic",
        location: ip.location ?? "",
      }));
  }

  async snapshots(): Promise<AzureSnapshot[]> {
    const [snaps, disks] = await Promise.all([collect(this.compute.snapshots.list()), this.rawDisks()]);
    const liveDiskIds = new Set(disks.map((d) => d.id?.toLowerCase()).filter(Boolean) as string[]);
    return snaps.map((s) => {
      const source = s.creationData?.sourceResourceId;
      return {
        id: s.id ?? "",
        name: s.name ?? "(unnamed)",
        sizeGb: s.diskSizeGB ?? 0,
        ageDays: daysSince(s.timeCreated),
        orphaned: source ? !liveDiskIds.has(source.toLowerCase()) : false,
        location: s.location ?? "",
      };
    });
  }

  async deallocatedVmDisks(): Promise<AzureVmDisk[]> {
    const [vms, disks, power] = await Promise.all([this.rawVms(), this.rawDisks(), this.powerStates()]);
    const byId = new Map(disks.filter((d) => d.id).map((d) => [d.id!.toLowerCase(), d]));
    const out: AzureVmDisk[] = [];
    for (const vm of vms) {
      const state = vm.id ? power.get(vm.id) : null;
      if (state === "running" || state == null) continue; // only stopped/deallocated
      const vmName = vm.name ?? "(unnamed)";
      const osId = vm.storageProfile?.osDisk?.managedDisk?.id;
      const dataIds = (vm.storageProfile?.dataDisks ?? []).map((d) => d.managedDisk?.id);
      const attached: { id: string; os: boolean }[] = [
        ...(osId ? [{ id: osId, os: true }] : []),
        ...dataIds.filter(Boolean).map((id) => ({ id: id as string, os: false })),
      ];
      for (const att of attached) {
        const d = byId.get(att.id.toLowerCase());
        if (!d) continue;
        out.push({
          vmName,
          diskId: d.id ?? att.id,
          diskName: d.name ?? "(unnamed)",
          sizeGb: d.diskSizeGB ?? 0,
          sku: d.sku?.name ?? "unknown",
          os: att.os,
          location: d.location ?? vm.location ?? "",
        });
      }
    }
    return out;
  }

  async runningVms(): Promise<AzureVm[]> {
    const [vms, power] = await Promise.all([this.rawVms(), this.powerStates()]);
    return vms
      .filter((vm) => vm.id && power.get(vm.id) === "running")
      .map((vm) => ({
        id: vm.id ?? "",
        name: vm.name ?? "(unnamed)",
        vmSize: vm.hardwareProfile?.vmSize ?? "unknown",
        location: vm.location ?? "",
      }));
  }

  async cpuPeakByVm(vms: { id: string }[], windowDays: number): Promise<Map<string, number>> {
    return peakCpuByVm(this.monitor, vms.map((v) => v.id), windowDays);
  }
}
