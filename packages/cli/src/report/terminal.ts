import type { Scan } from "@feckbills/core";
import { formatMonthly } from "@feckbills/core";
import pc from "picocolors";
import { totalSaving, wastePct } from "../scan.js";

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  critical: pc.red,
  high: (s) => pc.yellow(pc.bold(s)),
  medium: pc.yellow,
  low: pc.dim,
};

/** Terminal summary — the instant-gratification view (CLAUDE.md tagline test). */
export function renderTerminal(scan: Scan): string {
  const total = totalSaving(scan);
  const out: string[] = [];

  out.push("");
  out.push(pc.bold(`  FeckBills — ${scan.projectId}`));
  out.push(
    pc.dim(`  ${scan.provider.toUpperCase()} · ${scan.windowDays}d window · scan ${scan.status}`),
  );
  out.push("");
  out.push(
    `  ${pc.green(pc.bold(formatMonthly(total)))} estimated waste · ` +
      `${pc.bold(String(scan.findings.length))} finding${scan.findings.length === 1 ? "" : "s"}`,
  );
  const pct = wastePct(scan);
  if (pct != null && scan.estimatedMonthlySpend != null) {
    out.push(
      pc.dim(
        `  ${Math.round(pct)}% of ~${formatMonthly(scan.estimatedMonthlySpend)} GKE compute reserved`,
      ),
    );
  }
  out.push("");

  const top = scan.findings.slice(0, 10);
  for (const f of top) {
    const sev = (SEVERITY_COLOR[f.severity] ?? pc.white)(f.severity.padEnd(8));
    const amount = pc.green(formatMonthly(f.estimatedMonthlySaving, f.currency).padStart(10));
    out.push(`  ${amount}  ${sev}  ${f.resourceName}`);
  }
  if (scan.findings.length > top.length) {
    out.push(pc.dim(`  … and ${scan.findings.length - top.length} more (see the markdown report)`));
  }

  const failed = scan.detectorRuns.filter((r) => !r.ok);
  if (failed.length > 0) {
    out.push("");
    for (const r of failed) {
      out.push(pc.red(`  ! detector ${r.detectorId} failed: ${r.error}`));
    }
  }
  out.push("");
  return out.join("\n");
}
