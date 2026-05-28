#!/usr/bin/env bash
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

APPLY="false"
if [[ "${1:-}" == "--apply" ]]; then
  APPLY="true"
elif [[ "${1:-}" != "" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 64
fi

REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-halunasu-services}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-1}"
MEMORY="${MEMORY:-512Mi}"
CPU="${CPU:-1}"
TIMEOUT="${TIMEOUT:-60}"
CONCURRENCY="${CONCURRENCY:-80}"

if [[ "${MIN_INSTANCES}" != "0" ]]; then
  echo "Refusing deploy: MIN_INSTANCES must be 0." >&2
  exit 65
fi

if [[ "${MAX_INSTANCES}" != "1" ]]; then
  echo "Refusing deploy: MAX_INSTANCES must be 1 for cost control." >&2
  exit 65
fi

echo "P10 low-cost runtime deploy"
echo "Apply: ${APPLY}"
echo "Region: ${REGION}"
echo "Tag: ${TAG}"
echo "Cloud Run: min=${MIN_INSTANCES}, max=${MAX_INSTANCES}, cpu throttling enabled"
echo

run_or_print() {
  if [[ "${APPLY}" == "true" ]]; then
    "$@"
  else
    printf 'DRY RUN:'
    printf ' %q' "$@"
    echo
  fi
}

deploy_service() {
  local project="$1"
  local service="$2"
  local service_path="$3"
  local service_account="$4"
  local public="$5"
  shift 5
  local env_vars=("$@")
  local image="${REGION}-docker.pkg.dev/${project}/${REPOSITORY}/${service}:${TAG}"
  local secret_vars="APP_SESSION_SIGNING_SECRET=APP_SESSION_SIGNING_SECRET:latest"
  if [[ "${service}" == charting-finalize-* ]]; then
    secret_vars="${secret_vars},CHARTING_FINALIZE_INTERNAL_SECRET=CHARTING_FINALIZE_INTERNAL_SECRET:latest"
  fi

  echo "== ${project}/${service} =="
  run_or_print gcloud builds submit . \
    --project "${project}" \
    --config cloudbuild.node-service.yaml \
    --substitutions "_IMAGE=${image},_SERVICE_PATH=${service_path}" \
    --quiet

  deploy_cmd=(
    gcloud run deploy "${service}"
    --project "${project}"
    --region "${REGION}"
    --image "${image}"
    --platform managed
    --service-account "${service_account}@${project}.iam.gserviceaccount.com"
    --min-instances "${MIN_INSTANCES}"
    --max-instances "${MAX_INSTANCES}"
    --cpu "${CPU}"
    --memory "${MEMORY}"
    --timeout "${TIMEOUT}"
    --concurrency "${CONCURRENCY}"
    --execution-environment gen2
    --cpu-throttling
    --set-env-vars "$(IFS=,; echo "${env_vars[*]}")"
    --set-secrets "${secret_vars}"
    --quiet
  )

  if [[ "${public}" == "public" ]]; then
    deploy_cmd+=(--allow-unauthenticated)
  else
    deploy_cmd+=(--no-allow-unauthenticated)
  fi

  run_or_print "${deploy_cmd[@]}"
  echo
}

deploy_env() {
  local env="$1"
  local core_project="$2"
  local charting_project="$3"
  local fee_project="$4"
  local referral_project="$5"

  deploy_service "${core_project}" "platform-api-${env}" "services/platform-api" "halunasu-platform-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "PLATFORM_STORE_BACKEND=firestore"

  deploy_service "${charting_project}" "charting-api-${env}" "services/charting-api" "halunasu-charting-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "CHARTING_GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "CHARTING_STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore"

  deploy_service "${charting_project}" "charting-finalize-${env}" "services/charting-finalize" "halunasu-charting-finalize" "private" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "CHARTING_GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "CHARTING_STORE_BACKEND=firestore"

  deploy_service "${fee_project}" "fee-api-${env}" "services/fee-api" "halunasu-fee-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${fee_project}" \
    "FEE_GOOGLE_CLOUD_PROJECT=${fee_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "FEE_STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore"

  deploy_service "${referral_project}" "referral-api-${env}" "services/referral-api" "halunasu-referral-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${referral_project}" \
    "REFERRAL_GOOGLE_CLOUD_PROJECT=${referral_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "REFERRAL_STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore"
}

deploy_env "stg" "medical-core-stg" "halunasu-charting-stg" "halunasu-fee-stg" "halunasu-referral-stg"
deploy_env "prod" "medical-core-497610" "halunasu-charting-prod" "halunasu-fee-prod" "halunasu-referral-prod"

echo "Deploy script complete."
