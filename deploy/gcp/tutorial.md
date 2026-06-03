# Deploy the FeckBills agent to GCP

This walkthrough deploys the **read-only** FeckBills agent into your own GCP
project as a scheduled Cloud Run Job. It only ever reads metrics and ships
*findings* — never raw resource data, never credentials.

## Before you start

You'll need:

- A GCP project you own (billing enabled).
- A FeckBills account API key (`fbk_…`) — create one at
  **feckbills.com → Console → API keys**. Copy it; you'll paste it next.

<walkthrough-tutorial-duration duration="3"></walkthrough-tutorial-duration>

## Pick your project

Select the project to deploy into:

<walkthrough-project-setup></walkthrough-project-setup>

```bash
gcloud config set project "<walkthrough-project-id/>"
```

## Set your API key

Paste the `fbk_` key you created in the console (it's stored only in this Cloud
Shell session and as the job's env var):

```bash
export FECKBILLS_API_KEY="fbk_paste_your_key_here"
```

## Deploy

This enables the APIs, creates a least-privilege read-only service account
(`monitoring.viewer`, `compute.viewer`, `browser`), deploys the Cloud Run Job,
and schedules a daily scan:

```bash
bash deploy/gcp/deploy.sh
```

## Run it now (optional)

Kick off the first scan without waiting for the schedule:

```bash
gcloud run jobs execute feckbills-agent --region europe-west2
```

Findings land in your FeckBills console within a minute or two — projects
auto-create on first push.

## Done

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

The agent now scans daily under a read-only service account **you** control.
Review or revoke it any time:

```bash
gcloud run jobs describe feckbills-agent --region europe-west2
```

To remove everything: delete the `feckbills-daily` scheduler job, the
`feckbills-agent` Cloud Run job, and the `feckbills-agent` service account.
