import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import type { Currency, Scan } from "@feckbills/core";
import { CurrencySchema, formatMonthly } from "@feckbills/core";
import { GcpAuthError, resolveGcpContext } from "./providers/gcp/auth.js";
import { MonitoringClient } from "./providers/gcp/monitoring.js";
import { GcpComputeClient } from "./providers/gcp/compute.js";
import { FixtureComputeSource, FixtureMetricSource } from "./providers/gcp/fixture.js";
import { listAccessibleProjects } from "./providers/gcp/projects.js";
import { namespaceReport, type NamespaceActivity } from "./providers/gcp/gke-activity.js";
import { AwsAuthError, resolveAwsContext } from "./providers/aws/auth.js";
import { AwsResourceClient } from "./providers/aws/ec2.js";
import { FixtureAwsResourceSource } from "./providers/aws/fixture.js";
import { AzureAuthError, resolveAzureContext } from "./providers/azure/auth.js";
import { AzureResourceClient } from "./providers/azure/resources.js";
import { FixtureAzureResourceSource } from "./providers/azure/fixture.js";
import type { ComputeSource, MetricSource } from "./detectors/types.js";
import type { AwsResourceSource } from "./detectors/aws-types.js";
import type { AzureResourceSource } from "./detectors/azure-types.js";
import { AGENT_VERSION, runScan, runAwsScan, runAzureScan, totalSaving } from "./scan.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderTerminal } from "./report/terminal.js";
import { pushScan } from "./push.js";

/** Hosted console ingest endpoint — used when `--push` is given without a URL. */
const DEFAULT_INGEST_URL = "https://feckbills.com/api/ingest";

/**
 * Best-effort GKE namespace activity for a project — the heatmap data. Needs
 * Monitoring + the backend-service list; yields `undefined` for non-GKE projects
 * or when metrics are off. Shared by the single- and all-project scan paths.
 */
async function namespaceActivityFor(
  metrics: MetricSource,
  projectId: string,
  windowDays: number,
): Promise<NamespaceActivity[] | undefined> {
  try {
    const rows = await namespaceReport(metrics, projectId, windowDays);
    return rows.length > 0 ? rows : undefined;
  } catch {
    return undefined; // no cluster / metrics off — ship the scan without it
  }
}

const program = new Command();

program
  .name("feckbills")
  .description("Find the money you're leaking in the cloud. Read-only.")
  .version(AGENT_VERSION);

program
  .command("scan", { isDefault: true })
  .description("Scan a GCP project, AWS account, or Azure subscription for wasted spend and print a prioritised report")
  .option("-P, --provider <name>", "cloud provider to scan: gcp | aws | azure", "gcp")
  .option("-p, --project <id>", "[gcp] project id (defaults to ADC / gcloud config)")
  .option("-r, --region <region>", "[aws] region to scan, e.g. eu-west-2 (defaults to AWS_REGION)")
  .option("--all-regions", "[aws] scan every enabled region in the account", false)
  .option("-s, --subscription <id>", "[azure] subscription id (defaults to AZURE_SUBSCRIPTION_ID)")
  .option("--all-subscriptions", "[azure] scan every subscription the credential can see", false)
  .option("-w, --window <days>", "look-back window in days", "14")
  .option("-c, --currency <code>", "report currency (GBP|USD|EUR)", "GBP")
  .option("-o, --out <file>", "write the markdown report to a file")
  .option("--json", "print the raw scan JSON to stdout instead of the terminal summary", false)
  .option("--fixture", "run against canned data — no cloud credentials needed", false)
  .option("--push [url]", "POST findings to a FeckBills console (defaults to feckbills.com; set FECKBILLS_PUSH_URL to override)")
  .option("--token <token>", "ingest token for --push (or set FECKBILLS_INGEST_TOKEN)")
  .option("--all-projects", "[gcp] discover and scan every project the credential can see", false)
  .option("--limit <n>", "with --all-projects, cap how many projects to scan")
  .action(async (opts) => {
    const provider = String(opts.provider).toLowerCase();
    if (provider !== "gcp" && provider !== "aws" && provider !== "azure") {
      fail(`--provider must be "gcp", "aws", or "azure", got "${opts.provider}"`);
    }

    const windowDays = Number(opts.window);
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      fail(`--window must be a positive number, got "${opts.window}"`);
    }

    const currencyParsed = CurrencySchema.safeParse(String(opts.currency).toUpperCase());
    if (!currencyParsed.success) {
      fail(`--currency must be one of GBP, USD, EUR — got "${opts.currency}"`);
    }
    const currency: Currency = currencyParsed.data;

    // `--push` with no URL falls back to the hosted console (env override, else prod).
    if (opts.push === true) opts.push = process.env.FECKBILLS_PUSH_URL ?? DEFAULT_INGEST_URL;

    // Resolve the ingest token early so we fail before scanning, not after.
    const ingestToken: string | undefined = opts.push
      ? (opts.token ?? process.env.FECKBILLS_INGEST_TOKEN)
      : undefined;
    if (opts.push && !ingestToken) {
      fail("--push needs an ingest token: pass --token <token> or set FECKBILLS_INGEST_TOKEN");
    }

    const onDetector = (run: { ok: boolean; detectorId: string; findingsCount: number; durationMs: number }) => {
      if (opts.json) return;
      const status = run.ok ? pc.green("✓") : pc.red("✗");
      console.error(
        pc.dim(`  ${status} ${run.detectorId} — ${run.findingsCount} finding(s), ${run.durationMs}ms`),
      );
    };

    if (provider === "aws") {
      if (opts.allProjects) fail("--all-projects is GCP-only; for AWS use --all-regions");

      let resources: AwsResourceSource;
      let accountLabel: string;
      if (opts.fixture) {
        resources = new FixtureAwsResourceSource();
        accountLabel = opts.project ?? "123456789012";
        if (!opts.json) console.error(pc.dim("  (fixture mode — canned data, no AWS calls)"));
      } else {
        try {
          const ctx = await resolveAwsContext(opts.region, Boolean(opts.allRegions));
          resources = new AwsResourceClient(ctx.regions);
          accountLabel = ctx.accountId;
          if (!opts.json) {
            const where = opts.allRegions ? `${ctx.regions.length} region(s)` : ctx.regions[0];
            console.error(pc.dim(`  scanning AWS account ${ctx.accountId} · ${where} (${windowDays}d window)…`));
          }
        } catch (err) {
          if (err instanceof AwsAuthError) fail(err.message);
          throw err;
        }
      }

      const scan = await runAwsScan({ accountId: accountLabel, windowDays, currency, resources, onDetector });
      await emitScan(scan, opts, ingestToken);
      return;
    }

    if (provider === "azure") {
      if (opts.allProjects) fail("--all-projects is GCP-only; for Azure use --all-subscriptions");

      // Fixture: a single canned subscription.
      if (opts.fixture) {
        if (!opts.json) console.error(pc.dim("  (fixture mode — canned data, no Azure calls)"));
        const scan = await runAzureScan({
          subscriptionId: opts.subscription ?? "00000000-0000-0000-0000-000000000000",
          windowDays,
          currency,
          resources: new FixtureAzureResourceSource(),
          onDetector,
        });
        await emitScan(scan, opts, ingestToken);
        return;
      }

      let azureCtx;
      try {
        azureCtx = await resolveAzureContext(opts.subscription, Boolean(opts.allSubscriptions));
      } catch (err) {
        if (err instanceof AzureAuthError) fail(err.message);
        throw err;
      }

      // Multi-subscription rollup, mirroring GCP --all-projects.
      if (opts.allSubscriptions) {
        console.error(pc.dim(`  scanning ${azureCtx.subscriptions.length} subscription(s)…\n`));
        let grandTotal = 0;
        let pushed = 0;
        let withWaste = 0;
        for (const sub of azureCtx.subscriptions) {
          const scan = await runAzureScan({
            subscriptionId: sub.id,
            windowDays,
            currency,
            resources: new AzureResourceClient(azureCtx.credential, sub.id),
          });
          const total = totalSaving(scan);
          grandTotal += total;
          if (scan.findings.length > 0) withWaste += 1;
          console.error(
            `  ${scan.findings.length > 0 ? pc.green("✓") : pc.dim("·")} ${sub.name.slice(0, 30).padEnd(30)} ` +
              `${String(scan.findings.length).padStart(4)} findings  ${formatMonthly(total).padStart(10)}`,
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
          `\n  ${pc.bold(formatMonthly(grandTotal))} across ${withWaste}/${azureCtx.subscriptions.length} subscription(s) with waste` +
            (opts.push ? ` · pushed ${pushed}` : ""),
        );
        return;
      }

      // Single subscription.
      const sub = azureCtx.subscriptions[0]!;
      if (!opts.json) console.error(pc.dim(`  scanning Azure subscription ${sub.id} (${windowDays}d window)…`));
      const resources: AzureResourceSource = new AzureResourceClient(azureCtx.credential, sub.id);
      const scan = await runAzureScan({ subscriptionId: sub.id, windowDays, currency, resources, onDetector });
      await emitScan(scan, opts, ingestToken);
      return;
    }

    // --- GCP multi-project: discover every accessible project and scan them all ---
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
        const metrics = new MonitoringClient(metricClient, p.projectId);
        const namespaceActivity = await namespaceActivityFor(metrics, p.projectId, windowDays);
        const scan = await runScan({
          projectId: p.projectId,
          windowDays,
          currency,
          metrics,
          compute: new GcpComputeClient(p.projectId),
          namespaceActivity,
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

    // --- GCP single project ---
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

    // GKE namespace activity for the heatmap (real GCP only; empty for non-GKE).
    const namespaceActivity = opts.fixture ? undefined : await namespaceActivityFor(metrics, projectId, windowDays);

    const scan = await runScan({ projectId, windowDays, currency, metrics, compute, namespaceActivity, onDetector });
    await emitScan(scan, opts, ingestToken);
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

/** Shared output: write the report, print JSON or the terminal summary, push. */
async function emitScan(
  scan: Scan,
  opts: { out?: string; json?: boolean; push?: string },
  ingestToken: string | undefined,
): Promise<void> {
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
}

program
  .command("namespaces")
  .description("GKE namespace activity — which namespaces are actually used (read-only, GCP)")
  .option("-p, --project <id>", "GCP project id (defaults to ADC / gcloud config)")
  .option("-w, --window <days>", "look-back window in days", "7")
  .option("--json", "output the raw activity rows as JSON", false)
  .action(async (opts) => {
    const windowDays = Number(opts.window);
    if (!Number.isFinite(windowDays) || windowDays <= 0) fail(`--window must be positive, got "${opts.window}"`);

    let ctx;
    try {
      ctx = await resolveGcpContext(opts.project);
    } catch (err) {
      if (err instanceof GcpAuthError) fail(err.message);
      throw err;
    }

    if (!opts.json) console.error(pc.dim(`  reading namespace activity for ${ctx.projectId} (${windowDays}d)…`));
    const rows = await namespaceReport(new MonitoringClient(ctx.client, ctx.projectId), ctx.projectId, windowDays);

    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderNamespaces(rows, ctx.projectId, windowDays) + "\n");
  });

/** Terminal "heatmap" of namespace activity + idle/zombie flags. */
function renderNamespaces(rows: NamespaceActivity[], projectId: string, windowDays: number): string {
  const out: string[] = [""];
  out.push(pc.bold(`  GKE namespace activity — ${projectId}`));
  out.push(pc.dim(`  ${windowDays}d window · usage / network / request traffic`));
  out.push("");

  if (rows.length === 0) {
    out.push(pc.dim("  No GKE namespaces found (no cluster, or system metrics off)."));
    return out.join("\n") + "\n";
  }

  const idle = rows.filter((r) => r.idle);
  const idleReclaim = idle.reduce((s, r) => s + r.reservedMonthlyGbp, 0);

  // Intensity glyph from CPU usage, relative to the busiest namespace.
  const maxUsed = Math.max(...rows.map((r) => r.usedCores), 0.001);
  const RAMP = " ▁▂▃▄▅▆▇█";
  const glyph = (used: number) => RAMP[Math.min(RAMP.length - 1, Math.round((used / maxUsed) * (RAMP.length - 1)))]!;

  // Section per cluster (rows arrive grouped by cluster). A project can run
  // several clusters, each with its own namespaces — never merge them.
  const clusters = [...new Set(rows.map((r) => r.cluster))];
  for (const cluster of clusters) {
    const group = rows.filter((r) => r.cluster === cluster);
    const groupIdle = group.filter((r) => r.idle);
    if (clusters.length > 1 || cluster) {
      const label = cluster || "(unknown cluster)";
      const loc = group[0]?.location ? pc.dim(` · ${group[0].location}`) : "";
      const tally = groupIdle.length > 0 ? pc.yellow(` · ${groupIdle.length} idle`) : "";
      out.push(pc.cyan(`  ▸ ${label}`) + loc + tally);
    }
    for (const r of group) {
      const intensity = r.usedCores < 0.02 ? pc.dim("·") : pc.green(glyph(r.usedCores));
      const name = r.namespace.slice(0, 24).padEnd(24);
      const cost = formatMonthly(r.reservedMonthlyGbp).padStart(9);
      const used = `${r.usedCores.toFixed(2)}c`.padStart(7);
      const net = `${Math.round(r.netInKiBs + r.netOutKiBs)}KiB/s`.padStart(11);
      const req = `${r.reqPerSec.toFixed(2)}/s`.padStart(8);
      const tag = r.system
        ? pc.dim("system")
        : r.addon
          ? pc.dim("infra")
          : r.idle
            ? pc.yellow(pc.bold("IDLE — reclaim"))
            : pc.green("live");
      const line = `  ${intensity}  ${name} ${cost}  ${used} ${net} ${req}  ${tag}`;
      out.push(r.system || r.addon ? pc.dim(line) : line);
    }
  }

  out.push("");
  if (idle.length > 0) {
    out.push(
      `  ${pc.yellow(pc.bold(`${idle.length} idle namespace(s)`))} holding ${pc.bold(formatMonthly(idleReclaim))} of reserved compute — ` +
        pc.dim("near-zero CPU, network and request traffic over the window."),
    );
    out.push(pc.dim("  Verify they're not deliberate standby/DR before deleting."));
  } else {
    out.push(pc.dim("  No idle namespaces — everything's doing something."));
  }
  out.push("");
  return out.join("\n");
}

function fail(message: string): never {
  console.error(pc.red(`\n  ${message}\n`));
  process.exit(1);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(`\n  unexpected error: ${(err as Error).message}\n`));
  process.exit(1);
});
