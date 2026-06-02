import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import type { Currency } from "@feckbills/core";
import { CurrencySchema } from "@feckbills/core";
import { GcpAuthError, resolveGcpContext } from "./providers/gcp/auth.js";
import { MonitoringClient } from "./providers/gcp/monitoring.js";
import { GcpComputeClient } from "./providers/gcp/compute.js";
import { FixtureComputeSource, FixtureMetricSource } from "./providers/gcp/fixture.js";
import { listAccessibleProjects } from "./providers/gcp/projects.js";
import type { ComputeSource, MetricSource } from "./detectors/types.js";
import { AGENT_VERSION, runScan, totalSaving } from "./scan.js";
import { formatMonthly } from "@feckbills/core";
import { renderMarkdown } from "./report/markdown.js";
import { renderTerminal } from "./report/terminal.js";
import { pushScan } from "./push.js";

const program = new Command();

program
  .name("feckbills")
  .description("Find the money you're leaking in the cloud. Read-only.")
  .version(AGENT_VERSION);

program
  .command("scan", { isDefault: true })
  .description("Scan a GCP project for wasted spend and print a prioritised report")
  .option("-p, --project <id>", "GCP project id (defaults to ADC / gcloud config)")
  .option("-w, --window <days>", "look-back window in days", "14")
  .option("-c, --currency <code>", "report currency (GBP|USD|EUR)", "GBP")
  .option("-o, --out <file>", "write the markdown report to a file")
  .option("--json", "print the raw scan JSON to stdout instead of the terminal summary", false)
  .option("--fixture", "run against canned data — no cloud credentials needed", false)
  .option("--push <url>", "POST findings to a FeckBills console ingest endpoint")
  .option("--token <token>", "ingest token for --push (or set FECKBILLS_INGEST_TOKEN)")
  .option("--all-projects", "discover and scan every GCP project the credential can see", false)
  .option("--limit <n>", "with --all-projects, cap how many projects to scan")
  .action(async (opts) => {
    const windowDays = Number(opts.window);
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      fail(`--window must be a positive number, got "${opts.window}"`);
    }

    const currencyParsed = CurrencySchema.safeParse(String(opts.currency).toUpperCase());
    if (!currencyParsed.success) {
      fail(`--currency must be one of GBP, USD, EUR — got "${opts.currency}"`);
    }
    const currency: Currency = currencyParsed.data;

    // Resolve the ingest token early so we fail before scanning, not after.
    const ingestToken: string | undefined = opts.push
      ? (opts.token ?? process.env.FECKBILLS_INGEST_TOKEN)
      : undefined;
    if (opts.push && !ingestToken) {
      fail("--push needs an ingest token: pass --token <token> or set FECKBILLS_INGEST_TOKEN");
    }

    // --- Multi-project: discover every accessible project and scan them all ---
    if (opts.allProjects && !opts.fixture) {
      let metricClient;
      try {
        metricClient = (await resolveGcpContext(opts.project)).client;
      } catch (err) {
        if (err instanceof GcpAuthError) fail(err.message);
        throw err;
      }

      console.error(pc.dim("  discovering accessible projects…"));
      let projects = await listAccessibleProjects();
      const discovered = projects.length;
      const limit = opts.limit ? Number(opts.limit) : undefined;
      if (limit && Number.isFinite(limit)) projects = projects.slice(0, limit);
      console.error(
        pc.dim(`  found ${discovered} project(s); scanning ${projects.length}${limit ? " (--limit)" : ""}…\n`),
      );

      let grandTotal = 0;
      let pushed = 0;
      let withWaste = 0;
      for (const p of projects) {
        const scan = await runScan({
          projectId: p.projectId,
          windowDays,
          currency,
          metrics: new MonitoringClient(metricClient, p.projectId),
          compute: new GcpComputeClient(p.projectId),
        });
        const total = totalSaving(scan);
        grandTotal += total;
        if (scan.findings.length > 0) withWaste += 1;
        const flag = scan.status === "failed" ? pc.dim("(no access / APIs off)") : "";
        console.error(
          `  ${scan.findings.length > 0 ? pc.green("✓") : pc.dim("·")} ${p.projectId.padEnd(30)} ` +
            `${String(scan.findings.length).padStart(4)} findings  ${formatMonthly(total).padStart(10)} ${flag}`,
        );
        if (opts.push && ingestToken && scan.findings.length > 0) {
          try {
            await pushScan(opts.push, ingestToken, scan);
            pushed += 1;
          } catch (e) {
            console.error(pc.red(`    push failed: ${(e as Error).message}`));
          }
        }
      }

      console.error(
        `\n  ${pc.bold(formatMonthly(grandTotal))} across ${withWaste}/${projects.length} project(s) with waste` +
          (opts.push ? ` · pushed ${pushed}` : ""),
      );
      return;
    }

    let metrics: MetricSource;
    let compute: ComputeSource;
    let projectId: string;

    if (opts.fixture) {
      metrics = new FixtureMetricSource();
      compute = new FixtureComputeSource();
      projectId = opts.project ?? "fixture-project";
      if (!opts.json) console.error(pc.dim("  (fixture mode — canned data, no GCP calls)"));
    } else {
      try {
        const ctx = await resolveGcpContext(opts.project);
        metrics = new MonitoringClient(ctx.client, ctx.projectId);
        compute = new GcpComputeClient(ctx.projectId);
        projectId = ctx.projectId;
      } catch (err) {
        if (err instanceof GcpAuthError) {
          fail(err.message);
        }
        throw err;
      }
    }

    if (!opts.json) {
      console.error(pc.dim(`  scanning ${projectId} (${windowDays}d window)…`));
    }

    const scan = await runScan({
      projectId,
      windowDays,
      currency,
      metrics,
      compute,
      onDetector: (run) => {
        if (opts.json) return;
        const status = run.ok ? pc.green("✓") : pc.red("✗");
        console.error(
          pc.dim(`  ${status} ${run.detectorId} — ${run.findingsCount} finding(s), ${run.durationMs}ms`),
        );
      },
    });

    if (opts.out) {
      await writeFile(opts.out, renderMarkdown(scan), "utf8");
      if (!opts.json) console.error(pc.dim(`  report written to ${opts.out}`));
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(scan, null, 2) + "\n");
    } else {
      process.stdout.write(renderTerminal(scan) + "\n");
    }

    if (opts.push && ingestToken) {
      try {
        const result = await pushScan(opts.push, ingestToken, scan);
        if (!opts.json) {
          console.error(
            pc.dim(`  pushed ${result.findings} finding(s) → ${opts.push} (scan ${result.scanId})`),
          );
        }
      } catch (err) {
        console.error(pc.red(`  push failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    }

    if (scan.status === "failed") process.exitCode = 1;
  });

program
  .command("projects")
  .description("List every GCP project the credential can see (read-only)")
  .option("--json", "output JSON (for tooling / the scan worker)", false)
  .action(async (opts) => {
    const projects = await listAccessibleProjects();
    if (opts.json) {
      process.stdout.write(JSON.stringify(projects) + "\n");
    } else {
      for (const p of projects) console.log(`${p.projectId}\t${p.name}`);
      console.error(pc.dim(`\n  ${projects.length} project(s)`));
    }
  });

function fail(message: string): never {
  console.error(pc.red(`\n  ${message}\n`));
  process.exit(1);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(`\n  unexpected error: ${(err as Error).message}\n`));
  process.exit(1);
});
