import { describe, it, expect } from "vitest";
import { ScanSchema } from "@feckbills/core";
import { runScan, runAwsScan, runAzureScan, totalSaving, wastePct } from "../src/scan.js";
import { FixtureComputeSource, FixtureMetricSource } from "../src/providers/gcp/fixture.js";
import { FixtureAwsResourceSource } from "../src/providers/aws/fixture.js";
import { FixtureAzureResourceSource } from "../src/providers/azure/fixture.js";
import { awsIdleInstances } from "../src/detectors/aws-idle-instances.js";
import { awsUnattachedVolumes } from "../src/detectors/aws-unattached-volumes.js";
import type { AwsDetectorContext, AwsResourceSource } from "../src/detectors/aws-types.js";

const GCP_OPTS = {
  projectId: "fixture-project",
  windowDays: 14,
  currency: "GBP" as const,
  metrics: new FixtureMetricSource(),
  compute: new FixtureComputeSource(),
};

describe("GCP scan (fixture)", () => {
  it("assembles a valid, completed scan with spend-aware GKE waste", async () => {
    const scan = await runScan(GCP_OPTS);
    expect(() => ScanSchema.parse(scan)).not.toThrow();
    expect(scan.provider).toBe("gcp");
    expect(scan.status).toBe("completed");
    expect(scan.detectorRuns).toHaveLength(6);
    expect(scan.detectorRuns.every((r) => r.ok)).toBe(true);
    // The GKE detector reports reserved spend → waste-as-% is computable.
    expect(scan.estimatedMonthlySpend).toBeGreaterThan(0);
    expect(wastePct(scan)).toBeGreaterThan(0);
  });

  it("sorts findings by saving, descending", async () => {
    const scan = await runScan(GCP_OPTS);
    const savings = scan.findings.map((f) => f.estimatedMonthlySaving);
    expect(savings).toEqual([...savings].sort((a, b) => b - a));
    expect(totalSaving(scan)).toBeCloseTo(
      savings.reduce((a, b) => a + b, 0),
      6,
    );
  });

  it("does not flag the healthy 'redis' workload", async () => {
    const scan = await runScan(GCP_OPTS);
    expect(scan.findings.some((f) => f.resourceName.includes("redis"))).toBe(false);
  });
});

describe("AWS scan (fixture)", () => {
  it("assembles a valid, completed scan across all 5 detectors", async () => {
    const scan = await runAwsScan({
      accountId: "123456789012",
      windowDays: 14,
      currency: "GBP",
      resources: new FixtureAwsResourceSource(),
    });
    expect(() => ScanSchema.parse(scan)).not.toThrow();
    expect(scan.provider).toBe("aws");
    expect(scan.projectId).toBe("123456789012");
    expect(scan.status).toBe("completed");
    expect(scan.detectorRuns).toHaveLength(5);
    expect(scan.detectorRuns.every((r) => r.ok)).toBe(true);
    // No GKE-style spend-aware detector on AWS yet → no reserved-spend figure.
    expect(scan.estimatedMonthlySpend).toBeUndefined();
  });

  it("flags the idle m5.xlarge but not the busy t3.large", async () => {
    const scan = await runAwsScan({
      accountId: "123456789012",
      windowDays: 14,
      currency: "GBP",
      resources: new FixtureAwsResourceSource(),
    });
    expect(scan.findings.some((f) => f.resourceName.includes("idle-api-1"))).toBe(true);
    expect(scan.findings.some((f) => f.resourceName.includes("web-1"))).toBe(false);
  });

  it("tags every finding with its region and an aws:// resource id", async () => {
    const scan = await runAwsScan({
      accountId: "123456789012",
      windowDays: 14,
      currency: "GBP",
      resources: new FixtureAwsResourceSource(),
    });
    for (const f of scan.findings) {
      expect(f.provider).toBe("aws");
      expect(f.region).toBe("eu-west-2");
      expect(f.resourceId.startsWith("aws-")).toBe(true);
    }
  });
});

describe("Azure scan (fixture)", () => {
  const opts = {
    subscriptionId: "00000000-0000-0000-0000-000000000000",
    windowDays: 14,
    currency: "GBP" as const,
    resources: new FixtureAzureResourceSource(),
  };

  it("assembles a valid, completed scan across all 5 detectors", async () => {
    const scan = await runAzureScan(opts);
    expect(() => ScanSchema.parse(scan)).not.toThrow();
    expect(scan.provider).toBe("azure");
    expect(scan.projectId).toBe(opts.subscriptionId);
    expect(scan.status).toBe("completed");
    expect(scan.detectorRuns).toHaveLength(5);
    expect(scan.detectorRuns.every((r) => r.ok)).toBe(true);
  });

  it("flags the idle D4s_v3 but not the busy B2s", async () => {
    const scan = await runAzureScan(opts);
    expect(scan.findings.some((f) => f.resourceName.includes("idle-api-1"))).toBe(true);
    expect(scan.findings.some((f) => f.resourceName.includes("web-1"))).toBe(false);
  });

  it("tags findings with their location and a full ARM resource id", async () => {
    const scan = await runAzureScan(opts);
    for (const f of scan.findings) {
      expect(f.provider).toBe("azure");
      expect(f.region).toBe("uksouth");
      expect(f.resourceId).toMatch(/^\/subscriptions\//);
    }
  });
});

/** Minimal context helper for unit-testing a single AWS detector. */
function awsCtx(resources: Partial<AwsResourceSource>): AwsDetectorContext {
  const stub: AwsResourceSource = {
    unattachedVolumes: async () => [],
    unassociatedAddresses: async () => [],
    snapshots: async () => [],
    stoppedInstanceVolumes: async () => [],
    runningInstances: async () => [],
    cpuPeakByInstance: async () => new Map(),
    ...resources,
  };
  return { provider: "aws", accountId: "acct", windowDays: 14, currency: "GBP", resources: stub, env: {} };
}

describe("aws.idle-instances threshold", () => {
  it("flags <5% CPU, skips ≥5%, and never guesses without metrics", async () => {
    const ctx = awsCtx({
      runningInstances: async () => [
        { id: "i-idle", name: "idle", instanceType: "m5.large", az: "eu-west-2a", region: "eu-west-2" },
        { id: "i-busy", name: "busy", instanceType: "m5.large", az: "eu-west-2a", region: "eu-west-2" },
        { id: "i-nodata", name: "nodata", instanceType: "m5.large", az: "eu-west-2a", region: "eu-west-2" },
      ],
      cpuPeakByInstance: async () =>
        new Map([
          ["i-idle", 4.9],
          ["i-busy", 5],
          // i-nodata deliberately absent → no datapoints
        ]),
    });
    const { findings } = await awsIdleInstances.run(ctx);
    const ids = findings.map((f) => f.metrics.instanceId);
    expect(ids).toContain("i-idle");
    expect(ids).not.toContain("i-busy");
    expect(ids).not.toContain("i-nodata");
  });
});

describe("aws.unattached-volumes thresholding", () => {
  it("drops sub-£0.50 volumes and assigns severity by saving", async () => {
    const ctx = awsCtx({
      unattachedVolumes: async () => [
        { id: "vol-big", name: "big", sizeGb: 1000, type: "gp3", az: "eu-west-2a", region: "eu-west-2", created: null },
        { id: "vol-tiny", name: "tiny", sizeGb: 1, type: "sc1", az: "eu-west-2a", region: "eu-west-2", created: null },
      ],
    });
    const { findings } = await awsUnattachedVolumes.run(ctx);
    expect(findings.map((f) => f.metrics.volumeId)).toEqual(["vol-big"]);
    expect(findings[0]!.severity).toBe("high");
  });
});
