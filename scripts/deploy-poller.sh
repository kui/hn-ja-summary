#!/bin/bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-asia-northeast1}"
QUEUE_NAME="${CLOUD_TASKS_QUEUE:-hn-processor}"
SA_EMAIL="hn-feed-sa@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="gcr.io/${PROJECT_ID}/hn-feed-poller:latest"

: "${PROCESSOR_URL:?Set PROCESSOR_URL (Cloud Run processor URL)}"
POLLER_SCHEDULE="${POLLER_SCHEDULE:-*/15 * * * *}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building poller image..."
docker build -t "$IMAGE" -f "${REPO_ROOT}/poller/Dockerfile" "$REPO_ROOT"
docker push "$IMAGE"

ENV_VARS="GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},CLOUD_TASKS_QUEUE=${QUEUE_NAME},PROCESSOR_URL=${PROCESSOR_URL},SERVICE_ACCOUNT_EMAIL=${SA_EMAIL}"

echo "Deploying poller as Cloud Run Job..."
gcloud run jobs create hn-feed-poller \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --set-env-vars="$ENV_VARS" \
  --max-retries=1 \
  --task-timeout=300 \
  --project="$PROJECT_ID" 2>/dev/null \
|| gcloud run jobs update hn-feed-poller \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --set-env-vars="$ENV_VARS" \
  --max-retries=1 \
  --task-timeout=300 \
  --project="$PROJECT_ID"

echo "Setting up Cloud Scheduler (schedule: ${POLLER_SCHEDULE})..."
SCHEDULER_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/hn-feed-poller:run"

gcloud scheduler jobs create http hn-feed-poller-trigger \
  --location="$REGION" \
  --schedule="$POLLER_SCHEDULE" \
  --uri="$SCHEDULER_URI" \
  --http-method=POST \
  --oauth-service-account-email="$SA_EMAIL" \
  --project="$PROJECT_ID" 2>/dev/null \
|| gcloud scheduler jobs update http hn-feed-poller-trigger \
  --location="$REGION" \
  --schedule="$POLLER_SCHEDULE" \
  --uri="$SCHEDULER_URI" \
  --http-method=POST \
  --oauth-service-account-email="$SA_EMAIL" \
  --project="$PROJECT_ID"

echo ""
echo "Poller deployed and scheduled: ${POLLER_SCHEDULE}"
