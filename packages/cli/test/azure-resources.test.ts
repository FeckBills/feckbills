import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  disks: [] as any[],
  vms: [] as any[],
  snapshots: [] as any[],
  ips: [] as any[],
  power: {} as Record<string, string>,
  metricMax: undefined as number | undefined,
}));

async function* gen<T>(arr: T[]) {
  for (const x of arr) yield x;
}

vi.mock("@azure/arm-compute", () => {
  class ComputeManagementClient {
    constructor(_c: unknown, _s: unknown) {}
    disks = { list: () => gen(state.disks) };
    snapshots = { list: () => gen(state.snapshots) };
    virtualMachines = {
      listAll: () => gen(state.vms),
      instanceView: async (_rg: string, name: string) => {
        const code = state.power[name];
        return { statuses: code ? [{ code: `PowerState/${code}` }] : [] };
      },
    };
  }
  return { ComputeManagementClient };
});

vi.mock("@azure/arm-network", () => {
  class NetworkManagementClient {
    constructor(_c: unknown, _s: unknown) {}
    publicIPAddresses = { listAll: () => gen(state.ips) };
  }
  return { NetworkManagementClient };
});

vi.mock("@azure/arm-monitor", () => {
  class MonitorClient {
    constructor(_c: unknown, _s: unknown) {}
    metrics = {
      list: async () => ({
        value: state.metricMax == null ? [] : [{ timeseries: [{ data: [{ maximum: state.metricMax }] }] }],
      }),
    };
  }
  return { MonitorClient };
});

const { AzureResourceClient } = await import("../src/providers/azure/resources.js");

const SUB = "/subscriptions/sub-1";
const RG = `${SUB}/resourceGroups/rg/providers/Microsoft.Compute`;

beforeEach(() => {
  state.disks = [];
  state.vms = [];
  state.snapshots = [];
  state.ips = [];
  state.power = {};
  state.metricMax = undefined;
});

function client() {
  return new AzureResourceClient({} as any, "sub-1");
}

describe("AzureResourceClient mapping", () => {
  it("returns only 'Unattached' disks with sku, size and created", async () => {
    state.disks = [
      { id: `${RG}/disks/d1`, name: "d1", diskState: "Unattached", diskSizeGB: 512, sku: { name: "Premium_LRS" }, location: "uksouth", timeCreated: new Date("2026-03-01T00:00:00Z") },
      { id: `${RG}/disks/d2`, name: "d2", diskState: "Attached", diskSizeGB: 128, sku: { name: "StandardSSD_LRS" }, location: "uksouth" },
    ];
    const out = await client().unattachedDisks();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "d1", sizeGb: 512, sku: "Premium_LRS", location: "uksouth" });
    expect(out[0]!.created).toBe("2026-03-01T00:00:00.000Z");
  });

  it("returns only public IPs with no ipConfiguration", async () => {
    state.ips = [
      { id: `${RG}/publicIPAddresses/ip1`, name: "ip1", ipAddress: "20.0.0.1", sku: { name: "Standard" }, location: "uksouth" },
      { id: `${RG}/publicIPAddresses/ip2`, name: "ip2", ipConfiguration: { id: "nic" }, sku: { name: "Standard" } },
    ];
    const out = await client().idleIps();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "ip1", ipAddress: "20.0.0.1", sku: "Standard" });
  });

  it("marks a snapshot orphaned when its source disk is gone (case-insensitive)", async () => {
    state.disks = [{ id: `${RG}/disks/Live`, diskState: "Attached" }];
    state.snapshots = [
      { id: `${RG}/snapshots/s-orphan`, name: "s-orphan", diskSizeGB: 512, timeCreated: new Date("2025-01-01T00:00:00Z"), creationData: { sourceResourceId: `${RG}/disks/gone` } },
      { id: `${RG}/snapshots/s-ok`, name: "s-ok", diskSizeGB: 128, timeCreated: new Date(), creationData: { sourceResourceId: `${RG}/disks/live` } },
    ];
    const out = await client().snapshots();
    expect(out.find((s) => s.name === "s-orphan")!.orphaned).toBe(true);
    expect(out.find((s) => s.name === "s-ok")!.orphaned).toBe(false);
  });

  it("links disks on deallocated VMs and excludes running ones", async () => {
    state.disks = [{ id: `${RG}/disks/vm1_os`, name: "vm1_os", diskSizeGB: 127, sku: { name: "Premium_LRS" }, diskState: "Attached" }];
    state.vms = [
      {
        id: `${RG}/virtualMachines/vm1`,
        name: "vm1",
        location: "uksouth",
        hardwareProfile: { vmSize: "Standard_D2s_v3" },
        storageProfile: { osDisk: { managedDisk: { id: `${RG}/disks/vm1_os` } }, dataDisks: [] },
      },
      {
        id: `${RG}/virtualMachines/vm2`,
        name: "vm2",
        location: "uksouth",
        hardwareProfile: { vmSize: "Standard_B2s" },
        storageProfile: { osDisk: { managedDisk: { id: `${RG}/disks/none` } } },
      },
    ];
    state.power = { vm1: "deallocated", vm2: "running" };

    const deallocated = await client().deallocatedVmDisks();
    expect(deallocated).toHaveLength(1);
    expect(deallocated[0]).toMatchObject({ vmName: "vm1", diskName: "vm1_os", sizeGb: 127, os: true, location: "uksouth" });

    const running = await client().runningVms();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ name: "vm2", vmSize: "Standard_B2s" });
  });

  it("reads the peak CPU and omits VMs with no datapoints", async () => {
    state.metricMax = 7;
    const withData = await client().cpuPeakByVm([{ id: "vm-a" }], 14);
    expect(withData.get("vm-a")).toBe(7);

    state.metricMax = undefined;
    const noData = await client().cpuPeakByVm([{ id: "vm-b" }], 14);
    expect(noData.has("vm-b")).toBe(false);
  });
});
