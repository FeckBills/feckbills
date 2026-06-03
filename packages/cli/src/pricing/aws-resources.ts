import { usdToGbp } from "@feckbills/core";

/**
 * AWS list prices for the orphaned/idle detectors. USD (us-east-1 ballpark),
 * converted to GBP. Estimates — labelled as such in the report. Compute rates
 * are overridable via env for other regions/families until the live pricing
 * pull lands.
 */

const HOURS_PER_MONTH = 730; // 365 * 24 / 12, the cloud-billing convention

/** EBS storage $/GB-month by volume type. */
const EBS_USD_PER_GB_MONTH: Record<string, number> = {
  gp3: 0.08,
  gp2: 0.1,
  io1: 0.125,
  io2: 0.125,
  st1: 0.045,
  sc1: 0.015,
  standard: 0.05, // magnetic (legacy)
};
const EBS_USD_DEFAULT = 0.1; // assume gp2-tier if unknown

/** A public IPv4 address that isn't doing work: $0.005/hr × 730. */
const IDLE_IP_USD_MONTH = 0.005 * HOURS_PER_MONTH;

/** EBS snapshot storage ~$0.05/GB-month. */
const SNAPSHOT_USD_PER_GB_MONTH = 0.05;

export function ebsMonthlyGbp(sizeGb: number, type: string): number {
  const usdPerGb = EBS_USD_PER_GB_MONTH[type] ?? EBS_USD_DEFAULT;
  return usdToGbp(sizeGb * usdPerGb);
}

export function eipMonthlyGbp(): number {
  return usdToGbp(IDLE_IP_USD_MONTH);
}

export function snapshotMonthlyGbp(sizeGb: number): number {
  return usdToGbp(sizeGb * SNAPSHOT_USD_PER_GB_MONTH);
}

export const PRICING_NOTE = "AWS list prices (us-east-1 ballpark), USD→GBP — an estimate.";

/**
 * Per-resource monthly compute rates for pricing idle EC2 capacity, mirroring
 * the GKE approach: price the reclaimable vCPU + memory of an idle box. Defaults
 * are a rough general-purpose (m5-family) split of on-demand list price.
 * Override via FECKBILLS_AWS_VCPU_USD_HR / FECKBILLS_AWS_GB_USD_HR.
 */
export interface AwsComputeRates {
  vcpuMonthlyGbp: number;
  gbMonthlyGbp: number;
  source: string;
}

const DEFAULT_VCPU_USD_HR = 0.023;
const DEFAULT_GB_USD_HR = 0.0058;

export function awsComputeRates(env: NodeJS.ProcessEnv = process.env): AwsComputeRates {
  const vcpuUsdHr = numberFromEnv(env.FECKBILLS_AWS_VCPU_USD_HR) ?? DEFAULT_VCPU_USD_HR;
  const gbUsdHr = numberFromEnv(env.FECKBILLS_AWS_GB_USD_HR) ?? DEFAULT_GB_USD_HR;
  const overridden = vcpuUsdHr !== DEFAULT_VCPU_USD_HR || gbUsdHr !== DEFAULT_GB_USD_HR;

  return {
    vcpuMonthlyGbp: usdToGbp(vcpuUsdHr * HOURS_PER_MONTH),
    gbMonthlyGbp: usdToGbp(gbUsdHr * HOURS_PER_MONTH),
    source: overridden
      ? "env override (FECKBILLS_AWS_*)"
      : "AWS m5 general-purpose on-demand list price (us-east-1), USD→GBP @ fixed rate",
  };
}

/** Monthly £ for a quantity of reclaimable vCPU-cores and GiB of memory. */
export function priceReclaimable(vcpu: number, gib: number, rates: AwsComputeRates): number {
  return Math.max(0, vcpu) * rates.vcpuMonthlyGbp + Math.max(0, gib) * rates.gbMonthlyGbp;
}

/**
 * Approximate vCPU + memory (GiB) for an EC2 instance type. Built around the
 * general-purpose size ladder (t3/m-family, ~4 GiB per vCPU). Estimate only —
 * used to size the idle-instance saving, never quoted as exact.
 */
export function instanceSpecs(instanceType: string): { vcpu: number; gib: number } {
  const size = instanceType.includes(".") ? instanceType.split(".")[1]! : instanceType;

  const fixed: Record<string, [number, number]> = {
    nano: [2, 0.5],
    micro: [2, 1],
    small: [2, 2],
    medium: [2, 4],
    large: [2, 8],
    xlarge: [4, 16],
  };
  if (fixed[size]) return { vcpu: fixed[size]![0], gib: fixed[size]![1] };

  // "Nxlarge" → N × the xlarge unit (4 vCPU / 16 GiB).
  const m = size.match(/^(\d+)xlarge$/);
  if (m) {
    const n = Number(m[1]);
    return { vcpu: n * 4, gib: n * 16 };
  }

  return { vcpu: 2, gib: 8 }; // unknown → assume a large
}

function numberFromEnv(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
