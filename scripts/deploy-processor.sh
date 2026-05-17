#!/bin/bash
# Deploy Cloud Run Service for the processor.
# Docker image must already be built and pushed before calling this script.
#
# Required env vars:
#   GCP_PROJECT_ID, GCP_SERVICE_ACCOUNT
#   GEMINI_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID
#   CLOUDFLARE_API_TOKEN, WORKERS_DOMAIN, MAX_COMMENTS
# Optional env vars:
#   GCP_REGION (default: asia-northeast1)
#   IMAGE (default: gcr.io/${GCP_PROJECT_ID}/hn-feed-processor:latest)
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-asia-northeast1}"
SA_EMAIL="${GCP_SERVICE_ACCOUNT:?Set GCP_SERVICE_ACCOUNT}"
IMAGE="${IMAGE:-gcr.io/${PROJECT_ID}/hn-feed-processor:latest}"
MAX_COMMENTS="${MAX_COMMENTS:?Set MAX_COMMENTS}"

: "${GEMINI_API_KEY:?Set GEMINI_API_KEY}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_KV_NAMESPACE_ID:?Set CLOUDFLARE_KV_NAMESPACE_ID}"
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${WORKERS_DOMAIN:?Set WORKERS_DOMAIN}"

echo "==> Deploying Cloud Run Service: hn-feed-processor"
gcloud run deploy hn-feed-processor \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --no-allow-unauthenticated \
  --service-account="${SA_EMAIL}" \
  --set-env-vars="GEMINI_API_KEY=${GEMINI_API_KEY},CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID},CLOUDFLARE_KV_NAMESPACE_ID=${CLOUDFLARE_KV_NAMESPACE_ID},CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN},WORKERS_DOMAIN=${WORKERS_DOMAIN},GCP_PROJECT_ID=${PROJECT_ID},MAX_COMMENTS=${MAX_COMMENTS}" \
  --concurrency=10 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=300 \
  --project="${PROJECT_ID}"

echo "Done."
