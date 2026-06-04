import { z } from "zod";

/**
 * Source-of-truth schemas for the scan → findings → recommendations → report
 * pipeline (CLAUDE.md §10). Detectors emit `Finding`s as structured JSON; the
 * AI layer (§6) consumes findings and returns ranked `Recommendation`s — and is
 * never allowed to invent £ figures, so savings live on the Finding, not the
 * Recommendation.
 *
 * Keeping these as Zod schemas (not bare TS types) gives us runtime validation
 * at the detector boundary and a ready-made strict structured-output contract
 * for the model.
 */

export const ProviderSchema = z.enum(["aws", "gcp", "azure"]);
export type Provider = z.infer<typeof ProviderSchema>;

/** What kind of waste a finding represents. */
export const CategorySchema = z.enum([
  "orphaned", // exists, attached to nothing, still billed (unattached disk, idle IP)
  "idle", // running but doing ~nothing (idle LB, zero-connection DB)
  "over-provisioned", // sized far above actual usage (the GKE wedge)
  "commitment", // could be cheaper under a CUD / Savings Plan / RI
]);
export type Category = z.infer<typeof CategorySchema>;

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const CurrencySchema = z.enum(["GBP", "USD", "EUR"]);
export type Currency = z.infer<typeof CurrencySchema>;

/**
 * A single piece of waste found by a detector. `estimatedMonthlySaving` is the
 * detector's number and the *only* source of £ truth downstream.
 */
export const FindingSchema = z.object({
  detectorId: z.string(),
  provider: ProviderSchema,
  /** Stable provider resource id (or a synthetic id for aggregates like a workload). */
  resourceId: z.string(),
  /** Human label for the resource, e.g. "deployment/prod-batch (ns: batch)". */
  resourceName: z.string(),
  region: z.string().optional(),
  service: z.string(),
  category: CategorySchema,
  severity: SeveritySchema,
  title: z.string(),
  /** Plain-English description of the waste (no £ claims here — those live below). */
  detail: z.string(),
  estimatedMonthlySaving: z.number().nonnegative(),
  currency: CurrencySchema,
  /** Detector confidence 0–1; feeds ranking and lets the AI hedge language. */
  confidence: z.number().min(0).max(1).default(0.8),
  /** Raw metrics behind the finding — kept for auditability and the report. */
  metrics: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** Suggested fix, terse. The AI layer expands this into prose. */
  suggestedAction: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * Per-namespace GKE activity (CLAUDE.md §5 GKE). Derived read-only from Cloud
 * Monitoring + the LB backend map — reserved vs used CPU, network, and request
 * traffic, plus a per-time-bucket usage `series` (the heatmap row). Lets the
 * console show which namespaces are actually used and rank reclaim candidates;
 * the user decides, aided by the heatmap, rather than a hard "zombie" verdict.
 */
export const NamespaceActivitySchema = z.object({
  namespace: z.string(),
  /** GKE cluster the namespace lives in — a project can run several clusters,
   *  each with its own `prod`/`default`/etc. Empty for pre-cluster-aware scans. */
  cluster: z.string().default(""),
  /** Cluster location (region/zone) — disambiguates same-named clusters. */
  location: z.string().default(""),
  reservedCores: z.number().nonnegative(),
  reservedGib: z.number().nonnegative(),
  usedCores: z.number().nonnegative(),
  netInKiBs: z.number().nonnegative(),
  netOutKiBs: z.number().nonnegative(),
  reqPerSec: z.number().nonnegative(),
  /** Reclaimable £/mo if the namespace is dead (its reserved compute). */
  reservedMonthlyGbp: z.number().nonnegative(),
  /** GKE-managed system namespace (kube-system, gke-*). */
  system: z.boolean(),
  /** Known idle-by-design cluster add-on (cert-manager, external-dns, …). */
  addon: z.boolean(),
  /** used-CPU cores per time bucket, chronological — the heatmap row. */
  series: z.array(z.number()).default([]),
});
export type NamespaceActivity = z.infer<typeof NamespaceActivitySchema>;

export const ScanStatusSchema = z.enum(["running", "completed", "failed", "partial"]);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

/** Per-detector outcome within a scan — surfaces partial failures honestly. */
export const DetectorRunSchema = z.object({
  detectorId: z.string(),
  ok: z.boolean(),
  findingsCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type DetectorRun = z.infer<typeof DetectorRunSchema>;

export const ScanSchema = z.object({
  provider: ProviderSchema,
  projectId: z.string(),
  agentVersion: z.string(),
  startedAt: z.string(), // ISO-8601, stamped by the caller (no Date.now in core)
  finishedAt: z.string().optional(),
  status: ScanStatusSchema,
  /** Look-back window the detectors used, in days. */
  windowDays: z.number().positive(),
  /**
   * Estimated monthly spend this scan can speak to, derived from the metrics
   * (not a billing API) — e.g. total GKE compute *reserved* by the customer's
   * workloads. Lets the console show waste as a % without billing access.
   * Optional: a scan with no spend-aware detector omits it.
   */
  estimatedMonthlySpend: z.number().nonnegative().optional(),
  detectorRuns: z.array(DetectorRunSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  /** GKE namespace activity (GCP-only; omitted when there's no cluster). */
  namespaceActivity: z.array(NamespaceActivitySchema).optional(),
});
export type Scan = z.infer<typeof ScanSchema>;

export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

/**
 * AI-layer output. The model ranks + explains; it must echo the finding's
 * `estimatedMonthlySaving` verbatim and never produce its own figure.
 */
export const RecommendationSchema = z.object({
  rank: z.number().int().positive(),
  findingResourceId: z.string(),
  actionText: z.string(),
  rationale: z.string(),
  risk: RiskSchema,
  estimatedMonthlySaving: z.number().nonnegative(),
  currency: CurrencySchema,
  generatedBy: z.string(), // model id, or "rule-based" for the v0 non-AI fallback
});
export type Recommendation = z.infer<typeof RecommendationSchema>;
