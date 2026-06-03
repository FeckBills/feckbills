import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Shared mock state for the AWS SDK. Tests mutate it, then construct a client;
 * the mocked command classes read from it when `send()` is called.
 */
const state = vi.hoisted(() => ({
  volumes: [] as any[],
  addresses: [] as any[],
  snapshots: [] as any[],
  reservations: [] as any[],
  metricResults: [] as any[],
}));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    constructor(_cfg: unknown) {}
    async send(cmd: { run: () => unknown }) {
      return cmd.run();
    }
  }
  class DescribeVolumesCommand {
    run() {
      return { Volumes: state.volumes, NextToken: undefined };
    }
  }
  class DescribeAddressesCommand {
    run() {
      return { Addresses: state.addresses };
    }
  }
  class DescribeSnapshotsCommand {
    run() {
      return { Snapshots: state.snapshots, NextToken: undefined };
    }
  }
  class DescribeInstancesCommand {
    run() {
      return { Reservations: state.reservations, NextToken: undefined };
    }
  }
  class DescribeRegionsCommand {
    run() {
      return { Regions: [] };
    }
  }
  return {
    EC2Client,
    DescribeVolumesCommand,
    DescribeAddressesCommand,
    DescribeSnapshotsCommand,
    DescribeInstancesCommand,
    DescribeRegionsCommand,
  };
});

vi.mock("@aws-sdk/client-cloudwatch", () => {
  class CloudWatchClient {
    constructor(_cfg: unknown) {}
    async send(cmd: { run: () => unknown }) {
      return cmd.run();
    }
  }
  class GetMetricDataCommand {
    run() {
      return { MetricDataResults: state.metricResults, NextToken: undefined };
    }
  }
  return { CloudWatchClient, GetMetricDataCommand };
});

// Import AFTER the mocks are registered.
const { AwsResourceClient } = await import("../src/providers/aws/ec2.js");

beforeEach(() => {
  state.volumes = [];
  state.addresses = [];
  state.snapshots = [];
  state.reservations = [];
  state.metricResults = [];
});

function client() {
  return new AwsResourceClient(["eu-west-2"]);
}

describe("AwsResourceClient mapping", () => {
  it("returns only 'available' volumes, with the Name tag and region", async () => {
    state.volumes = [
      {
        VolumeId: "vol-1",
        State: "available",
        Size: 100,
        VolumeType: "gp3",
        AvailabilityZone: "eu-west-2a",
        CreateTime: new Date("2026-03-01T00:00:00Z"),
        Tags: [{ Key: "Name", Value: "data" }],
      },
      { VolumeId: "vol-2", State: "in-use", Size: 50, VolumeType: "gp2", AvailabilityZone: "eu-west-2b" },
    ];
    const out = await client().unattachedVolumes();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "vol-1", name: "data", sizeGb: 100, type: "gp3", region: "eu-west-2" });
    expect(out[0]!.created).toBe("2026-03-01T00:00:00.000Z");
  });

  it("returns only unassociated Elastic IPs", async () => {
    state.addresses = [
      { AllocationId: "eip-1", PublicIp: "1.2.3.4" },
      { AllocationId: "eip-2", PublicIp: "5.6.7.8", AssociationId: "assoc-1", InstanceId: "i-1" },
    ];
    const out = await client().unassociatedAddresses();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ allocationId: "eip-1", publicIp: "1.2.3.4", region: "eu-west-2" });
  });

  it("marks a snapshot orphaned when its source volume is gone", async () => {
    state.volumes = [{ VolumeId: "vol-live", State: "in-use" }];
    state.snapshots = [
      { SnapshotId: "snap-orphan", VolumeId: "vol-deleted", VolumeSize: 100, StartTime: new Date("2025-01-01T00:00:00Z") },
      { SnapshotId: "snap-ok", VolumeId: "vol-live", VolumeSize: 50, StartTime: new Date() },
    ];
    const out = await client().snapshots();
    const orphan = out.find((s) => s.id === "snap-orphan")!;
    const ok = out.find((s) => s.id === "snap-ok")!;
    expect(orphan.orphaned).toBe(true);
    expect(ok.orphaned).toBe(false);
    expect(orphan.ageDays).toBeGreaterThan(300);
  });

  it("links volumes on stopped instances and flags the root device", async () => {
    state.volumes = [{ VolumeId: "vol-root", State: "in-use", Size: 80, VolumeType: "gp3" }];
    state.reservations = [
      {
        Instances: [
          {
            InstanceId: "i-stopped",
            State: { Name: "stopped" },
            InstanceType: "m5.large",
            Placement: { AvailabilityZone: "eu-west-2a" },
            RootDeviceName: "/dev/sda1",
            BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-root" } }],
            Tags: [{ Key: "Name", Value: "old-box" }],
          },
          { InstanceId: "i-running", State: { Name: "running" }, InstanceType: "t3.large", Placement: { AvailabilityZone: "eu-west-2a" } },
        ],
      },
    ];
    const stopped = await client().stoppedInstanceVolumes();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ instanceName: "old-box", volumeId: "vol-root", sizeGb: 80, root: true, region: "eu-west-2" });

    const running = await client().runningInstances();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ id: "i-running", instanceType: "t3.large", region: "eu-west-2" });
  });

  it("takes the peak CPU per instance and omits those with no datapoints", async () => {
    state.metricResults = [
      { Id: "m0", Values: [2, 8, 5] },
      { Id: "m1", Values: [] },
    ];
    const peaks = await client().cpuPeakByInstance(
      [
        { id: "i-a", region: "eu-west-2" },
        { id: "i-b", region: "eu-west-2" },
      ],
      14,
    );
    expect(peaks.get("i-a")).toBe(8);
    expect(peaks.has("i-b")).toBe(false);
  });
});
