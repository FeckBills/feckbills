<div align="center">

# ƒ FeckBills

**Find the money you're leaking in the cloud.**

A read-only CLI that scans your cloud account for wasted spend — orphaned, idle,
and over-provisioned resources — and tells you the **exact fix**, priced in **£/mo**.

[feckbills.com](https://feckbills.com) · AWS · GCP · Azure

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
# --- GCP ---
gcloud auth application-default login          # read-only ADC
npx feckbills scan --project YOUR_PROJECT_ID

# --- AWS ---  (uses the standard credential chain: env / profile / IAM role)
export AWS_REGION=eu-west-2
npx feckbills scan --provider aws              # one region
npx feckbills scan --provider aws --all-regions

# --- Azure ---  (uses az login / env SP / managed identity)
az login
npx feckbills scan --provider azure --subscription YOUR_SUB_ID
npx feckbills scan --provider azure --all-subscriptions
```

No cloud handy? Run the whole loop on canned data, zero credentials:

```bash
npx feckbills scan --fixture                     # GCP
npx feckbills scan --provider aws --fixture      # AWS
npx feckbills scan --provider azure --fixture    # Azure
```

> Until the npm package + container image are published, build from source — see
> [Build from source](#build-from-source) below.

## What it finds

**GCP** (`--provider gcp`, the default):

| Detector | What it catches |
| --- | --- |
| **GKE over-provisioned requests** | Pod CPU/memory **requests ≫ actual P95 usage** — the big one |
| **Unattached persistent disks** | Disks not attached to anything (incl. leaked `pvc-*` volumes) |
| **Reserved-but-idle static IPs** | External IPs you're billed for while idle |
| **Orphaned & stale snapshots** | Snapshots whose source disk is gone, or long-stale |
| **Disks on stopped VMs** | Disks still billing on `TERMINATED` instances |
| **Idle Compute Engine VMs** | Running VMs with near-zero CPU over the window |

**AWS** (`--provider aws`):

| Detector | What it catches |
| --- | --- |
| **Unattached EBS volumes** | Volumes in the `available` state, billed for nothing |
| **Unassociated Elastic IPs** | EIPs you're billed for since AWS started charging for idle IPv4 |
| **Orphaned & stale EBS snapshots** | Snapshots whose source volume is gone, or long-stale |
| **EBS on stopped instances** | Volumes still billing on stopped EC2 instances |
| **Idle EC2 instances** | Running instances with near-zero CPU (CloudWatch) over the window |

**Azure** (`--provider azure`):

| Detector | What it catches |
| --- | --- |
| **Unattached managed disks** | Disks in the `Unattached` state, billed for their tier |
| **Unassociated public IPs** | Reserved public IPs not bound to any resource |
| **Orphaned & stale snapshots** | Snapshots whose source disk is gone, or long-stale |
| **Disks on deallocated VMs** | Managed disks still billing on deallocated/stopped VMs |
| **Idle virtual machines** | Running VMs with near-zero CPU (Azure Monitor) over the window |

Every finding is priced in £/mo (an estimate of reclaimable capacity), ranked by impact,
and comes with the **why** and the **fix**.

## Usage

```bash
feckbills scan [options]
```

| Flag | Description |
| --- | --- |
| `--provider <gcp\|aws>` | Cloud to scan (default `gcp`) |
| `--project <id>` | **[gcp]** Scan one project |
| `--all-projects [--limit N]` | **[gcp]** Discover & scan every project the credential can see |
| `--region <region>` | **[aws]** Region to scan (defaults to `AWS_REGION`) |
| `--all-regions` | **[aws]** Scan every enabled region in the account |
| `--subscription <id>` | **[azure]** Subscription to scan (defaults to `AZURE_SUBSCRIPTION_ID`) |
| `--all-subscriptions` | **[azure]** Scan every subscription the credential can see |
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

- **GCP:** `roles/monitoring.viewer`, `roles/compute.viewer`, plus `roles/browser` (for `--all-projects` discovery)
- **AWS:** read-only EC2 + CloudWatch (the AWS-managed `ReadOnlyAccess` or `ViewOnlyAccess` policy covers it, as does a tighter policy with `ec2:Describe*` + `cloudwatch:GetMetricData` + `sts:GetCallerIdentity`)
- **Azure:** the built-in **Reader** role on the subscription (Compute + Network + Monitor reads)

It works non-interactively with a service-account key (GCP:
`GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`), static/role credentials
(AWS: env vars, a named `AWS_PROFILE`, or an attached IAM role), or a service
principal / managed identity (Azure: `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` /
`AZURE_CLIENT_SECRET`), so you can run it as a Cloud Run job, k8s CronJob, or
`docker run` on a schedule.

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

Run the test suite (Vitest — pricing, detectors against the fixtures, and the
provider SDK→domain mapping):

```bash
pnpm test
```

### Container

```bash
docker build -t feckbills-agent .
docker run --rm -v $HOME/.config/gcloud:/root/.config/gcloud \
  feckbills-agent scan --project YOUR_PROJECT
```

## License

[MIT](LICENSE) © FeckBills
