import { describe, it, expect } from "vitest";
import { USD_TO_GBP, usdToGbp, formatMoney, formatMonthly } from "@feckbills/core";
import {
  ebsMonthlyGbp,
  eipMonthlyGbp,
  snapshotMonthlyGbp as awsSnapshotMonthlyGbp,
  awsComputeRates,
  instanceSpecs,
  priceReclaimable as awsPriceReclaimable,
} from "../src/pricing/aws-resources.js";
import {
  diskMonthlyGbp,
  idleIpMonthlyGbp,
  snapshotMonthlyGbp as gcpSnapshotMonthlyGbp,
} from "../src/pricing/gcp-resources.js";
import { gkeRates, priceReclaimable as gkePriceReclaimable } from "../src/pricing/gke.js";
import { machineSpecs } from "../src/detectors/gcp-idle-instances.js";

const HOURS = 730;

describe("money", () => {
  it("converts USD→GBP at the fixed rate", () => {
    expect(usdToGbp(100)).toBeCloseTo(100 * USD_TO_GBP, 10);
  });
  it("formats whole pounds and the /mo unit", () => {
    expect(formatMoney(1240.4)).toBe("£1,240");
    expect(formatMonthly(67)).toBe("£67/mo");
  });
});

describe("AWS pricing", () => {
  it("prices EBS per GiB by volume type, with a gp2-tier fallback", () => {
    expect(ebsMonthlyGbp(100, "gp3")).toBeCloseTo(usdToGbp(100 * 0.08), 10);
    expect(ebsMonthlyGbp(100, "io1")).toBeCloseTo(usdToGbp(100 * 0.125), 10);
    expect(ebsMonthlyGbp(100, "mystery")).toBeCloseTo(usdToGbp(100 * 0.1), 10);
  });

  it("prices an unassociated public IPv4 at ~$0.005/hr", () => {
    expect(eipMonthlyGbp()).toBeCloseTo(usdToGbp(0.005 * HOURS), 10);
  });

  it("prices snapshot storage per source GiB", () => {
    expect(awsSnapshotMonthlyGbp(200)).toBeCloseTo(usdToGbp(200 * 0.05), 10);
  });

  it("maps instance types to approximate vCPU/GiB", () => {
    expect(instanceSpecs("t3.medium")).toEqual({ vcpu: 2, gib: 4 });
    expect(instanceSpecs("m5.large")).toEqual({ vcpu: 2, gib: 8 });
    expect(instanceSpecs("m5.xlarge")).toEqual({ vcpu: 4, gib: 16 });
    expect(instanceSpecs("m5.2xlarge")).toEqual({ vcpu: 8, gib: 32 });
    expect(instanceSpecs("c5.4xlarge")).toEqual({ vcpu: 16, gib: 64 });
    expect(instanceSpecs("weird")).toEqual({ vcpu: 2, gib: 8 }); // unknown → assume a large
  });

  it("derives monthly compute rates and honours env overrides", () => {
    const base = awsComputeRates({});
    expect(base.vcpuMonthlyGbp).toBeCloseTo(usdToGbp(0.023 * HOURS), 10);
    expect(base.source).toMatch(/m5/);

    const overridden = awsComputeRates({ FECKBILLS_AWS_VCPU_USD_HR: "0.05", FECKBILLS_AWS_GB_USD_HR: "0.01" });
    expect(overridden.vcpuMonthlyGbp).toBeCloseTo(usdToGbp(0.05 * HOURS), 10);
    expect(overridden.source).toMatch(/override/);
  });

  it("prices reclaimable vCPU + memory and never goes negative", () => {
    const rates = awsComputeRates({});
    expect(awsPriceReclaimable(4, 16, rates)).toBeCloseTo(
      4 * rates.vcpuMonthlyGbp + 16 * rates.gbMonthlyGbp,
      10,
    );
    expect(awsPriceReclaimable(-5, -5, rates)).toBe(0);
  });
});

describe("GCP pricing", () => {
  it("prices persistent disks by type with a balanced fallback", () => {
    expect(diskMonthlyGbp(100, "pd-ssd")).toBeCloseTo(usdToGbp(100 * 0.187), 10);
    expect(diskMonthlyGbp(100, "mystery")).toBeCloseTo(usdToGbp(100 * 0.1), 10);
  });

  it("prices an idle static IP and snapshot storage", () => {
    expect(idleIpMonthlyGbp()).toBeCloseTo(usdToGbp(0.01 * HOURS), 10);
    expect(gcpSnapshotMonthlyGbp(140)).toBeCloseTo(usdToGbp(140 * 0.026), 10);
  });

  it("derives GKE rates with env overrides", () => {
    const base = gkeRates({});
    expect(base.vcpuMonthlyGbp).toBeGreaterThan(0);
    const over = gkeRates({ FECKBILLS_GKE_VCPU_USD_HR: "0.1" });
    expect(over.source).toMatch(/override/);
    expect(gkePriceReclaimable(2, 4, base)).toBeGreaterThan(0);
  });

  it("approximates GCE machine specs", () => {
    expect(machineSpecs("e2-standard-4")).toEqual({ vcpu: 4, gib: 16 });
    expect(machineSpecs("e2-highmem-2")).toEqual({ vcpu: 2, gib: 16 });
    expect(machineSpecs("e2-medium")).toEqual({ vcpu: 2, gib: 4 });
  });
});
