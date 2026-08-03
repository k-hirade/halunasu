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
RUNTIME_FEATURE_PROFILE="${RUNTIME_FEATURE_PROFILE:-}"
STG_HOMIS_SIDECAR_ENABLED_DEFAULT="true"
STG_HOMIS_SIDECAR_EXTENSION_IDS_DEFAULT="nhbmaniknlcaaelpaoogepmkhphmmjof"
STG_HOMIS_SIDECAR_SELECTOR_CONTRACTS_DEFAULT="homis-mock-v6,homis-mock-v5,homis-mock-v4,homis-mock-v3,homis-mock-v2"
PROD_HOMIS_SIDECAR_ENABLED_DEFAULT="true"
PROD_HOMIS_SIDECAR_EXTENSION_IDS_DEFAULT="nhbmaniknlcaaelpaoogepmkhphmmjof"
PROD_HOMIS_SIDECAR_SELECTOR_CONTRACTS_DEFAULT="homis-mock-v6,homis-mock-v5,homis-mock-v4,homis-mock-v3,homis-mock-v2"

load_runtime_feature_profile() {
  if [[ -z "${RUNTIME_FEATURE_PROFILE}" ]]; then
    return 0
  fi
  if [[ "${TARGET_ENV}" != "stg" && "${TARGET_ENV}" != "prod" ]]; then
    echo "RUNTIME_FEATURE_PROFILE requires TARGET_ENV=stg or TARGET_ENV=prod." >&2
    return 1
  fi
  local resolved
  if ! resolved="$(python3 scripts/runtime_feature_profile.py resolve \
    --profile "${RUNTIME_FEATURE_PROFILE}" \
    --environment "${TARGET_ENV}")"; then
    return 1
  fi
  local assignment
  while IFS= read -r assignment; do
    [[ -z "${assignment}" ]] && continue
    export "${assignment}"
  done <<< "${resolved}"
}

load_runtime_feature_profile

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
echo "Runtime feature profile: ${RUNTIME_FEATURE_PROFILE:-manual/default}"
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

gcloud_dict_arg() {
  local delimiter="|"
  local entry
  local joined=""

  for entry in "$@"; do
    if [[ "${entry}" == *"${delimiter}"* ]]; then
      echo "Cannot encode gcloud dictionary argument: value contains reserved delimiter '${delimiter}'." >&2
      return 1
    fi
    if [[ -n "${joined}" ]]; then
      joined+="${delimiter}"
    fi
    joined+="${entry}"
  done

  printf '^%s^%s' "${delimiter}" "${joined}"
}

validate_packaged_fee_artifact_reference() {
  local runtime_path="$1"
  local source_uri="$2"
  local expected_type="$3"
  local label="$4"
  if [[ -z "${runtime_path}" ]]; then
    return 0
  fi
  if [[ "${runtime_path}" != /app/python/data/whitebox/* \
    || ! "${runtime_path}" =~ ^/app/python/data/whitebox/[A-Za-z0-9._/-]+$ ]]; then
    echo "${label} must be packaged under /app/python/data/whitebox/." >&2
    return 1
  fi
  local repository_path="${runtime_path#/app/}"
  if [[ -z "${source_uri}" ]]; then
    echo "${label} requires an immutable GCS artifact URI." >&2
    return 1
  fi
  if [[ "${source_uri}" != gs://* \
    || ! "${source_uri}" =~ ^gs://[A-Za-z0-9._/-]+$ ]]; then
    echo "${label} artifact URI must be a safe gs:// URI." >&2
    return 1
  fi
  PYTHONPATH=python:. python3 scripts/manage_fee_whitebox_artifact.py fetch \
    --manifest-uri "${source_uri}" \
    --destination-manifest "${repository_path}" \
    --expected-type "${expected_type}" \
    --dry-run >/dev/null
}

validate_packaged_fee_file_path() {
  local runtime_path="$1"
  local label="$2"
  if [[ -z "${runtime_path}" ]]; then
    return 0
  fi
  if [[ "${runtime_path}" != /app/python/data/whitebox/* ]]; then
    echo "${label} must be packaged under /app/python/data/whitebox/." >&2
    return 1
  fi
  local repository_path="${runtime_path#/app/}"
  if [[ ! -f "${repository_path}" ]]; then
    echo "${label} does not exist in the fee-api build context: ${repository_path}" >&2
    return 1
  fi
}

billing_enabled() {
  gcloud billing projects describe "$1" --format="value(billingEnabled)" --quiet 2>/dev/null || true
}

secret_exists() {
  local project="$1"
  local secret="$2"
  local output
  if [[ "${APPLY}" != "true" ]]; then
    return 0
  fi
  if output="$(gcloud secrets describe "${secret}" --project "${project}" --quiet 2>&1)"; then
    return 0
  fi
  if printf '%s' "${output}" | grep -Eqi 'NOT_FOUND|not found'; then
    return 1
  fi
  echo "Unable to verify secret ${project}/${secret}: ${output}" >&2
  exit 1
}

deploy_service() {
  local project="$1"
  local service="$2"
  local service_path="$3"
  local service_account="$4"
  local public="$5"
  shift 5
  local env_vars=("$@")
  local env_vars_arg
  env_vars_arg="$(gcloud_dict_arg "${env_vars[@]}")"
  local image="${REGION}-docker.pkg.dev/${project}/${REPOSITORY}/${service}:${TAG}"
  local service_memory="${MEMORY}"
  local service_timeout="${TIMEOUT}"
  local service_max_instances="${MAX_INSTANCES}"
  local service_concurrency="${CONCURRENCY}"
  local build_ignore_file=".gcloudignore"
  local build_config="cloudbuild.node-service.yaml"
  if [[ "${service}" == fee-api-* ]]; then
    build_ignore_file=".gcloudignore.fee-api"
    build_config="cloudbuild.fee-api.yaml"
    service_memory="${FEE_MEMORY:-4Gi}"
    service_timeout="${FEE_TIMEOUT:-180}"
    service_max_instances="${FEE_MAX_INSTANCES:-3}"
  fi
  if [[ "${service}" == care-fee-api-* ]]; then
    build_ignore_file=".gcloudignore.care-fee-api"
    service_memory="512Mi"
    service_timeout="60"
    if [[ "${service}" == *-stg ]]; then
      service_concurrency="20"
    else
      service_concurrency="40"
    fi
    service_max_instances="${MAX_INSTANCES}"
  fi

  echo "== ${project}/${service} =="
  billing_state="$(billing_enabled "${project}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${billing_state}" != "true" ]]; then
    echo "Skipping ${service}; billing is not linked for ${project}."
    echo
    return
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
  if [[ "${service}" == platform-api-* ]] && secret_exists "${project}" "PLATFORM_MAINTENANCE_SECRET"; then
    secret_vars="${secret_vars},PLATFORM_MAINTENANCE_SECRET=PLATFORM_MAINTENANCE_SECRET:latest"
  fi
  if [[ "${service}" == platform-api-* ]] && secret_exists "${project}" "APP_FIELD_ENCRYPTION_KEY"; then
    secret_vars="${secret_vars},APP_FIELD_ENCRYPTION_KEY=APP_FIELD_ENCRYPTION_KEY:latest"
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
  if [[ "${service}" == fee-api-* ]] && secret_exists "${project}" "OPENAI_API_KEY"; then
    secret_vars="${secret_vars},OPENAI_API_KEY=OPENAI_API_KEY:latest"
  fi
  if [[ "${service}" == fee-api-* ]] && secret_exists "${project}" "fee-calculation-worker-token"; then
    secret_vars="${secret_vars},FEE_CALCULATION_WORKER_TOKEN=fee-calculation-worker-token:latest"
  fi
  if [[ "${service}" == fee-api-* ]] && secret_exists "${project}" "FEE_EXTRACTION_FEEDBACK_HMAC_SECRET"; then
    secret_vars="${secret_vars},FEE_EXTRACTION_FEEDBACK_HMAC_SECRET=FEE_EXTRACTION_FEEDBACK_HMAC_SECRET:latest"
  fi
  if [[ "${service}" == fee-api-* ]] && secret_exists "${project}" "CARE_FEE_INGEST_TOKEN"; then
    secret_vars="${secret_vars},CARE_FEE_INGEST_TOKEN=CARE_FEE_INGEST_TOKEN:latest"
  fi
  if [[ "${service}" == fee-api-* ]] && secret_exists "${project}" "CARE_FEE_OUTBOX_WORKER_TOKEN"; then
    secret_vars="${secret_vars},CARE_FEE_OUTBOX_WORKER_TOKEN=CARE_FEE_OUTBOX_WORKER_TOKEN:latest"
  fi
  if [[ "${service}" == care-fee-api-* ]] && secret_exists "${project}" "CARE_FEE_INGEST_TOKEN"; then
    secret_vars="${secret_vars},CARE_FEE_INGEST_TOKEN=CARE_FEE_INGEST_TOKEN:latest"
  fi
  if [[ "${service}" == care-fee-api-* ]] && secret_exists "${project}" "CARE_FEE_MONTHLY_WORKER_TOKEN"; then
    secret_vars="${secret_vars},CARE_FEE_MONTHLY_WORKER_TOKEN=CARE_FEE_MONTHLY_WORKER_TOKEN:latest"
  fi

  if [[ "${service}" == care-fee-api-* ]] && [[ "${APPLY}" == "true" ]]; then
    for required_secret in APP_SESSION_SIGNING_SECRET CARE_FEE_INGEST_TOKEN CARE_FEE_MONTHLY_WORKER_TOKEN; do
      if ! secret_exists "${project}" "${required_secret}"; then
        echo "${service}: required secret is missing in ${project}: ${required_secret}" >&2
        return 1
      fi
    done
  fi
  if [[ "${service}" == platform-api-* ]] && [[ "${APPLY}" == "true" ]] && ! secret_exists "${project}" "RESEND_API_KEY"; then
    echo "Skipping ${service}; RESEND_API_KEY secret is missing for ${project}."
    echo "Create the secret and grant halunasu-platform-api access before deploying LP signup mail parity."
    echo
    return
  fi

  local build_substitutions=(
    "_IMAGE=${image}"
    "_SERVICE_PATH=${service_path}"
  )
  if [[ "${service}" == fee-api-* ]]; then
    build_substitutions+=(
      "_FEE_LINKER_ARTIFACT_URI=${FEE_BUILD_LINKER_ARTIFACT_URI:-}"
      "_FEE_LINKER_MANIFEST_PATH=${FEE_BUILD_LINKER_MANIFEST_PATH:-}"
      "_FEE_CONTEXT_CLASSIFIER_ARTIFACT_URI=${FEE_BUILD_CONTEXT_CLASSIFIER_ARTIFACT_URI:-}"
      "_FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH=${FEE_BUILD_CONTEXT_CLASSIFIER_MANIFEST_PATH:-}"
      "_FEE_SPAN_DETECTOR_ARTIFACT_URI=${FEE_BUILD_SPAN_DETECTOR_ARTIFACT_URI:-}"
      "_FEE_SPAN_DETECTOR_MANIFEST_PATH=${FEE_BUILD_SPAN_DETECTOR_MANIFEST_PATH:-}"
    )
  fi
  local build_substitutions_arg
  build_substitutions_arg="$(IFS=,; printf '%s' "${build_substitutions[*]}")"

  build_cmd=(
    gcloud builds submit .
    --project "${project}"
    --region "${REGION}"
    --default-buckets-behavior REGIONAL_USER_OWNED_BUCKET
    --config "${build_config}"
    --substitutions "${build_substitutions_arg}"
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
    --max-instances "${service_max_instances}"
    --cpu "${CPU}"
    --memory "${service_memory}"
    --timeout "${service_timeout}"
    --concurrency "${service_concurrency}"
    --execution-environment gen2
    --cpu-throttling
    --set-env-vars "${env_vars_arg}"
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
  local care_project="$6"
  local session_cookie_name="halunasu_session"
  local csrf_cookie_name="halunasu_csrf"
  local sidecar_enabled="${HOMIS_SIDECAR_ENABLED:-}"
  local sidecar_allowed_extension_ids="${HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS:-}"
  local sidecar_allowed_selector_contract_versions="${HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS:-}"
  local sidecar_revoked_device_ids="${HOMIS_SIDECAR_REVOKED_DEVICE_IDS:-}"
  local sidecar_draft_retention_days="${HOMIS_SIDECAR_DRAFT_RETENTION_DAYS:-30}"
  local sidecar_grant_ttl_hours="${HOMIS_SIDECAR_GRANT_TTL_HOURS:-720}"
  local fee_extraction_memo="${FEE_EXTRACTION_MEMO:-false}"
  local fee_standing_facts="${FEE_STANDING_FACTS:-false}"
  local fee_empty_extraction_retry="false"
  local fee_extraction_snapshot_retention_days="${FEE_EXTRACTION_SNAPSHOT_RETENTION_DAYS:-30}"
  local fee_monthly_exclusion_mode="${FEE_MONTHLY_EXCLUSION_MODE:-off}"
  local fee_clinical_extraction_strategy="${FEE_CLINICAL_EXTRACTION_STRATEGY:-openai_primary}"
  local fee_extraction_coverage_mode="${FEE_EXTRACTION_COVERAGE_MODE:-off}"
  local fee_extraction_coverage_max_lines="${FEE_EXTRACTION_COVERAGE_MAX_LINES:-8}"
  local fee_extraction_coverage_max_spans="${FEE_EXTRACTION_COVERAGE_MAX_SPANS:-16}"
  local fee_extraction_coverage_timeout_ms="${FEE_EXTRACTION_COVERAGE_TIMEOUT_MS:-2000}"
  local fee_extraction_coverage_facility_allowlist="${FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST:-}"
  local fee_linker_mode="${FEE_LINKER_MODE:-off}"
  local fee_context_classifier_mode="${FEE_CONTEXT_CLASSIFIER_MODE:-off}"
  local fee_span_detector_mode="${FEE_SPAN_DETECTOR_MODE:-off}"
  local fee_extraction_feedback_mode="${FEE_EXTRACTION_FEEDBACK_MODE:-off}"
  local fee_linker_manifest_path="${FEE_LINKER_MANIFEST_PATH:-}"
  local fee_context_classifier_manifest_path="${FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH:-}"
  local fee_span_detector_manifest_path="${FEE_SPAN_DETECTOR_MANIFEST_PATH:-}"
  local fee_linker_artifact_uri="${FEE_LINKER_ARTIFACT_URI:-}"
  local fee_context_classifier_artifact_uri="${FEE_CONTEXT_CLASSIFIER_ARTIFACT_URI:-}"
  local fee_span_detector_artifact_uri="${FEE_SPAN_DETECTOR_ARTIFACT_URI:-}"
  local fee_whitebox_thresholds_path="${FEE_WHITEBOX_THRESHOLDS_PATH:-}"
  local fee_extraction_feedback_hmac_key_version="${FEE_EXTRACTION_FEEDBACK_HMAC_KEY_VERSION:-v1}"

  if [[ "${env}" == "stg" ]]; then
    session_cookie_name="halunasu_stg_session"
    csrf_cookie_name="halunasu_stg_csrf"
    sidecar_enabled="${HOMIS_SIDECAR_ENABLED_STG:-${sidecar_enabled:-${STG_HOMIS_SIDECAR_ENABLED_DEFAULT}}}"
    sidecar_allowed_extension_ids="${HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS_STG:-${sidecar_allowed_extension_ids:-${STG_HOMIS_SIDECAR_EXTENSION_IDS_DEFAULT}}}"
    sidecar_allowed_selector_contract_versions="${HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS_STG:-${sidecar_allowed_selector_contract_versions:-${STG_HOMIS_SIDECAR_SELECTOR_CONTRACTS_DEFAULT}}}"
    sidecar_revoked_device_ids="${HOMIS_SIDECAR_REVOKED_DEVICE_IDS_STG:-${sidecar_revoked_device_ids}}"
    sidecar_draft_retention_days="${HOMIS_SIDECAR_DRAFT_RETENTION_DAYS_STG:-${sidecar_draft_retention_days}}"
    sidecar_grant_ttl_hours="${HOMIS_SIDECAR_GRANT_TTL_HOURS_STG:-${sidecar_grant_ttl_hours}}"
    fee_extraction_memo="${FEE_EXTRACTION_MEMO_STG:-${fee_extraction_memo}}"
    fee_standing_facts="${FEE_STANDING_FACTS_STG:-${fee_standing_facts}}"
    fee_empty_extraction_retry="${FEE_EMPTY_EXTRACTION_RETRY_STG:-true}"
    fee_extraction_snapshot_retention_days="${FEE_EXTRACTION_SNAPSHOT_RETENTION_DAYS_STG:-${fee_extraction_snapshot_retention_days}}"
    fee_monthly_exclusion_mode="${FEE_MONTHLY_EXCLUSION_MODE_STG:-${fee_monthly_exclusion_mode}}"
    fee_clinical_extraction_strategy="${FEE_CLINICAL_EXTRACTION_STRATEGY_STG:-${fee_clinical_extraction_strategy}}"
    fee_extraction_coverage_mode="${FEE_EXTRACTION_COVERAGE_MODE_STG:-${fee_extraction_coverage_mode}}"
    fee_extraction_coverage_max_lines="${FEE_EXTRACTION_COVERAGE_MAX_LINES_STG:-${fee_extraction_coverage_max_lines}}"
    fee_extraction_coverage_max_spans="${FEE_EXTRACTION_COVERAGE_MAX_SPANS_STG:-${fee_extraction_coverage_max_spans}}"
    fee_extraction_coverage_timeout_ms="${FEE_EXTRACTION_COVERAGE_TIMEOUT_MS_STG:-${fee_extraction_coverage_timeout_ms}}"
    fee_extraction_coverage_facility_allowlist="${FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST_STG:-${fee_extraction_coverage_facility_allowlist}}"
    fee_linker_mode="${FEE_LINKER_MODE_STG:-${fee_linker_mode}}"
    fee_context_classifier_mode="${FEE_CONTEXT_CLASSIFIER_MODE_STG:-${fee_context_classifier_mode}}"
    fee_span_detector_mode="${FEE_SPAN_DETECTOR_MODE_STG:-${fee_span_detector_mode}}"
    fee_extraction_feedback_mode="${FEE_EXTRACTION_FEEDBACK_MODE_STG:-${fee_extraction_feedback_mode}}"
    fee_linker_manifest_path="${FEE_LINKER_MANIFEST_PATH_STG:-${fee_linker_manifest_path}}"
    fee_context_classifier_manifest_path="${FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH_STG:-${fee_context_classifier_manifest_path}}"
    fee_span_detector_manifest_path="${FEE_SPAN_DETECTOR_MANIFEST_PATH_STG:-${fee_span_detector_manifest_path}}"
    fee_linker_artifact_uri="${FEE_LINKER_ARTIFACT_URI_STG:-${fee_linker_artifact_uri}}"
    fee_context_classifier_artifact_uri="${FEE_CONTEXT_CLASSIFIER_ARTIFACT_URI_STG:-${fee_context_classifier_artifact_uri}}"
    fee_span_detector_artifact_uri="${FEE_SPAN_DETECTOR_ARTIFACT_URI_STG:-${fee_span_detector_artifact_uri}}"
    fee_whitebox_thresholds_path="${FEE_WHITEBOX_THRESHOLDS_PATH_STG:-${fee_whitebox_thresholds_path}}"
    fee_extraction_feedback_hmac_key_version="${FEE_EXTRACTION_FEEDBACK_HMAC_KEY_VERSION_STG:-${fee_extraction_feedback_hmac_key_version}}"
  else
    sidecar_enabled="${HOMIS_SIDECAR_ENABLED_PROD:-${sidecar_enabled:-${PROD_HOMIS_SIDECAR_ENABLED_DEFAULT}}}"
    sidecar_allowed_extension_ids="${HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS_PROD:-${sidecar_allowed_extension_ids:-${PROD_HOMIS_SIDECAR_EXTENSION_IDS_DEFAULT}}}"
    sidecar_allowed_selector_contract_versions="${HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS_PROD:-${sidecar_allowed_selector_contract_versions:-${PROD_HOMIS_SIDECAR_SELECTOR_CONTRACTS_DEFAULT}}}"
    sidecar_revoked_device_ids="${HOMIS_SIDECAR_REVOKED_DEVICE_IDS_PROD:-${sidecar_revoked_device_ids}}"
    sidecar_draft_retention_days="${HOMIS_SIDECAR_DRAFT_RETENTION_DAYS_PROD:-${sidecar_draft_retention_days}}"
    sidecar_grant_ttl_hours="${HOMIS_SIDECAR_GRANT_TTL_HOURS_PROD:-${sidecar_grant_ttl_hours}}"
    fee_extraction_memo="${FEE_EXTRACTION_MEMO_PROD:-${fee_extraction_memo}}"
    fee_standing_facts="${FEE_STANDING_FACTS_PROD:-${fee_standing_facts}}"
    fee_empty_extraction_retry="${FEE_EMPTY_EXTRACTION_RETRY_PROD:-false}"
    fee_extraction_snapshot_retention_days="${FEE_EXTRACTION_SNAPSHOT_RETENTION_DAYS_PROD:-${fee_extraction_snapshot_retention_days}}"
    fee_monthly_exclusion_mode="${FEE_MONTHLY_EXCLUSION_MODE_PROD:-${fee_monthly_exclusion_mode}}"
    fee_clinical_extraction_strategy="${FEE_CLINICAL_EXTRACTION_STRATEGY_PROD:-${fee_clinical_extraction_strategy}}"
    fee_extraction_coverage_mode="${FEE_EXTRACTION_COVERAGE_MODE_PROD:-${fee_extraction_coverage_mode}}"
    fee_extraction_coverage_max_lines="${FEE_EXTRACTION_COVERAGE_MAX_LINES_PROD:-${fee_extraction_coverage_max_lines}}"
    fee_extraction_coverage_max_spans="${FEE_EXTRACTION_COVERAGE_MAX_SPANS_PROD:-${fee_extraction_coverage_max_spans}}"
    fee_extraction_coverage_timeout_ms="${FEE_EXTRACTION_COVERAGE_TIMEOUT_MS_PROD:-${fee_extraction_coverage_timeout_ms}}"
    fee_extraction_coverage_facility_allowlist="${FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST_PROD:-${fee_extraction_coverage_facility_allowlist}}"
    fee_linker_mode="${FEE_LINKER_MODE_PROD:-${fee_linker_mode}}"
    fee_context_classifier_mode="${FEE_CONTEXT_CLASSIFIER_MODE_PROD:-${fee_context_classifier_mode}}"
    fee_span_detector_mode="${FEE_SPAN_DETECTOR_MODE_PROD:-${fee_span_detector_mode}}"
    fee_extraction_feedback_mode="${FEE_EXTRACTION_FEEDBACK_MODE_PROD:-${fee_extraction_feedback_mode}}"
    fee_linker_manifest_path="${FEE_LINKER_MANIFEST_PATH_PROD:-${fee_linker_manifest_path}}"
    fee_context_classifier_manifest_path="${FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH_PROD:-${fee_context_classifier_manifest_path}}"
    fee_span_detector_manifest_path="${FEE_SPAN_DETECTOR_MANIFEST_PATH_PROD:-${fee_span_detector_manifest_path}}"
    fee_linker_artifact_uri="${FEE_LINKER_ARTIFACT_URI_PROD:-${fee_linker_artifact_uri}}"
    fee_context_classifier_artifact_uri="${FEE_CONTEXT_CLASSIFIER_ARTIFACT_URI_PROD:-${fee_context_classifier_artifact_uri}}"
    fee_span_detector_artifact_uri="${FEE_SPAN_DETECTOR_ARTIFACT_URI_PROD:-${fee_span_detector_artifact_uri}}"
    fee_whitebox_thresholds_path="${FEE_WHITEBOX_THRESHOLDS_PATH_PROD:-${fee_whitebox_thresholds_path}}"
    fee_extraction_feedback_hmac_key_version="${FEE_EXTRACTION_FEEDBACK_HMAC_KEY_VERSION_PROD:-${fee_extraction_feedback_hmac_key_version}}"
  fi

  if [[ "${sidecar_enabled}" != "true" && "${sidecar_enabled}" != "false" ]]; then
    echo "HOMIS_SIDECAR_ENABLED_${env^^} must be true or false." >&2
    return 1
  fi
  if [[ "${fee_extraction_memo}" != "true" && "${fee_extraction_memo}" != "false" ]]; then
    echo "FEE_EXTRACTION_MEMO_${env^^} must be true or false." >&2
    return 1
  fi
  if [[ "${fee_standing_facts}" != "true" && "${fee_standing_facts}" != "false" ]]; then
    echo "FEE_STANDING_FACTS_${env^^} must be true or false." >&2
    return 1
  fi
  if [[ "${fee_empty_extraction_retry}" != "true" && "${fee_empty_extraction_retry}" != "false" ]]; then
    echo "FEE_EMPTY_EXTRACTION_RETRY_${env^^} must be true or false." >&2
    return 1
  fi
  if [[ ! "${fee_extraction_snapshot_retention_days}" =~ ^[0-9]+$ ]] \
    || (( fee_extraction_snapshot_retention_days < 1 || fee_extraction_snapshot_retention_days > 90 )); then
    echo "Fee extraction snapshot retention for ${env} must be an integer from 1 to 90 days." >&2
    return 1
  fi
  if [[ "${fee_monthly_exclusion_mode}" != "off" \
    && "${fee_monthly_exclusion_mode}" != "shadow" \
    && "${fee_monthly_exclusion_mode}" != "enforce" ]]; then
    echo "FEE_MONTHLY_EXCLUSION_MODE for ${env} must be off, shadow, or enforce." >&2
    return 1
  fi
  if [[ "${fee_clinical_extraction_strategy}" != "openai_primary" \
    && "${fee_clinical_extraction_strategy}" != "whitebox_experiment" ]]; then
    echo "FEE_CLINICAL_EXTRACTION_STRATEGY for ${env} must be openai_primary or whitebox_experiment." >&2
    return 1
  fi
  if [[ "${env}" == "prod" && "${fee_clinical_extraction_strategy}" == "whitebox_experiment" ]]; then
    echo "Refusing deploy: whitebox_experiment cannot be enabled in prod." >&2
    return 1
  fi
  if [[ "${fee_extraction_coverage_mode}" != "off" \
    && "${fee_extraction_coverage_mode}" != "observe" \
    && "${fee_extraction_coverage_mode}" != "verify" ]]; then
    echo "FEE_EXTRACTION_COVERAGE_MODE for ${env} must be off, observe, or verify." >&2
    return 1
  fi
  if [[ ! "${fee_extraction_coverage_max_lines}" =~ ^[0-9]+$ ]] \
    || (( fee_extraction_coverage_max_lines < 1 || fee_extraction_coverage_max_lines > 16 )); then
    echo "FEE_EXTRACTION_COVERAGE_MAX_LINES for ${env} must be an integer from 1 to 16." >&2
    return 1
  fi
  if [[ ! "${fee_extraction_coverage_max_spans}" =~ ^[0-9]+$ ]] \
    || (( fee_extraction_coverage_max_spans < 1 || fee_extraction_coverage_max_spans > 32 )); then
    echo "FEE_EXTRACTION_COVERAGE_MAX_SPANS for ${env} must be an integer from 1 to 32." >&2
    return 1
  fi
  if [[ ! "${fee_extraction_coverage_timeout_ms}" =~ ^[0-9]+$ ]] \
    || (( fee_extraction_coverage_timeout_ms < 100 || fee_extraction_coverage_timeout_ms > 30000 )); then
    echo "FEE_EXTRACTION_COVERAGE_TIMEOUT_MS for ${env} must be an integer from 100 to 30000." >&2
    return 1
  fi
  if [[ "${fee_linker_mode}" != "off" \
    && "${fee_linker_mode}" != "shadow" \
    && "${fee_linker_mode}" != "propose" ]]; then
    echo "FEE_LINKER_MODE for ${env} must be off, shadow, or propose." >&2
    return 1
  fi
  if [[ "${fee_context_classifier_mode}" != "off" \
    && "${fee_context_classifier_mode}" != "shadow" \
    && "${fee_context_classifier_mode}" != "assist" ]]; then
    echo "FEE_CONTEXT_CLASSIFIER_MODE for ${env} must be off, shadow, or assist." >&2
    return 1
  fi
  if [[ "${fee_span_detector_mode}" != "off" \
    && "${fee_span_detector_mode}" != "shadow" \
    && "${fee_span_detector_mode}" != "route" ]]; then
    echo "FEE_SPAN_DETECTOR_MODE for ${env} must be off, shadow, or route." >&2
    return 1
  fi
  if [[ "${fee_extraction_feedback_mode}" != "off" \
    && "${fee_extraction_feedback_mode}" != "collect" ]]; then
    echo "FEE_EXTRACTION_FEEDBACK_MODE for ${env} must be off or collect." >&2
    return 1
  fi
  if [[ "${fee_span_detector_mode}" == "route" \
    && ( "${fee_linker_mode}" != "propose" || "${fee_context_classifier_mode}" != "assist" ) ]]; then
    echo "FEE_SPAN_DETECTOR_MODE=route requires FEE_LINKER_MODE=propose and FEE_CONTEXT_CLASSIFIER_MODE=assist for ${env}." >&2
    return 1
  fi
  if [[ "${fee_extraction_coverage_mode}" != "off" ]]; then
    if [[ "${fee_clinical_extraction_strategy}" != "openai_primary" ]]; then
      echo "Extraction coverage for ${env} requires FEE_CLINICAL_EXTRACTION_STRATEGY=openai_primary." >&2
      return 1
    fi
    if [[ "${fee_span_detector_mode}" != "shadow" ]]; then
      echo "Extraction coverage for ${env} requires FEE_SPAN_DETECTOR_MODE=shadow." >&2
      return 1
    fi
    if [[ "${fee_linker_mode}" != "off" || "${fee_context_classifier_mode}" != "off" ]]; then
      echo "Extraction coverage for ${env} requires linker and context classifier modes to be off." >&2
      return 1
    fi
    if [[ -z "${fee_extraction_coverage_facility_allowlist}" ]]; then
      echo "Extraction coverage for ${env} requires a non-empty facility allowlist." >&2
      return 1
    fi
  fi
  if [[ "${fee_linker_mode}" != "off" && -z "${fee_linker_manifest_path}" ]]; then
    echo "FEE_LINKER_MANIFEST_PATH is required when linker mode is enabled for ${env}." >&2
    return 1
  fi
  if [[ "${fee_context_classifier_mode}" != "off" && -z "${fee_context_classifier_manifest_path}" ]]; then
    echo "FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH is required when context classifier mode is enabled for ${env}." >&2
    return 1
  fi
  if [[ "${fee_span_detector_mode}" != "off" && -z "${fee_span_detector_manifest_path}" ]]; then
    echo "FEE_SPAN_DETECTOR_MANIFEST_PATH is required when span detector mode is enabled for ${env}." >&2
    return 1
  fi
  if [[ "${fee_linker_mode}" != "off" ]]; then
    validate_packaged_fee_artifact_reference \
      "${fee_linker_manifest_path}" \
      "${fee_linker_artifact_uri}" \
      "fee_master_linker" \
      "FEE_LINKER_MANIFEST_PATH for ${env}" || return 1
  fi
  if [[ "${fee_context_classifier_mode}" != "off" ]]; then
    validate_packaged_fee_artifact_reference \
      "${fee_context_classifier_manifest_path}" \
      "${fee_context_classifier_artifact_uri}" \
      "fee_context_classifier" \
      "FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH for ${env}" || return 1
  fi
  if [[ "${fee_span_detector_mode}" != "off" ]]; then
    validate_packaged_fee_artifact_reference \
      "${fee_span_detector_manifest_path}" \
      "${fee_span_detector_artifact_uri}" \
      "fee_span_detector" \
      "FEE_SPAN_DETECTOR_MANIFEST_PATH for ${env}" || return 1
  fi
  if [[ -n "${fee_whitebox_thresholds_path}" ]]; then
    validate_packaged_fee_file_path \
      "${fee_whitebox_thresholds_path}" \
      "FEE_WHITEBOX_THRESHOLDS_PATH for ${env}" || return 1
  fi
  if [[ "${fee_extraction_feedback_mode}" == "collect" ]] \
    && ! secret_exists "${fee_project}" "FEE_EXTRACTION_FEEDBACK_HMAC_SECRET"; then
    echo "FEE_EXTRACTION_FEEDBACK_MODE=collect requires FEE_EXTRACTION_FEEDBACK_HMAC_SECRET in ${fee_project}." >&2
    return 1
  fi

  if [[ "${sidecar_enabled}" == "true" ]]; then
    if [[ -z "${sidecar_allowed_extension_ids}" ]]; then
      echo "HOMIS Sidecar is enabled for ${env}, but HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS_${env^^} is empty." >&2
      return 1
    fi
    local sidecar_extension_id
    while IFS= read -r sidecar_extension_id; do
      [[ -z "${sidecar_extension_id}" ]] && continue
      if [[ ! "${sidecar_extension_id}" =~ ^[a-p]{32}$ ]]; then
        echo "HOMIS Sidecar extension ID '${sidecar_extension_id}' is invalid for ${env}." >&2
        return 1
      fi
    done < <(printf '%s' "${sidecar_allowed_extension_ids}" | tr ',;[:space:]' '\n' | sed '/^$/d')
    if [[ -z "${sidecar_allowed_selector_contract_versions}" ]]; then
      echo "HOMIS Sidecar is enabled for ${env}, but HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS_${env^^} is empty." >&2
      return 1
    fi
    if [[ ! "${sidecar_draft_retention_days}" =~ ^[0-9]+$ ]] \
      || (( sidecar_draft_retention_days < 1 || sidecar_draft_retention_days > 90 )); then
      echo "HOMIS Sidecar retention for ${env} must be an integer from 1 to 90 days." >&2
      return 1
    fi
    if [[ ! "${sidecar_grant_ttl_hours}" =~ ^[0-9]+$ ]] \
      || (( sidecar_grant_ttl_hours < 1 || sidecar_grant_ttl_hours > 8760 )); then
      echo "HOMIS Sidecar grant TTL for ${env} must be an integer from 1 to 8760 hours." >&2
      return 1
    fi
    if [[ "${APPLY}" == "true" ]] && ! secret_exists "${core_project}" "APP_FIELD_ENCRYPTION_KEY"; then
      echo "HOMIS Sidecar is enabled for ${env}, but APP_FIELD_ENCRYPTION_KEY is missing in ${core_project}." >&2
      return 1
    fi
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
    "HOMIS_SIDECAR_ENABLED=${sidecar_enabled}" \
    "HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS=${sidecar_allowed_extension_ids}" \
    "HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS=${sidecar_allowed_selector_contract_versions}" \
    "HOMIS_SIDECAR_REVOKED_DEVICE_IDS=${sidecar_revoked_device_ids}" \
    "HOMIS_SIDECAR_GRANT_TTL_HOURS=${sidecar_grant_ttl_hours}" \
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

  if should_deploy "${env}" "care-fee-api"; then
    deploy_service "${care_project}" "care-fee-api-${env}" "services/care-fee-api" "halunasu-care-fee-api" "public" \
    "HALUNASU_ENV=${env}" \
    "GOOGLE_CLOUD_PROJECT=${care_project}" \
    "CARE_FEE_GOOGLE_CLOUD_PROJECT=${care_project}" \
    "PLATFORM_GOOGLE_CLOUD_PROJECT=${core_project}" \
    "GOOGLE_CLOUD_REGION=${REGION}" \
    "CARE_FEE_STORE_BACKEND=firestore" \
    "PLATFORM_STORE_BACKEND=firestore" \
    "CARE_FEE_MAX_CSV_BYTES=10485760" \
    "CARE_FEE_MAX_JSON_BYTES=15728640" \
    "CARE_FEE_IMPORT_RETENTION_DAYS=30" \
    "CARE_FEE_MONTHLY_WORKER_AUTH_MODE=token" \
    "APP_SESSION_COOKIE_NAME=${session_cookie_name}" \
    "APP_CSRF_COOKIE_NAME=${csrf_cookie_name}"
  fi

  if should_deploy "${env}" "fee-api"; then
    fee_calculation_queue_path=""
    fee_calculation_worker_url=""
    fee_queue_max_concurrent="${FEE_CALCULATION_QUEUE_MAX_CONCURRENT_DISPATCHES:-3}"
    fee_queue_max_rate="${FEE_CALCULATION_QUEUE_MAX_DISPATCHES_PER_SECOND:-2}"
    care_fee_ingest_url="${CARE_FEE_INGEST_URL:-}"
    if [[ -z "${care_fee_ingest_url}" && "${APPLY}" == "true" ]]; then
      care_fee_service_url="$(gcloud run services describe "care-fee-api-${env}" --project "${care_project}" --region "${REGION}" --format="value(status.url)" --quiet 2>/dev/null || true)"
      if [[ -n "${care_fee_service_url}" ]]; then
        care_fee_ingest_url="${care_fee_service_url}/v1/care-fee/internal/evidence"
      fi
    fi
    if secret_exists "${fee_project}" "fee-calculation-worker-token"; then
      fee_calculation_queue_path="${FEE_CALCULATION_CLOUD_TASKS_QUEUE:-projects/${fee_project}/locations/${REGION}/queues/fee-calculation-${env}}"
      fee_calculation_queue_id="fee-calculation-${env}"
      if [[ "${APPLY}" == "true" ]]; then
        if gcloud tasks queues describe "${fee_calculation_queue_id}" --project "${fee_project}" --location "${REGION}" --quiet >/dev/null 2>&1; then
          run_or_print gcloud tasks queues update "${fee_calculation_queue_id}" \
            --project "${fee_project}" \
            --location "${REGION}" \
            --max-concurrent-dispatches "${fee_queue_max_concurrent}" \
            --max-dispatches-per-second "${fee_queue_max_rate}" \
            --quiet
        else
          run_or_print gcloud tasks queues create "${fee_calculation_queue_id}" \
            --project "${fee_project}" \
            --location "${REGION}" \
            --max-concurrent-dispatches "${fee_queue_max_concurrent}" \
            --max-dispatches-per-second "${fee_queue_max_rate}" \
            --quiet
        fi
      else
        run_or_print gcloud tasks queues update "${fee_calculation_queue_id}" \
          --project "${fee_project}" \
          --location "${REGION}" \
          --max-concurrent-dispatches "${fee_queue_max_concurrent}" \
          --max-dispatches-per-second "${fee_queue_max_rate}" \
          --quiet
      fi
      fee_calculation_worker_url="${FEE_CALCULATION_WORKER_URL:-}"
      if [[ -z "${fee_calculation_worker_url}" ]] && [[ "${APPLY}" == "true" ]]; then
        fee_service_url="$(gcloud run services describe "fee-api-${env}" --project "${fee_project}" --region "${REGION}" --format="value(status.url)" --quiet 2>/dev/null || true)"
        if [[ -n "${fee_service_url}" ]]; then
          fee_calculation_worker_url="${fee_service_url}/v1/fee/internal/calculation-jobs/run"
        fi
      fi
      if [[ -z "${fee_calculation_worker_url}" ]] && [[ "${APPLY}" != "true" ]]; then
        fee_calculation_worker_url="https://fee-api-${env}-set-after-first-deploy/v1/fee/internal/calculation-jobs/run"
      elif [[ -z "${fee_calculation_worker_url}" ]]; then
        echo "fee-api-${env}: existing service URL not found; async calculation queue env will not be set on this deploy."
        fee_calculation_queue_path=""
      fi
    else
      echo "fee-api-${env}: fee-calculation-worker-token secret is missing; async calculation queue env will not be set."
    fi
    FEE_BUILD_LINKER_ARTIFACT_URI="${fee_linker_artifact_uri}" \
    FEE_BUILD_LINKER_MANIFEST_PATH="${fee_linker_manifest_path}" \
    FEE_BUILD_CONTEXT_CLASSIFIER_ARTIFACT_URI="${fee_context_classifier_artifact_uri}" \
    FEE_BUILD_CONTEXT_CLASSIFIER_MANIFEST_PATH="${fee_context_classifier_manifest_path}" \
    FEE_BUILD_SPAN_DETECTOR_ARTIFACT_URI="${fee_span_detector_artifact_uri}" \
    FEE_BUILD_SPAN_DETECTOR_MANIFEST_PATH="${fee_span_detector_manifest_path}" \
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
    "FEE_MASTER_DB_MANIFEST_PATH=/app/python/data/master/standard-master.manifest.json" \
    "FEE_MASTER_DB_PREPARE_ON_START=true" \
    "OPENAI_FEE_CLINICAL_MODEL=${OPENAI_FEE_CLINICAL_MODEL:-gpt-5.4-nano}" \
    "OPENAI_FEE_CLINICAL_REASONING_EFFORT=${OPENAI_FEE_CLINICAL_REASONING_EFFORT:-low}" \
    "OPENAI_FEE_CLINICAL_TIMEOUT_MS=${OPENAI_FEE_CLINICAL_TIMEOUT_MS:-60000}" \
    "FEE_WHITEBOX_TIMEOUT_MS=${FEE_WHITEBOX_TIMEOUT_MS:-120000}" \
    "FEE_EXTRACTION_MEMO=${fee_extraction_memo}" \
    "FEE_STANDING_FACTS=${fee_standing_facts}" \
    "FEE_EMPTY_EXTRACTION_RETRY=${fee_empty_extraction_retry}" \
    "FEE_EXTRACTION_SNAPSHOT_RETENTION_DAYS=${fee_extraction_snapshot_retention_days}" \
    "FEE_MONTHLY_EXCLUSION_MODE=${fee_monthly_exclusion_mode}" \
    "FEE_CLINICAL_EXTRACTION_STRATEGY=${fee_clinical_extraction_strategy}" \
    "FEE_EXTRACTION_COVERAGE_MODE=${fee_extraction_coverage_mode}" \
    "FEE_EXTRACTION_COVERAGE_MAX_LINES=${fee_extraction_coverage_max_lines}" \
    "FEE_EXTRACTION_COVERAGE_MAX_SPANS=${fee_extraction_coverage_max_spans}" \
    "FEE_EXTRACTION_COVERAGE_TIMEOUT_MS=${fee_extraction_coverage_timeout_ms}" \
    "FEE_EXTRACTION_COVERAGE_FACILITY_ALLOWLIST=${fee_extraction_coverage_facility_allowlist}" \
    "FEE_LINKER_MODE=${fee_linker_mode}" \
    "FEE_CONTEXT_CLASSIFIER_MODE=${fee_context_classifier_mode}" \
    "FEE_SPAN_DETECTOR_MODE=${fee_span_detector_mode}" \
    "FEE_EXTRACTION_FEEDBACK_MODE=${fee_extraction_feedback_mode}" \
    "FEE_LINKER_MANIFEST_PATH=${fee_linker_manifest_path}" \
    "FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH=${fee_context_classifier_manifest_path}" \
    "FEE_SPAN_DETECTOR_MANIFEST_PATH=${fee_span_detector_manifest_path}" \
    "FEE_WHITEBOX_THRESHOLDS_PATH=${fee_whitebox_thresholds_path}" \
    "FEE_EXTRACTION_FEEDBACK_HMAC_KEY_VERSION=${fee_extraction_feedback_hmac_key_version}" \
    "HOMIS_SIDECAR_ENABLED=${sidecar_enabled}" \
    "HOMIS_SIDECAR_ALLOWED_EXTENSION_IDS=${sidecar_allowed_extension_ids}" \
    "HOMIS_SIDECAR_ALLOWED_SELECTOR_CONTRACT_VERSIONS=${sidecar_allowed_selector_contract_versions}" \
    "HOMIS_SIDECAR_REVOKED_DEVICE_IDS=${sidecar_revoked_device_ids}" \
    "HOMIS_SIDECAR_DRAFT_RETENTION_DAYS=${sidecar_draft_retention_days}" \
    "FEE_CALCULATION_CLOUD_TASKS_QUEUE=${fee_calculation_queue_path}" \
    "FEE_CALCULATION_WORKER_URL=${fee_calculation_worker_url}" \
    "CARE_FEE_INGEST_URL=${care_fee_ingest_url}" \
    "CARE_FEE_INGEST_TIMEOUT_MS=5000" \
    "CARE_FEE_OUTBOX_WORKER_AUTH_MODE=token" \
    "CARE_FEE_OUTBOX_RETENTION_DAYS=30" \
    "CARE_FEE_OUTBOX_DELIVERED_RETENTION_DAYS=7" \
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

  if [[ "${TARGET_SERVICE}" == "all" || "${TARGET_SERVICE}" == "platform-api" || "${TARGET_SERVICE}" == charting-* || "${TARGET_SERVICE}" == "fee-api" || "${TARGET_SERVICE}" == "care-fee-api" || "${TARGET_SERVICE}" == "referral-api" ]]; then
    run_or_print env TARGET_ENV="${env}" TARGET_SERVICE="${TARGET_SERVICE}" REGION="${REGION}" REPOSITORY="${REPOSITORY}" \
      bash scripts/p19_cleanup_runtime_artifacts.sh --apply
  fi
}

should_deploy() {
  local env="$1"
  local service="$2"
  [[ "${TARGET_ENV}" == "all" || "${TARGET_ENV}" == "${env}" ]] &&
    [[ "${TARGET_SERVICE}" == "all" || "${TARGET_SERVICE}" == "${service}" ]]
}

if [[ "${TARGET_ENV}" == "all" || "${TARGET_ENV}" == "stg" ]]; then
  deploy_env "stg" "medical-core-stg" "halunasu-charting-stg" "halunasu-fee-stg" "halunasu-referral-stg" "halunasu-care-stg"
fi
if [[ "${TARGET_ENV}" == "all" || "${TARGET_ENV}" == "prod" ]]; then
  deploy_env "prod" "medical-core-497610" "halunasu-charting-prod" "halunasu-fee-prod" "halunasu-referral-prod" "halunasu-care-prod"
fi

echo "Deploy script complete."
