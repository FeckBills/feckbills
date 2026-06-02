import { GoogleAuth } from "google-auth-library";
import type {
  ComputeSource,
  IdleAddress,
  RunningInstance,
  SnapshotInfo,
  StoppedVmDisk,
  UnattachedDisk,
} from "../../detectors/types.js";

const BASE = "https://compute.googleapis.com/compute/v1";

/** Last path segment of a GCP self-link / type URL ("…/pd-balanced" → "pd-balanced"). */
function basename(url: string | undefined): string {
  if (!url) return "";
  const clean = url.split("?")[0]!;
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** "europe-west2-a" → "europe-west2". */
function regionOfZone(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

interface RawDisk {
  id?: string;
  name?: string;
  sizeGb?: string;
  type?: string;
  zone?: string;
  selfLink?: string;
  users?: string[];
  lastDetachTimestamp?: string;
  creationTimestamp?: string;
}

interface RawAddress {
  id?: string;
  name?: string;
  address?: string;
  status?: string;
  region?: string;
  addressType?: string;
  users?: string[];
}

interface RawSnapshot {
  id?: string;
  name?: string;
  diskSizeGb?: string;
  storageBytes?: string;
  sourceDisk?: string;
  creationTimestamp?: string;
}

interface RawInstance {
  id?: string;
  name?: string;
  zone?: string;
  status?: string;
  machineType?: string;
  disks?: { source?: string; boot?: boolean }[];
}

interface AggregatedList<T> {
  items?: Record<string, Record<string, T[] | undefined>>;
  nextPageToken?: string;
}

interface FlatList<T> {
  items?: T[];
  nextPageToken?: string;
}

const BYTES_PER_GIB = 1024 ** 3;

/**
 * Read-only Compute Engine client over the REST list endpoints. Uses ADC
 * (compute.readonly scope). REST-thin rather than the heavy generated client.
 */
export class GcpComputeClient implements ComputeSource {
  private readonly auth: GoogleAuth;

  constructor(private readonly projectId: string) {
    this.auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/compute.readonly"] });
  }

  private async aggregated<T>(path: string, key: string): Promise<T[]> {
    const client = await this.auth.getClient();
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${BASE}/projects/${this.projectId}/aggregated/${path}`);
      url.searchParams.set("maxResults", "500");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await client.request<AggregatedList<T>>({ url: url.toString() });
      for (const scope of Object.values(res.data.items ?? {})) {
        const arr = scope[key];
        if (arr) out.push(...arr);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async global<T>(path: string): Promise<T[]> {
    const client = await this.auth.getClient();
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${BASE}/projects/${this.projectId}/global/${path}`);
      url.searchParams.set("maxResults", "500");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await client.request<FlatList<T>>({ url: url.toString() });
      if (res.data.items) out.push(...res.data.items);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return out;
  }

  private rawDisksPromise: Promise<RawDisk[]> | null = null;
  private rawDisks(): Promise<RawDisk[]> {
    // Cached — disks feed three detectors (unattached, snapshots, stopped-VM).
    this.rawDisksPromise ??= this.aggregated<RawDisk>("disks", "disks");
    return this.rawDisksPromise;
  }

  private rawInstancesPromise: Promise<RawInstance[]> | null = null;
  private rawInstances(): Promise<RawInstance[]> {
    // Cached — instances feed both stopped-VM-disks and idle-instances.
    this.rawInstancesPromise ??= this.aggregated<RawInstance>("instances", "instances");
    return this.rawInstancesPromise;
  }

  async runningInstances(): Promise<RunningInstance[]> {
    const instances = await this.rawInstances();
    return instances
      .filter((i) => i.status === "RUNNING")
      .map((i) => {
        const zone = basename(i.zone);
        return {
          id: i.id ?? "",
          name: i.name ?? "(unnamed)",
          zone,
          region: regionOfZone(zone),
          machineType: basename(i.machineType) || "unknown",
        };
      });
  }

  async unattachedDisks(): Promise<UnattachedDisk[]> {
    const disks = await this.rawDisks();
    return disks
      .filter((d) => !d.users || d.users.length === 0)
      .map((d) => {
        const zone = basename(d.zone);
        return {
          id: d.id ?? d.name ?? "",
          name: d.name ?? "(unnamed)",
          sizeGb: Number(d.sizeGb ?? 0),
          type: basename(d.type) || "unknown",
          zone,
          region: regionOfZone(zone),
          lastDetach: d.lastDetachTimestamp ?? null,
          created: d.creationTimestamp ?? null,
        };
      });
  }

  async idleAddresses(): Promise<IdleAddress[]> {
    const addresses = await this.aggregated<RawAddress>("addresses", "addresses");
    return addresses
      .filter((a) => a.status === "RESERVED" && (!a.users || a.users.length === 0))
      .map((a) => ({
        id: a.id ?? a.name ?? "",
        name: a.name ?? "(unnamed)",
        address: a.address ?? "",
        region: a.region ? basename(a.region) : "global",
        addressType: a.addressType ?? "EXTERNAL",
        created: null,
      }));
  }

  async snapshots(): Promise<SnapshotInfo[]> {
    const [snaps, disks] = await Promise.all([this.global<RawSnapshot>("snapshots"), this.rawDisks()]);
    const liveDiskLinks = new Set(disks.map((d) => d.selfLink).filter(Boolean) as string[]);
    return snaps.map((s) => {
      const sizeGb = Number(s.diskSizeGb ?? 0);
      const storageGb = s.storageBytes ? Number(s.storageBytes) / BYTES_PER_GIB : sizeGb;
      return {
        id: s.id ?? s.name ?? "",
        name: s.name ?? "(unnamed)",
        sizeGb,
        storageGb,
        ageDays: daysSince(s.creationTimestamp),
        // Orphaned = the disk it was taken from no longer exists.
        orphaned: s.sourceDisk ? !liveDiskLinks.has(s.sourceDisk) : false,
      };
    });
  }

  async stoppedInstanceDisks(): Promise<StoppedVmDisk[]> {
    const [instances, disks] = await Promise.all([this.rawInstances(), this.rawDisks()]);
    const byLink = new Map(disks.filter((d) => d.selfLink).map((d) => [d.selfLink!, d]));
    const out: StoppedVmDisk[] = [];
    for (const inst of instances) {
      if (inst.status !== "TERMINATED") continue;
      const zone = basename(inst.zone);
      for (const att of inst.disks ?? []) {
        const d = att.source ? byLink.get(att.source) : undefined;
        if (!d) continue;
        out.push({
          instanceName: inst.name ?? "(unnamed)",
          zone,
          region: regionOfZone(zone),
          diskName: d.name ?? "(unnamed)",
          sizeGb: Number(d.sizeGb ?? 0),
          diskType: basename(d.type) || "unknown",
          boot: Boolean(att.boot),
        });
      }
    }
    return out;
  }
}
