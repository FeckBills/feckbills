import { usdToGbp } from "@feckbills/core";

const HOURS_PER_MONTH = 730; // 365 * 24 / 12, the cloud-billing convention

/**
 * Per-resource monthly rates for reclaimable GKE capacity.
 *
 * Defaults are GCP on-demand component prices for the **e2 predefined** family
 * (us-central1, USD list): $0.021811 / vCPU-hour and $0.002923 / GB-hour. We
 * price over-provisioned requests as "capacity you're paying for but not using"
 * — i.e. what you'd save by packing the same workloads onto fewer/smaller
 * nodes. It's an estimate, and we say so in the report.
 *
 * Override via FECKBILLS_GKE_VCPU_USD_HR / FECKBILLS_GKE_GB_USD_HR for other
 * regions or machine families until the live pricing pull lands (v0.5).
 */
export interface GkeRates {
  vcpuMonthlyGbp: number;
  gbMonthlyGbp: number;
  source: string;
}

const DEFAULT_VCPU_USD_HR = 0.021811;
const DEFAULT_GB_USD_HR = 0.002923;

export function gkeRates(env: NodeJS.ProcessEnv = process.env): GkeRates {
  const vcpuUsdHr = numberFromEnv(env.FECKBILLS_GKE_VCPU_USD_HR) ?? DEFAULT_VCPU_USD_HR;
  const gbUsdHr = numberFromEnv(env.FECKBILLS_GKE_GB_USD_HR) ?? DEFAULT_GB_USD_HR;
  const overridden =
    vcpuUsdHr !== DEFAULT_VCPU_USD_HR || gbUsdHr !== DEFAULT_GB_USD_HR;

  return {
    vcpuMonthlyGbp: usdToGbp(vcpuUsdHr * HOURS_PER_MONTH),
    gbMonthlyGbp: usdToGbp(gbUsdHr * HOURS_PER_MONTH),
    source: overridden
      ? "env override (FECKBILLS_GKE_*)"
      : "GCP e2 predefined on-demand list price (us-central1), USD→GBP @ fixed rate",
  };
}

/** Monthly £ for a quantity of reclaimable vCPU-cores and GiB of memory. */
export function priceReclaimable(
  wasteCores: number,
  wasteGib: number,
  rates: GkeRates,
): number {
  return Math.max(0, wasteCores) * rates.vcpuMonthlyGbp + Math.max(0, wasteGib) * rates.gbMonthlyGbp;
}

function numberFromEnv(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
