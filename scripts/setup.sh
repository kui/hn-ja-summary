#!/bin/bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-asia-northeast1}"
QUEUE_NAME="${CLOUD_TASKS_QUEUE:-hn-processor}"
SA_NAME="hn-feed-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Setting up GCP project: $PROJECT_ID (region: $REGION)"

gcloud services enable \
  cloudrun.googleapis.com \
  cloudtasks.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  --project="$PROJECT_ID"

gcloud iam service-accounts create "$SA_NAME" \
  --display-name="HN Feed Service Account" \
  --project="$PROJECT_ID" 2>/dev/null || echo "Service account already exists"

for ROLE in \
  "roles/datastore.user" \
  "roles/cloudtasks.enqueuer" \
  "roles/cloudtasks.taskRunner" \
  "roles/run.invoker"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$ROLE" \
    --quiet
done

gcloud tasks queues create "$QUEUE_NAME" \
  --location="$REGION" \
  --max-concurrent-dispatches=5 \
  --max-attempts=3 \
  --min-backoff=30s \
  --max-backoff=300s \
  --project="$PROJECT_ID" 2>/dev/null || echo "Queue already exists"

gcloud firestore databases create \
  --location="$REGION" \
  --project="$PROJECT_ID" 2>/dev/null || echo "Firestore already initialized"

echo ""
echo "Setup complete."
echo "Service account: $SA_EMAIL"
echo ""
echo "Next steps:"
echo "  1. Deploy processor:  GCP_PROJECT_ID=$PROJECT_ID bash infra/deploy-processor.sh"
echo "  2. Deploy poller:     PROCESSOR_URL=<url> bash infra/deploy-poller.sh"
echo "  3. Deploy worker:     cd worker && npm install && npx wrangler deploy"
