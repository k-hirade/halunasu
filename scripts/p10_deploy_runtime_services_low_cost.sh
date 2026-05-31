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
TARGET_ENV="${TARGET_ENV:-all}"
TARGET_SERVICE="${TARGET_SERVICE:-all}"

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
echo "Target env: ${TARGET_ENV}"
echo "Target service: ${TARGET_SERVICE}"
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

billing_enabled() {
  gcloud billing projects describe "$1" --format="value(billingEnabled)" --quiet 2>/dev/null || true
}

secret_exists() {
  local project="$1"
  local secret="$2"
  if [[ "${APPLY}" != "true" ]]; then
    return 0
  fi
  gcloud secrets describe "${secret}" --project "${project}" --quiet >/dev/null 2>&1
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
  local service_memory="${MEMORY}"
  local service_timeout="${TIMEOUT}"
  local build_ignore_file=".gcloudignore"
  if [[ "${service}" == fee-api-* ]]; then
    build_ignore_file=".gcloudignore.fee-api"
    service_memory="${FEE_MEMORY:-2Gi}"
    service_timeout="${FEE_TIMEOUT:-180}"
  fi
  local secret_vars="APP_SESSION_SIGNING_SECRET=APP_SESSION_SIGNING_SECRET:latest"
  if [[ "${service}" == platform-api-* ]] && secret_exists "${project}" "STRIPE_SECRET_KEY"; then
    secret_vars="${secret_vars},STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest"
  fi
  if [[ "${service}" == platform-api-* ]] && secret_exists "${project}" "STRIPE_WEBHOOK_SECRET"; then
    secret_vars="${secret_vars},STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest"
  fi
  if [[ "${service}" == platform-api-* ]] && secret_exists "${project}" "RESEND_API_KEY"; then
    secret_vars="${secret_vars},RESEND_API_KEY=RESEND_API_KEY:latest"
  fi
  if [[ "${service}" == charting-gateway-* ]]; then
    secret_vars="${secret_vars},PAIRING_SIGNING_SECRET=PAIRING_SIGNING_SECRET:latest"
  fi
  if [[ "${service}" == charting-gateway-* ]] && secret_exists "${project}" "APP_FIELD_ENCRYPTION_KEY"; then
    secret_vars="${secret_vars},APP_FIELD_ENCRYPTION_KEY=APP_FIELD_ENCRYPTION_KEY:latest"
  fi
  if [[ "${service}" == charting-gateway-* ]] && secret_exists "${project}" "OPENAI_API_KEY"; then
    secret_vars="${secret_vars},OPENAI_API_KEY=OPENAI_API_KEY:latest"
  fi
  if [[ "${service}" == charting-gateway-* ]] && secret_exists "${project}" "DEEPGRAM_API_KEY"; then
    secret_vars="${secret_vars},DEEPGRAM_API_KEY=DEEPGRAM_API_KEY:latest"
  fi
  if [[ "${service}" == charting-finalize-* ]]; then
    secret_vars="${secret_vars},CHARTING_FINALIZE_INTERNAL_SECRET=CHARTING_FINALIZE_INTERNAL_SECRET:latest"
  fi
  if [[ "${service}" == charting-finalize-* ]] && secret_exists "${project}" "OPENAI_API_KEY"; then
    secret_vars="${secret_vars},OPENAI_API_KEY=OPENAI_API_KEY:latest"
  fi

  echo "== ${project}/${service} =="
  billing_state="$(billing_enabled "${project}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${billing_state}" != "true" ]]; then
    echo "Skipping ${service}; billing is not linked for ${project}."
    echo
    return
  fi
  if [[ "${service}" == platform-api-* ]] && [[ "${APPLY}" == "true" ]] && ! secret_exists "${project}" "RESEND_API_KEY"; then
    echo "Skipping ${service}; RESEND_API_KEY secret is missing for ${project}."
    echo "Create the secret and grant halunasu-platform-api access before deploying LP signup mail parity."
    echo
    return
  fi

  build_cmd=(
    gcloud builds submit .
    --project "${project}"
    --config cloudbuild.node-service.yaml
    --substitutions "_IMAGE=${image},_SERVICE_PATH=${service_path}"
    --quiet
  )
  if [[ -f "${build_ignore_file}" ]]; then
    build_cmd+=(--ignore-file "${build_ignore_file}")
  fi
  run_or_print "${build_cmd[@]}"

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
    --memory "${service_memory}"
    --timeout "${service_timeout}"
    --concurrency "${CONCURRENCY}"
    --execution-environment gen2
    --cpu-throttling
    --set-env-vars "$(IFS=,; echo "${env_vars[*]}")"
    --set-secrets "${secret_vars}"
    --quiet
  )

  if [[ "${public}" == "public" ]]; then
    deploy_cmd+=(--no-invoker-iam-check)
  else
    deploy_cmd+=(--invoker-iam-check --no-allow-unauthenticated)
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
  local session_cookie_name="halunasu_session"
  local csrf_cookie_name="halunasu_csrf"

  if [[ "${env}" == "stg" ]]; then
    session_cookie_name="halunasu_stg_session"
    csrf_cookie_name="halunasu_stg_csrf"
  fi

  local charting_app_base_url="https://charting.halunasu.com"
  local charting_allowed_origins="https://charting.halunasu.com"
  local lp_base_url="https://halunasu.com"
  if [[ "${env}" == "stg" ]]; then
    charting_app_base_url="https://charting.stg.halunasu.com"
    charting_allowed_origins="https://charting.stg.halunasu.com"
    lp_base_url="https://stg.halunasu.com"
  fi

  if should_deploy "${env}" "platform-api"; then
    deploy_service "${core_project}" "platform-api-${env}" "services/platform-api" "halunasu-platform-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "PLATFORM_STORE_BACKEND=firestore" \
    "PLATFORM_PUBLIC_APP_BASE_URL=${charting_app_base_url}" \
    "PLATFORM_PUBLIC_LP_BASE_URL=${lp_base_url}" \
    "STRIPE_API_VERSION=2026-05-27.dahlia" \
    "STRIPE_PRICE_LOOKUP_KEY=${STRIPE_PRICE_LOOKUP_KEY:-halunasu_charting_flat_monthly_jpy_v1}" \
    "STRIPE_CHARTING_FLAT_PRICE_LOOKUP_KEY=${STRIPE_CHARTING_FLAT_PRICE_LOOKUP_KEY:-halunasu_charting_flat_monthly_jpy_v1}" \
    "EMAIL_DELIVERY_PROVIDER=resend" \
    "EMAIL_FROM_ADDRESS=${EMAIL_FROM_ADDRESS:-Halunasu <no-reply@mail.halunasu.com>}" \
    "EMAIL_REPLY_TO_ADDRESS=${EMAIL_REPLY_TO_ADDRESS:-info@halunasu.com}" \
    "APP_SESSION_COOKIE_NAME=${session_cookie_name}" \
    "APP_CSRF_COOKIE_NAME=${csrf_cookie_name}"
  fi

  if should_deploy "${env}" "charting-gateway"; then
    # Browser HTTP uses same-origin Netlify proxy cookies, but session WebSocket connects to Cloud Run directly.
    # Keep bearer auth enabled so the in-memory login token can authenticate WebSocket auth.hello.
    deploy_service "${charting_project}" "charting-gateway-${env}" "services/charting-gateway" "halunasu-charting-gateway" "public" \
    "HALUNASU_ENV=${env}" \
    "APP_ENV=production" \
    "GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore" \
    "CHARTING_GATEWAY_PLATFORM_AUTH_BRIDGE=true" \
    "APP_BASE_URL=${charting_app_base_url}" \
    "ALLOWED_ORIGINS=${charting_allowed_origins}" \
    "APP_REQUIRE_PRIVILEGED_MFA=true" \
    "APP_ALLOW_OPERATOR_BEARER_AUTH=true" \
    "FINALIZE_MODE=inline" \
    "FINAL_TRANSCRIPT_SEGMENT_PRECOMPUTE_ENABLED=false"
  fi

  if should_deploy "${env}" "charting-api"; then
    deploy_service "${charting_project}" "charting-api-${env}" "services/charting-api" "halunasu-charting-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "CHARTING_GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "CHARTING_STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore" \
    "APP_SESSION_COOKIE_NAME=${session_cookie_name}" \
    "APP_CSRF_COOKIE_NAME=${csrf_cookie_name}"
  fi

  if should_deploy "${env}" "charting-finalize"; then
    deploy_service "${charting_project}" "charting-finalize-${env}" "services/charting-finalize" "halunasu-charting-finalize" "private" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "CHARTING_GOOGLE_CLOUD_PROJECT=${charting_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "CHARTING_STORE_BACKEND=firestore"
  fi

  if should_deploy "${env}" "fee-api"; then
    deploy_service "${fee_project}" "fee-api-${env}" "services/fee-api" "halunasu-fee-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${fee_project}" \
    "FEE_GOOGLE_CLOUD_PROJECT=${fee_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "FEE_STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore" \
    "FEE_MASTER_DB_PATH=/tmp/halunasu-fee-master/standard-master.sqlite" \
    "FEE_MASTER_DB_GZIP_PATH=/app/python/data/master/standard-master.sqlite.gz" \
    "APP_SESSION_COOKIE_NAME=${session_cookie_name}" \
    "APP_CSRF_COOKIE_NAME=${csrf_cookie_name}"
  fi

  if should_deploy "${env}" "referral-api"; then
    deploy_service "${referral_project}" "referral-api-${env}" "services/referral-api" "halunasu-referral-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${referral_project}" \
    "REFERRAL_GOOGLE_CLOUD_PROJECT=${referral_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "REFERRAL_STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore" \
    "APP_SESSION_COOKIE_NAME=${session_cookie_name}" \
    "APP_CSRF_COOKIE_NAME=${csrf_cookie_name}"
  fi
}

should_deploy() {
  local env="$1"
  local service="$2"
  [[ "${TARGET_ENV}" == "all" || "${TARGET_ENV}" == "${env}" ]] &&
    [[ "${TARGET_SERVICE}" == "all" || "${TARGET_SERVICE}" == "${service}" ]]
}

if [[ "${TARGET_ENV}" == "all" || "${TARGET_ENV}" == "stg" ]]; then
  deploy_env "stg" "medical-core-stg" "halunasu-charting-stg" "halunasu-fee-stg" "halunasu-referral-stg"
fi
if [[ "${TARGET_ENV}" == "all" || "${TARGET_ENV}" == "prod" ]]; then
  deploy_env "prod" "medical-core-497610" "halunasu-charting-prod" "halunasu-fee-prod" "halunasu-referral-prod"
fi

echo "Deploy script complete."
