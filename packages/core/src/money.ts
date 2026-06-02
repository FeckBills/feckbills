import type { Currency } from "./schema.js";

const SYMBOLS: Record<Currency, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
};

/** "£312", "£1,240" — whole pounds for headline figures. */
export function formatMoney(amount: number, currency: Currency = "GBP"): string {
  const rounded = Math.round(amount);
  return `${SYMBOLS[currency]}${rounded.toLocaleString("en-GB")}`;
}

/** "£312/mo" — the unit we quote everything in (CLAUDE.md §3). */
export function formatMonthly(amount: number, currency: Currency = "GBP"): string {
  return `${formatMoney(amount, currency)}/mo`;
}

/**
 * USD→target conversion for pricing data that only comes in USD (cloud price
 * lists). v0 uses a fixed rate; v1 should pull a live FX rate at scan time and
 * store it on the Scan. Deliberately conservative — better to under-promise the
 * saving than over-claim it.
 */
export const USD_TO_GBP = 0.79;

export function usdToGbp(usd: number): number {
  return usd * USD_TO_GBP;
}
