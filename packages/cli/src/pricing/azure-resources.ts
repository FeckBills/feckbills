import { usdToGbp } from "@feckbills/core";

/**
 * Azure list prices for the orphaned/idle detectors. USD (East US ballpark),
 * converted to GBP. Estimates — labelled as such in the report. Compute rates
 * are overridable via env for other regions/families.
 */

const HOURS_PER_MONTH = 730;

/** Managed-disk $/GB-month by SKU (approx; Azure bills by provisioned tier). */
const DISK_USD_PER_GB_MONTH: Record<string, number> = {
  Standard_LRS: 0.045, // HDD
  StandardSSD_LRS: 0.075,
  StandardSSD_ZRS: 0.094,
  Premium_LRS: 0.135,
  Premium_ZRS: 0.17,
  UltraSSD_LRS: 0.12,
};
const DISK_USD_DEFAULT = 0.075; // assume StandardSSD if unknown

/** A static Standard public IP: ~$0.005/hr × 730. */
const IDLE_IP_USD_MONTH = 0.005 * HOURS_PER_MONTH;

/** Snapshot storage ~$0.05/GB-month (LRS). */
const SNAPSHOT_USD_PER_GB_MONTH = 0.05;

export function diskMonthlyGbp(sizeGb: number, sku: string): number {
  const usdPerGb = DISK_USD_PER_GB_MONTH[sku] ?? DISK_USD_DEFAULT;
  return usdToGbp(sizeGb * usdPerGb);
}

export function ipMonthlyGbp(): number {
  return usdToGbp(IDLE_IP_USD_MONTH);
}

export function snapshotMonthlyGbp(sizeGb: number): number {
  return usdToGbp(sizeGb * SNAPSHOT_USD_PER_GB_MONTH);
}

export const PRICING_NOTE = "Azure list prices (East US ballpark), USD→GBP — an estimate.";

/**
 * Per-resource monthly compute rates for pricing idle VM capacity, mirroring
 * the GKE/EC2 approach. Defaults are a rough D-series (general-purpose) split of
 * on-demand list price. Override via FECKBILLS_AZURE_VCPU_USD_HR /
 * FECKBILLS_AZURE_GB_USD_HR.
 */
export interface AzureComputeRates {
  vcpuMonthlyGbp: number;
  gbMonthlyGbp: number;
  source: string;
}

const DEFAULT_VCPU_USD_HR = 0.024;
const DEFAULT_GB_USD_HR = 0.006;

export function azureComputeRates(env: NodeJS.ProcessEnv = process.env): AzureComputeRates {
  const vcpuUsdHr = numberFromEnv(env.FECKBILLS_AZURE_VCPU_USD_HR) ?? DEFAULT_VCPU_USD_HR;
  const gbUsdHr = numberFromEnv(env.FECKBILLS_AZURE_GB_USD_HR) ?? DEFAULT_GB_USD_HR;
  const overridden = vcpuUsdHr !== DEFAULT_VCPU_USD_HR || gbUsdHr !== DEFAULT_GB_USD_HR;

  return {
    vcpuMonthlyGbp: usdToGbp(vcpuUsdHr * HOURS_PER_MONTH),
    gbMonthlyGbp: usdToGbp(gbUsdHr * HOURS_PER_MONTH),
    source: overridden
      ? "env override (FECKBILLS_AZURE_*)"
      : "Azure D-series general-purpose on-demand list price (East US), USD→GBP @ fixed rate",
  };
}

/** Monthly £ for a quantity of reclaimable vCPU-cores and GiB of memory. */
export function priceReclaimable(vcpu: number, gib: number, rates: AzureComputeRates): number {
  return Math.max(0, vcpu) * rates.vcpuMonthlyGbp + Math.max(0, gib) * rates.gbMonthlyGbp;
}

/**
 * Approximate vCPU + memory (GiB) for a VM size. The vCPU count is the first
 * integer in the size name (e.g. Standard_D2s_v3 → 2); memory defaults to the
 * D-series ratio of ~4 GiB per vCPU. A few common sizes are pinned for accuracy.
 * Estimate only — used to size the idle-VM saving, never quoted as exact.
 */
export function vmSpecs(vmSize: string): { vcpu: number; gib: number } {
  const fixed: Record<string, [number, number]> = {
    Standard_B1s: [1, 1],
    Standard_B2s: [2, 4],
    Standard_B2ms: [2, 8],
    Standard_D2s_v3: [2, 8],
    Standard_D4s_v3: [4, 16],
    Standard_E2s_v3: [2, 16],
    Standard_F2s_v2: [2, 4],
  };
  if (fixed[vmSize]) return { vcpu: fixed[vmSize]![0], gib: fixed[vmSize]![1] };

  const bare = vmSize.replace(/^Standard_/, "");
  const m = bare.match(/[A-Za-z]+(\d+)/);
  const vcpu = m ? Number(m[1]) : 2;
  return { vcpu, gib: vcpu * 4 };
}

function numberFromEnv(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
