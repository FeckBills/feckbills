import type { Currency, DetectorRun, Finding, Scan } from "@feckbills/core";
import { ScanSchema } from "@feckbills/core";
import { detectorsFor } from "./detectors/registry.js";
import type { ComputeSource, DetectorContext, MetricSource } from "./detectors/types.js";

export const AGENT_VERSION = "0.0.0";

export interface ScanOptions {
  projectId: string;
  windowDays: number;
  currency: Currency;
  metrics: MetricSource;
  compute: ComputeSource;
  env?: NodeJS.ProcessEnv;
  /** Called as each detector finishes, for live CLI progress. */
  onDetector?: (run: DetectorRun) => void;
}

/**
 * Run every GCP detector against the given metric source and assemble a
 * validated Scan. Detector failures are isolated — one blowing up downgrades
 * the scan to "partial" and is reported honestly, rather than killing the run.
 */
export async function runScan(opts: ScanOptions): Promise<Scan> {
  const startedAt = new Date().toISOString();
  const detectors = detectorsFor("gcp");
  const findings: Finding[] = [];
  const detectorRuns: DetectorRun[] = [];
  let estimatedMonthlySpend = 0;

  for (const detector of detectors) {
    const ctx: DetectorContext = {
      provider: "gcp",
      projectId: opts.projectId,
      windowDays: opts.windowDays,
      currency: opts.currency,
      metrics: opts.metrics,
      compute: opts.compute,
      env: opts.env ?? process.env,
    };

    const t0 = Date.now();
    try {
      const result = await detector.run(ctx);
      findings.push(...result.findings);
      if (result.estimatedMonthlySpend != null) {
        estimatedMonthlySpend += result.estimatedMonthlySpend;
      }
      const run: DetectorRun = {
        detectorId: detector.id,
        ok: true,
        findingsCount: result.findings.length,
        durationMs: Date.now() - t0,
      };
      detectorRuns.push(run);
      opts.onDetector?.(run);
    } catch (err) {
      const run: DetectorRun = {
        detectorId: detector.id,
        ok: false,
        findingsCount: 0,
        durationMs: Date.now() - t0,
        error: (err as Error).message,
      };
      detectorRuns.push(run);
      opts.onDetector?.(run);
    }
  }

  const anyFailed = detectorRuns.some((r) => !r.ok);
  const allFailed = detectorRuns.length > 0 && detectorRuns.every((r) => !r.ok);

  const scan: Scan = {
    provider: "gcp",
    projectId: opts.projectId,
    agentVersion: AGENT_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: allFailed ? "failed" : anyFailed ? "partial" : "completed",
    windowDays: opts.windowDays,
    estimatedMonthlySpend: estimatedMonthlySpend > 0 ? estimatedMonthlySpend : undefined,
    detectorRuns,
    findings: findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving),
  };

  // Validate our own output — catches detector contract drift early.
  return ScanSchema.parse(scan);
}

export function totalSaving(scan: Scan): number {
  return scan.findings.reduce((sum, f) => sum + f.estimatedMonthlySaving, 0);
}

/**
 * Over-provisioning waste as a % of estimated reserved compute. Like-for-like:
 * the numerator is only the reclaimable slice of the *reservation*
 * (over-provisioned findings), not orphaned disks/IPs — those aren't part of
 * the compute reservation the denominator measures.
 */
export function wastePct(scan: Scan): number | null {
  if (!scan.estimatedMonthlySpend || scan.estimatedMonthlySpend <= 0) return null;
  const overProvisioned = scan.findings
    .filter((f) => f.category === "over-provisioned")
    .reduce((sum, f) => sum + f.estimatedMonthlySaving, 0);
  return (overProvisioned / scan.estimatedMonthlySpend) * 100;
}
