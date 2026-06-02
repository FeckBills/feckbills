import type { Finding, Scan } from "@feckbills/core";
import { formatMonthly } from "@feckbills/core";
import { totalSaving, wastePct } from "../scan.js";

const CATEGORY_LABEL: Record<Finding["category"], string> = {
  orphaned: "Orphaned",
  idle: "Idle",
  "over-provisioned": "Over-provisioned",
  commitment: "Commitment gap",
};

const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "⚪ low",
};

/** The deliverable (CLAUDE.md §13 step 4): a plain-English markdown report. */
export function renderMarkdown(scan: Scan): string {
  const total = totalSaving(scan);
  const lines: string[] = [];

  lines.push(`# FeckBills report — \`${scan.projectId}\``);
  lines.push("");
  lines.push(
    `> **${formatMonthly(total)}** of estimated waste found across ` +
      `**${scan.findings.length}** finding${scan.findings.length === 1 ? "" : "s"} ` +
      `(${scan.provider.toUpperCase()}, ${scan.windowDays}-day window).`,
  );
  const pct = wastePct(scan);
  if (pct != null && scan.estimatedMonthlySpend != null) {
    lines.push("");
    lines.push(
      `> That's **${Math.round(pct)}%** of the ~${formatMonthly(scan.estimatedMonthlySpend)}/mo of GKE compute your workloads reserve.`,
    );
  }
  lines.push("");
  lines.push(
    `_Scan ${scan.status} · agent v${scan.agentVersion} · ${scan.startedAt}_`,
  );
  lines.push("");

  if (scan.findings.length === 0) {
    lines.push("✅ No waste detected above the reporting threshold. Nice.");
    lines.push("");
  } else {
    lines.push("## Top findings");
    lines.push("");
    lines.push("| # | Saving | Severity | Resource | What |");
    lines.push("| --: | --: | :-- | :-- | :-- |");
    scan.findings.forEach((f, i) => {
      lines.push(
        `| ${i + 1} | **${formatMonthly(f.estimatedMonthlySaving, f.currency)}** ` +
          `| ${SEVERITY_BADGE[f.severity]} | \`${f.resourceName}\` | ${CATEGORY_LABEL[f.category]} |`,
      );
    });
    lines.push("");

    lines.push("## Detail");
    lines.push("");
    scan.findings.forEach((f, i) => {
      lines.push(`### ${i + 1}. ${f.title} — ${formatMonthly(f.estimatedMonthlySaving, f.currency)}`);
      lines.push("");
      lines.push(`- **Category:** ${CATEGORY_LABEL[f.category]} · **Severity:** ${SEVERITY_BADGE[f.severity]} · **Confidence:** ${Math.round(f.confidence * 100)}%`);
      lines.push(`- **Region:** ${f.region ?? "—"} · **Service:** ${f.service}`);
      lines.push(`- ${f.detail}`);
      if (f.suggestedAction) lines.push(`- **Fix:** ${f.suggestedAction}`);
      lines.push("");
    });
  }

  lines.push("## How these numbers were produced");
  lines.push("");
  lines.push("- Read-only scan via the cloud provider's metrics/recommendation APIs. No write access, no secrets read.");
  lines.push("- £ figures are **estimates** of reclaimable spend, derived from published list prices — treat them as the size of the prize, not an invoice.");
  lines.push("");

  renderDetectorRuns(scan, lines);

  return lines.join("\n");
}

function renderDetectorRuns(scan: Scan, lines: string[]): void {
  const failed = scan.detectorRuns.filter((r) => !r.ok);
  if (failed.length === 0) return;
  lines.push("## Detectors that did not complete");
  lines.push("");
  for (const r of failed) {
    lines.push(`- \`${r.detectorId}\`: ${r.error ?? "unknown error"}`);
  }
  lines.push("");
}
