import {
  EC2Client,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeSnapshotsCommand,
  DescribeInstancesCommand,
  type Volume,
  type Instance,
  type Snapshot,
} from "@aws-sdk/client-ec2";
import type {
  AwsAddress,
  AwsResourceSource,
  AwsRunningInstance,
  AwsSnapshot,
  AwsStoppedInstanceVolume,
  AwsVolume,
} from "../../detectors/aws-types.js";
import { peakCpuByInstance } from "./cloudwatch.js";

function nameTag(tags: { Key?: string; Value?: string }[] | undefined): string | null {
  return tags?.find((t) => t.Key === "Name")?.Value ?? null;
}

function daysSince(date: Date | undefined): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Read-only EC2 + EBS client over the AWS SDK v3 `Describe*` calls. Spans every
 * region it's constructed with; per-region reads are cached because volumes and
 * instances each feed multiple detectors. Uses the default credential chain
 * (env / shared config / IMDS) — read scopes only.
 */
export class AwsResourceClient implements AwsResourceSource {
  private readonly clients = new Map<string, EC2Client>();
  private readonly volumesByRegion = new Map<string, Promise<Volume[]>>();
  private readonly instancesByRegion = new Map<string, Promise<Instance[]>>();

  constructor(private readonly regions: string[]) {}

  private client(region: string): EC2Client {
    let c = this.clients.get(region);
    if (!c) {
      c = new EC2Client({ region });
      this.clients.set(region, c);
    }
    return c;
  }

  private rawVolumes(region: string): Promise<Volume[]> {
    let p = this.volumesByRegion.get(region);
    if (!p) {
      p = this.paginate(async (NextToken) => {
        const res = await this.client(region).send(new DescribeVolumesCommand({ NextToken, MaxResults: 500 }));
        return { items: res.Volumes ?? [], next: res.NextToken };
      });
      this.volumesByRegion.set(region, p);
    }
    return p;
  }

  private rawInstances(region: string): Promise<Instance[]> {
    let p = this.instancesByRegion.get(region);
    if (!p) {
      p = this.paginate(async (NextToken) => {
        const res = await this.client(region).send(new DescribeInstancesCommand({ NextToken, MaxResults: 500 }));
        const items = (res.Reservations ?? []).flatMap((r) => r.Instances ?? []);
        return { items, next: res.NextToken };
      });
      this.instancesByRegion.set(region, p);
    }
    return p;
  }

  private async paginate<T>(
    page: (token: string | undefined) => Promise<{ items: T[]; next: string | undefined }>,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      const { items, next } = await page(token);
      out.push(...items);
      token = next;
    } while (token);
    return out;
  }

  /** Run a per-region producer across all regions and flatten the results. */
  private async acrossRegions<T>(fn: (region: string) => Promise<T[]>): Promise<T[]> {
    const perRegion = await Promise.all(this.regions.map(fn));
    return perRegion.flat();
  }

  async unattachedVolumes(): Promise<AwsVolume[]> {
    return this.acrossRegions(async (region) => {
      const volumes = await this.rawVolumes(region);
      return volumes
        .filter((v) => v.State === "available")
        .map((v) => ({
          id: v.VolumeId ?? "",
          name: nameTag(v.Tags),
          sizeGb: v.Size ?? 0,
          type: v.VolumeType ?? "unknown",
          az: v.AvailabilityZone ?? "",
          region,
          created: v.CreateTime ? v.CreateTime.toISOString() : null,
        }));
    });
  }

  async unassociatedAddresses(): Promise<AwsAddress[]> {
    return this.acrossRegions(async (region) => {
      const res = await this.client(region).send(new DescribeAddressesCommand({}));
      return (res.Addresses ?? [])
        .filter((a) => !a.AssociationId && !a.InstanceId && !a.NetworkInterfaceId)
        .map((a) => ({
          allocationId: a.AllocationId ?? a.PublicIp ?? "",
          publicIp: a.PublicIp ?? "",
          name: nameTag(a.Tags),
          region,
        }));
    });
  }

  async snapshots(): Promise<AwsSnapshot[]> {
    return this.acrossRegions(async (region) => {
      const [snaps, volumes] = await Promise.all([
        this.paginate<Snapshot>(async (NextToken) => {
          const res = await this.client(region).send(
            new DescribeSnapshotsCommand({ OwnerIds: ["self"], NextToken, MaxResults: 500 }),
          );
          return { items: res.Snapshots ?? [], next: res.NextToken };
        }),
        this.rawVolumes(region),
      ]);
      const liveVolumeIds = new Set(volumes.map((v) => v.VolumeId).filter(Boolean) as string[]);
      return snaps.map((s) => ({
        id: s.SnapshotId ?? "",
        name: nameTag(s.Tags),
        sizeGb: s.VolumeSize ?? 0,
        ageDays: daysSince(s.StartTime),
        // Orphaned = the volume it was taken from no longer exists.
        orphaned: s.VolumeId ? !liveVolumeIds.has(s.VolumeId) : false,
        region,
      }));
    });
  }

  async stoppedInstanceVolumes(): Promise<AwsStoppedInstanceVolume[]> {
    return this.acrossRegions(async (region) => {
      const [instances, volumes] = await Promise.all([this.rawInstances(region), this.rawVolumes(region)]);
      const byId = new Map(volumes.filter((v) => v.VolumeId).map((v) => [v.VolumeId!, v]));
      const out: AwsStoppedInstanceVolume[] = [];
      for (const inst of instances) {
        if (inst.State?.Name !== "stopped") continue;
        const instanceName = nameTag(inst.Tags) ?? inst.InstanceId ?? "(unnamed)";
        for (const bdm of inst.BlockDeviceMappings ?? []) {
          const volId = bdm.Ebs?.VolumeId;
          const v = volId ? byId.get(volId) : undefined;
          if (!v) continue;
          out.push({
            instanceId: inst.InstanceId ?? "",
            instanceName,
            volumeId: v.VolumeId ?? "",
            sizeGb: v.Size ?? 0,
            type: v.VolumeType ?? "unknown",
            root: bdm.DeviceName === inst.RootDeviceName,
            az: inst.Placement?.AvailabilityZone ?? v.AvailabilityZone ?? "",
            region,
          });
        }
      }
      return out;
    });
  }

  async runningInstances(): Promise<AwsRunningInstance[]> {
    return this.acrossRegions(async (region) => {
      const instances = await this.rawInstances(region);
      return instances
        .filter((i) => i.State?.Name === "running")
        .map((i) => ({
          id: i.InstanceId ?? "",
          name: nameTag(i.Tags),
          instanceType: i.InstanceType ?? "unknown",
          az: i.Placement?.AvailabilityZone ?? "",
          region,
        }));
    });
  }

  async cpuPeakByInstance(
    instances: { id: string; region: string }[],
    windowDays: number,
  ): Promise<Map<string, number>> {
    const byRegion = new Map<string, string[]>();
    for (const i of instances) {
      const list = byRegion.get(i.region) ?? [];
      list.push(i.id);
      byRegion.set(i.region, list);
    }
    const peaks = new Map<string, number>();
    await Promise.all(
      [...byRegion.entries()].map(async ([region, ids]) => {
        const regionPeaks = await peakCpuByInstance(region, ids, windowDays);
        for (const [id, peak] of regionPeaks) peaks.set(id, peak);
      }),
    );
    return peaks;
  }
}
