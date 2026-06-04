import type { Currency, DetectorRun, Finding, NamespaceActivity, Provider, Scan } from "@feckbills/core";
import { ScanSchema } from "@feckbills/core";
import { detectorsFor, awsDetectors, azureDetectors } from "./detectors/registry.js";
import type { ComputeSource, Detector, DetectorContext, MetricSource } from "./detectors/types.js";
import type { AwsDetectorContext, AwsResourceSource } from "./detectors/aws-types.js";
import type { AzureDetectorContext, AzureResourceSource } from "./detectors/azure-types.js";

export const AGENT_VERSION = "0.3.0";

interface AssembleOptions<Ctx> {
  provider: Provider;
  /** The scan unit: a GCP project id, or an AWS account id. */
  projectId: string;
  windowDays: number;
  detectors: Detector<Ctx>[];
  context: Ctx;
  /** Optional GKE namespace activity to attach (GCP only). */
  namespaceActivity?: NamespaceActivity[];
  /** Called as each detector finishes, for live CLI progress. */
  onDetector?: (run: DetectorRun) => void;
}

/**
 * Run a provider's detectors against a ready context and assemble a validated
 * Scan. Provider-agnostic: it knows nothing about GCP or AWS, only the
 * `Detector<Ctx>` contract. Detector failures are isolated — one blowing up
 * downgrades the scan to "partial" and is reported honestly, rather than
 * killing the run.
 */
async function assembleScan<Ctx>(opts: AssembleOptions<Ctx>): Promise<Scan> {
  const startedAt = new Date().toISOString();
  const findings: Finding[] = [];
  const detectorRuns: DetectorRun[] = [];
  let estimatedMonthlySpend = 0;

  for (const detector of opts.detectors) {
    const t0 = Date.now();
    try {
      const result = await detector.run(opts.context);
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
    provider: opts.provider,
    projectId: opts.projectId,
    agentVersion: AGENT_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: allFailed ? "failed" : anyFailed ? "partial" : "completed",
    windowDays: opts.windowDays,
    estimatedMonthlySpend: estimatedMonthlySpend > 0 ? estimatedMonthlySpend : undefined,
    detectorRuns,
    findings: findings.sort((a, b) => b.estimatedMonthlySaving - a.estimatedMonthlySaving),
    namespaceActivity: opts.namespaceActivity,
  };

  // Validate our own output — catches detector contract drift early.
  return ScanSchema.parse(scan);
}

export interface ScanOptions {
  projectId: string;
  windowDays: number;
  currency: Currency;
  metrics: MetricSource;
  compute: ComputeSource;
  env?: NodeJS.ProcessEnv;
  /** GKE namespace activity to attach to the scan (computed by the caller). */
  namespaceActivity?: NamespaceActivity[];
  onDetector?: (run: DetectorRun) => void;
}

/** Run every GCP detector against the given metric/compute sources. */
export async function runScan(opts: ScanOptions): Promise<Scan> {
  const context: DetectorContext = {
    provider: "gcp",
    projectId: opts.projectId,
    windowDays: opts.windowDays,
    currency: opts.currency,
    metrics: opts.metrics,
    compute: opts.compute,
    env: opts.env ?? process.env,
  };
  return assembleScan({
    provider: "gcp",
    projectId: opts.projectId,
    windowDays: opts.windowDays,
    detectors: detectorsFor("gcp"),
    context,
    namespaceActivity: opts.namespaceActivity,
    onDetector: opts.onDetector,
  });
}

export interface AwsScanOptions {
  /** AWS account id — the scan unit (findings carry their own region). */
  accountId: string;
  windowDays: number;
  currency: Currency;
  resources: AwsResourceSource;
  env?: NodeJS.ProcessEnv;
  onDetector?: (run: DetectorRun) => void;
}

/** Run every AWS detector against the given resource source. */
export async function runAwsScan(opts: AwsScanOptions): Promise<Scan> {
  const context: AwsDetectorContext = {
    provider: "aws",
    accountId: opts.accountId,
    windowDays: opts.windowDays,
    currency: opts.currency,
    resources: opts.resources,
    env: opts.env ?? process.env,
  };
  return assembleScan({
    provider: "aws",
    projectId: opts.accountId,
    windowDays: opts.windowDays,
    detectors: awsDetectors(),
    context,
    onDetector: opts.onDetector,
  });
}

export interface AzureScanOptions {
  /** Azure subscription id — the scan unit (findings carry their own region). */
  subscriptionId: string;
  windowDays: number;
  currency: Currency;
  resources: AzureResourceSource;
  env?: NodeJS.ProcessEnv;
  onDetector?: (run: DetectorRun) => void;
}

/** Run every Azure detector against the given resource source. */
export async function runAzureScan(opts: AzureScanOptions): Promise<Scan> {
  const context: AzureDetectorContext = {
    provider: "azure",
    subscriptionId: opts.subscriptionId,
    windowDays: opts.windowDays,
    currency: opts.currency,
    resources: opts.resources,
    env: opts.env ?? process.env,
  };
  return assembleScan({
    provider: "azure",
    projectId: opts.subscriptionId,
    windowDays: opts.windowDays,
    detectors: azureDetectors(),
    context,
    onDetector: opts.onDetector,
  });
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
