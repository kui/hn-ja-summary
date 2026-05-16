#!/bin/bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-asia-northeast1}"
SA_EMAIL="hn-feed-sa@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="gcr.io/${PROJECT_ID}/hn-feed-processor:latest"

: "${GEMINI_API_KEY:?Set GEMINI_API_KEY}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_KV_NAMESPACE_ID:?Set CLOUDFLARE_KV_NAMESPACE_ID}"
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${WORKERS_DOMAIN:?Set WORKERS_DOMAIN}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building processor image..."
docker build -t "$IMAGE" -f "${REPO_ROOT}/processor/Dockerfile" "$REPO_ROOT"
docker push "$IMAGE"

echo "Deploying processor to Cloud Run..."
gcloud run deploy hn-feed-processor \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --no-allow-unauthenticated \
  --service-account="$SA_EMAIL" \
  --set-env-vars="GEMINI_API_KEY=${GEMINI_API_KEY},CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID},CLOUDFLARE_KV_NAMESPACE_ID=${CLOUDFLARE_KV_NAMESPACE_ID},CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN},WORKERS_DOMAIN=${WORKERS_DOMAIN}" \
  --concurrency=10 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=300 \
  --project="$PROJECT_ID"

PROCESSOR_URL=$(gcloud run services describe hn-feed-processor \
  --region="$REGION" --project="$PROJECT_ID" \
  --format="value(status.url)")

echo ""
echo "Processor deployed: $PROCESSOR_URL"
echo "Export for next step: export PROCESSOR_URL=$PROCESSOR_URL"
