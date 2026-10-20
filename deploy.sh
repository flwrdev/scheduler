#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="jhay-510919"
REGION="us-central1"
SERVICE="delivery-scheduler"
IMAGE="us-central1-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE}:latest"

gcloud auth configure-docker us-central1-docker.pkg.dev --quiet

docker build -t "${IMAGE}" .

docker push "${IMAGE}"

gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --quiet
