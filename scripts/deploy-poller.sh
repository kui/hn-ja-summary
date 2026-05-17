#!/bin/bash
# Deploy Cloud Run Job and Cloud Scheduler for the poller.
# Docker image must already be built and pushed before calling this script.
#
# Required env vars:
#   GCP_PROJECT_ID, GCP_SERVICE_ACCOUNT, PROCESSOR_URL
# Optional env vars:
#   GCP_REGION (default: asia-northeast1)
#   CLOUD_TASKS_QUEUE (default: hn-processor)
#   IMAGE (default: gcr.io/${GCP_PROJECT_ID}/hn-feed-poller:latest)
#   POLLER_SCHEDULE (default: */15 * * * *)
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-asia-northeast1}"
QUEUE="${CLOUD_TASKS_QUEUE:-hn-processor}"
SA_EMAIL="${GCP_SERVICE_ACCOUNT:?Set GCP_SERVICE_ACCOUNT}"
IMAGE="${IMAGE:-gcr.io/${PROJECT_ID}/hn-feed-poller:latest}"
SCHEDULE="${POLLER_SCHEDULE:-*/30 * * * *}"

: "${PROCESSOR_URL:?Set PROCESSOR_URL}"

ENV_VARS="GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},CLOUD_TASKS_QUEUE=${QUEUE},PROCESSOR_URL=${PROCESSOR_URL},SERVICE_ACCOUNT_EMAIL=${SA_EMAIL}"

echo "==> Deploying Cloud Run Job: hn-feed-poller"
gcloud run jobs deploy hn-feed-poller \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --service-account="${SA_EMAIL}" \
  --set-env-vars="${ENV_VARS}" \
  --max-retries=1 \
  --task-timeout=300 \
  --project="${PROJECT_ID}"

echo "==> Setting up Cloud Scheduler (${SCHEDULE})"
SCHEDULER_URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/hn-feed-poller:run"

if gcloud scheduler jobs describe hn-feed-poller-trigger \
    --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  gcloud scheduler jobs update http hn-feed-poller-trigger \
    --schedule="${SCHEDULE}" \
    --uri="${SCHEDULER_URI}" \
    --message-body="{}" \
    --oauth-service-account-email="${SA_EMAIL}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}"
else
  gcloud scheduler jobs create http hn-feed-poller-trigger \
    --schedule="${SCHEDULE}" \
    --uri="${SCHEDULER_URI}" \
    --message-body="{}" \
    --oauth-service-account-email="${SA_EMAIL}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}"
fi

echo "Done. Poller scheduled: ${SCHEDULE}"
