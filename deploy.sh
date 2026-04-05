#!/bin/bash
set -euo pipefail

# --- Configuration ---
PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
SERVER_SERVICE="swades-server"
WEB_SERVICE="swades-web"
REGISTRY="gcr.io/${PROJECT_ID}"

echo "==> Building and deploying to GCP project: ${PROJECT_ID}, region: ${REGION}"

# --- Build & push server image ---
echo "==> Building server image..."
docker build -f apps/server/Dockerfile -t "${REGISTRY}/${SERVER_SERVICE}" .
docker push "${REGISTRY}/${SERVER_SERVICE}"

echo "==> Deploying server to Cloud Run..."
gcloud run deploy "${SERVER_SERVICE}" \
  --image "${REGISTRY}/${SERVER_SERVICE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 3000 \
  --set-env-vars "NODE_ENV=production" \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10

# Get server URL for the web app
SERVER_URL=$(gcloud run services describe "${SERVER_SERVICE}" --region "${REGION}" --format 'value(status.url)')
echo "==> Server deployed at: ${SERVER_URL}"

# --- Build & push web image ---
echo "==> Building web image..."
docker build -f apps/web/Dockerfile \
  --build-arg "NEXT_PUBLIC_SERVER_URL=${SERVER_URL}" \
  -t "${REGISTRY}/${WEB_SERVICE}" .
docker push "${REGISTRY}/${WEB_SERVICE}"

echo "==> Deploying web to Cloud Run..."
gcloud run deploy "${WEB_SERVICE}" \
  --image "${REGISTRY}/${WEB_SERVICE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 3001 \
  --set-env-vars "NODE_ENV=production" \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 5

WEB_URL=$(gcloud run services describe "${WEB_SERVICE}" --region "${REGION}" --format 'value(status.url)')
echo ""
echo "==> Deployment complete!"
echo "    Server: ${SERVER_URL}"
echo "    Web:    ${WEB_URL}"
echo ""
echo "NOTE: Update the server's CORS_ORIGIN env var to: ${WEB_URL}"
echo "  gcloud run services update ${SERVER_SERVICE} --region ${REGION} --set-env-vars CORS_ORIGIN=${WEB_URL}"
