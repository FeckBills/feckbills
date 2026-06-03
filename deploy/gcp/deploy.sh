#!/usr/bin/env bash
# Deploy the FeckBills read-only agent into your own GCP project as a scheduled
# Cloud Run Job. Read-only throughout — it only ships findings to the FeckBills
# API, never raw resource data or credentials. Safe to re-run (idempotent).
#
#   PROJECT_ID         target project (default: current gcloud project)
#   REGION             default: europe-west2
#   FECKBILLS_API_KEY  required — create one in the console → API keys
#   FECKBILLS_INGEST_URL  default: https://feckbills.com/api/ingest
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west2}"
INGEST_URL="${FECKBILLS_INGEST_URL:-https://feckbills.com/api/ingest}"
IMAGE="ghcr.io/feckbills/feckbills-agent:latest"

: "${PROJECT_ID:?Set PROJECT_ID or run: gcloud config set project <id>}"
: "${FECKBILLS_API_KEY:?Set FECKBILLS_API_KEY — create one at feckbills.com → API keys}"

SA="feckbills-agent@${PROJECT_ID}.iam.gserviceaccount.com"
echo "▶ Deploying FeckBills agent to ${PROJECT_ID} (${REGION})"

echo "1/4 Enabling APIs…"
gcloud services enable \
  run.googleapis.com cloudscheduler.googleapis.com \
  monitoring.googleapis.com compute.googleapis.com cloudresourcemanager.googleapis.com \
  --project "$PROJECT_ID"

echo "2/4 Creating the read-only service account…"
gcloud iam service-accounts create feckbills-agent \
  --display-name "FeckBills agent (read-only)" --project "$PROJECT_ID" 2>/dev/null \
  || echo "  (service account already exists)"
for ROLE in roles/monitoring.viewer roles/compute.viewer roles/browser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${SA}" --role "$ROLE" --condition=None >/dev/null
done

echo "3/4 Deploying the Cloud Run job…"
gcloud run jobs deploy feckbills-agent \
  --image "$IMAGE" --region "$REGION" --project "$PROJECT_ID" \
  --service-account "$SA" \
  --set-env-vars "FECKBILLS_INGEST_TOKEN=${FECKBILLS_API_KEY}" \
  --args "scan,--all-projects,--push,${INGEST_URL}" \
  --max-retries 1 --task-timeout 3600

echo "4/4 Scheduling a daily scan (06:00)…"
gcloud scheduler jobs create http feckbills-daily --location "$REGION" --project "$PROJECT_ID" \
  --schedule "0 6 * * *" --http-method POST \
  --oauth-service-account-email "$SA" \
  --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/feckbills-agent:run" 2>/dev/null \
  || echo "  (scheduler job already exists)"

echo ""
echo "✓ Done. Run it now:"
echo "    gcloud run jobs execute feckbills-agent --region ${REGION} --project ${PROJECT_ID}"
echo "  Findings will appear in the FeckBills console."
