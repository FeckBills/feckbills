<div align="center">

# ƒ FeckBills

**Find the money you're leaking in the cloud.**

A read-only CLI that scans your cloud account for wasted spend — orphaned, idle,
and over-provisioned resources — and tells you the **exact fix**, priced in **£/mo**.

[feckbills.com](https://feckbills.com) · GCP/GKE today · AWS & Azure next

<br>

<img src="feckbills-remotion.gif" alt="FeckBills — find the money you're leaking in the cloud" width="820">

<br><br>

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/open?cloudshell_git_repo=https://github.com/FeckBills/feckbills&cloudshell_workspace=deploy/gcp&cloudshell_tutorial=tutorial.md)

One-click deploy the read-only agent into your own GCP project — runs as a scheduled Cloud Run Job, pushes only findings.

</div>
---

> _"Found £400/mo of orphaned volumes in 60 seconds."_

FeckBills connects to your cloud account with a **read-only** role, finds the resources
quietly burning money, and prints a prioritised, plain-English report. No agent to babysit,
no write access, no secrets leave your account — just findings.

## Quickstart

```bash
# 1. Authenticate read-only (uses Application Default Credentials)
gcloud auth application-default login

# 2. Scan a project
npx feckbills scan --project YOUR_PROJECT_ID
```

No cloud handy? Run the whole loop on canned data, zero credentials:

```bash
npx feckbills scan --fixture
```

> Until the npm package + container image are published, build from source — see
> [Build from source](#build-from-source) below.

## What it finds

GCP today (AWS & Azure next):

| Detector | What it catches |
| --- | --- |
| **GKE over-provisioned requests** | Pod CPU/memory **requests ≫ actual P95 usage** — the big one |
| **Unattached persistent disks** | Disks not attached to anything (incl. leaked `pvc-*` volumes) |
| **Reserved-but-idle static IPs** | External IPs you're billed for while idle |
| **Orphaned & stale snapshots** | Snapshots whose source disk is gone, or long-stale |
| **Disks on stopped VMs** | Disks still billing on `TERMINATED` instances |
| **Idle Compute Engine VMs** | Running VMs with near-zero CPU over the window |

Every finding is priced in £/mo (an estimate of reclaimable capacity), ranked by impact,
and comes with the **why** and the **fix**.

## Usage

```bash
feckbills scan [options]
```

| Flag | Description |
| --- | --- |
| `--project <id>` | Scan one project |
| `--all-projects [--limit N]` | Discover & scan every project the credential can see |
| `--window <days>` | Usage look-back window (default `14`) |
| `--currency <code>` | Report currency (default `GBP`) |
| `--out <file.md>` | Write a markdown report |
| `--json` | Emit raw findings JSON |
| `--fixture` | Canned data, no cloud calls |
| `--push <url> --token <key>` | POST findings to a hosted console |

List the projects a credential can see:

```bash
feckbills projects
```

## Read-only by design

FeckBills only ever **reads**, and only ever **ships findings** — resource IDs, metrics,
and savings figures. Never raw resource data, never secrets, never write actions.

Least-privilege roles it needs:

- `roles/monitoring.viewer`
- `roles/compute.viewer`
- `roles/browser` (for `--all-projects` discovery)

It works non-interactively with a service-account key too
(`GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`), so you can run it as a
Cloud Run job, k8s CronJob, or `docker run` on a schedule.

## Hosted console (optional)

The CLI is the free, open-source funnel. [feckbills.com](https://feckbills.com) adds a hosted
console on top — continuous scheduled scans, history & trends, multi-project rollup, and an
AI brief across your whole estate. Push findings to it with an account API key:

```bash
feckbills scan --all-projects \
  --push https://app.feckbills.com/api/ingest \
  --token $FECKBILLS_API_KEY
```

Prefer not to run the CLI yourself? Deploy this same agent **into your own cloud**
(a scheduled Cloud Run job under a read-only service account you control) from the console —
we never see or store your credentials.

## Build from source

This is a small pnpm workspace: [`packages/core`](packages/core) (schemas + money helpers)
and [`packages/cli`](packages/cli) (the scanner).

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js scan --fixture
```

Or run it straight from TypeScript without building:

```bash
pnpm --filter @feckbills/cli dev scan --fixture
```

### Container

```bash
docker build -t feckbills-agent .
docker run --rm -v $HOME/.config/gcloud:/root/.config/gcloud \
  feckbills-agent scan --project YOUR_PROJECT
```

## License

[MIT](LICENSE) © FeckBills
