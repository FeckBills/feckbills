import { usdToGbp } from "@feckbills/core";

/**
 * Storage + IP rates for the orphaned-resource detectors. USD list prices
 * (europe-west2 ballpark), converted to GBP. Estimates — labelled as such in
 * the report. Override the disk rates via env for other regions if needed.
 */

const DISK_USD_PER_GB_MONTH: Record<string, number> = {
  "pd-standard": 0.044,
  "pd-balanced": 0.1,
  "pd-ssd": 0.187,
  "pd-extreme": 0.125,
  "hyperdisk-balanced": 0.1,
};
const DISK_USD_DEFAULT = 0.1; // assume balanced-tier if unknown

/** Reserved-but-unused static external IP: ~$0.010/hr × 730h. */
const IDLE_IP_USD_MONTH = 0.01 * 730;

/** Snapshot storage ~$0.026/GB-month. */
const SNAPSHOT_USD_PER_GB_MONTH = 0.026;

export function diskMonthlyGbp(sizeGb: number, type: string): number {
  const usdPerGb = DISK_USD_PER_GB_MONTH[type] ?? DISK_USD_DEFAULT;
  return usdToGbp(sizeGb * usdPerGb);
}

export function idleIpMonthlyGbp(): number {
  return usdToGbp(IDLE_IP_USD_MONTH);
}

export function snapshotMonthlyGbp(storageGb: number): number {
  return usdToGbp(storageGb * SNAPSHOT_USD_PER_GB_MONTH);
}

export const PRICING_NOTE = "GCP list prices (europe-west2 ballpark), USD→GBP — an estimate.";
