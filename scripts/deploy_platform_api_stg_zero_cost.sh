#!/usr/bin/env bash
set -euo pipefail

APPLY="false"
if [[ "${1:-}" == "--apply" ]]; then
  APPLY="true"
elif [[ "${1:-}" != "" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 64
fi

PROJECT_ID="${PROJECT_ID:-medical-core-stg}"
REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-halunasu-services}"
SERVICE_NAME="${SERVICE_NAME:-platform-api-stg}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-halunasu-platform-api@${PROJECT_ID}.iam.gserviceaccount.com}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE_NAME}:${TAG}"
ENV_FILE="${ENV_FILE:-infra/gcp/envs/stg/cloud-run/platform-api.env.yaml}"

MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-1}"
CPU="${CPU:-1}"
MEMORY="${MEMORY:-512Mi}"
TIMEOUT="${TIMEOUT:-60}"
CONCURRENCY="${CONCURRENCY:-80}"

if [[ "${PROJECT_ID}" != "medical-core-stg" ]]; then
  echo "Refusing to deploy: PROJECT_ID must be medical-core-stg for this staging script." >&2
  exit 65
fi

if [[ "${MIN_INSTANCES}" != "0" ]]; then
  echo "Refusing to deploy: MIN_INSTANCES must be 0 for cost control." >&2
  exit 65
fi

if [[ "${MAX_INSTANCES}" != "1" ]]; then
  echo "Refusing to deploy: MAX_INSTANCES must be 1 for staging cost control." >&2
  exit 65
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 66
fi

BUILD_CMD=(
  gcloud builds submit .
  --project "${PROJECT_ID}"
  --config cloudbuild.platform-api.yaml
  --substitutions "_IMAGE=${IMAGE}"
)

DEPLOY_CMD=(
  gcloud run deploy "${SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --image "${IMAGE}"
  --platform managed
  --no-allow-unauthenticated
  --service-account "${SERVICE_ACCOUNT}"
  --min-instances "${MIN_INSTANCES}"
  --max-instances "${MAX_INSTANCES}"
  --cpu "${CPU}"
  --memory "${MEMORY}"
  --timeout "${TIMEOUT}"
  --concurrency "${CONCURRENCY}"
  --execution-environment gen2
  --cpu-throttling
  --env-vars-file "${ENV_FILE}"
  --quiet
)

echo "Cost guardrails:"
echo "- no Terraform"
echo "- no API enablement"
echo "- no Artifact Registry repository creation"
echo "- no Firestore creation"
echo "- no bucket creation"
echo "- no Secret Manager secret creation"
echo "- no unauthenticated public access"
echo "- Cloud Run min instances: ${MIN_INSTANCES}"
echo "- Cloud Run max instances: ${MAX_INSTANCES}"
echo
echo "Build command:"
printf ' %q' "${BUILD_CMD[@]}"
echo
echo
echo "Deploy command:"
printf ' %q' "${DEPLOY_CMD[@]}"
echo
echo

if [[ "${APPLY}" != "true" ]]; then
  echo "Dry run only. Re-run with --apply to build and deploy."
  exit 0
fi

echo "Checking required existing resources..."
gcloud artifacts repositories describe "${REPOSITORY}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" >/dev/null

gcloud iam service-accounts describe "${SERVICE_ACCOUNT}" \
  --project "${PROJECT_ID}" >/dev/null

echo "Building image..."
"${BUILD_CMD[@]}"

echo "Deploying Cloud Run service..."
"${DEPLOY_CMD[@]}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

echo "Deployment complete."
echo "Service URL: ${SERVICE_URL}"
echo "Smoke test without Firestore writes:"
echo "curl -sS -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" ${SERVICE_URL}/readyz"
