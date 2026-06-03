import type {
  AwsAddress,
  AwsResourceSource,
  AwsRunningInstance,
  AwsSnapshot,
  AwsStoppedInstanceVolume,
  AwsVolume,
} from "../../detectors/aws-types.js";

const REGION = "eu-west-2";
const AZ = "eu-west-2a";

/**
 * Canned AWS resources so `--fixture --provider aws` exercises the whole AWS
 * scan → report loop with zero credentials. Models one clear case per detector,
 * plus a healthy box (high CPU) that must NOT be flagged idle.
 */
export class FixtureAwsResourceSource implements AwsResourceSource {
  async unattachedVolumes(): Promise<AwsVolume[]> {
    return [
      { id: "vol-0aa1", name: "data-old", sizeGb: 500, type: "gp3", az: AZ, region: REGION, created: "2026-03-01T00:00:00Z" },
      { id: "vol-0bb2", name: null, sizeGb: 100, type: "gp2", az: AZ, region: REGION, created: "2026-04-10T00:00:00Z" },
    ];
  }

  async unassociatedAddresses(): Promise<AwsAddress[]> {
    return [{ allocationId: "eipalloc-01", publicIp: "52.0.0.1", name: "legacy-nat-eip", region: REGION }];
  }

  async snapshots(): Promise<AwsSnapshot[]> {
    return [
      { id: "snap-0del", name: "db-deleted-vol", sizeGb: 500, ageDays: 240, orphaned: true, region: REGION },
      { id: "snap-0bak", name: "weekly-backup", sizeGb: 100, ageDays: 120, orphaned: false, region: REGION },
    ];
  }

  async stoppedInstanceVolumes(): Promise<AwsStoppedInstanceVolume[]> {
    return [
      { instanceId: "i-0stopped", instanceName: "old-worker", volumeId: "vol-0root", sizeGb: 80, type: "gp3", root: true, az: AZ, region: REGION },
    ];
  }

  async runningInstances(): Promise<AwsRunningInstance[]> {
    return [
      { id: "i-0idle", name: "idle-api-1", instanceType: "m5.xlarge", az: AZ, region: REGION },
      { id: "i-0busy", name: "web-1", instanceType: "t3.large", az: AZ, region: REGION },
    ];
  }

  async cpuPeakByInstance(): Promise<Map<string, number>> {
    // i-0idle peaked at 3%; i-0busy is healthy at 64% (must not be flagged).
    return new Map([
      ["i-0idle", 3],
      ["i-0busy", 64],
    ]);
  }
}
