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

BILLING_ACCOUNT_ID_PROD="${BILLING_ACCOUNT_ID_PROD:-${BILLING_ACCOUNT_ID:-01AF66-9333E9-4574D9}}"
BILLING_ACCOUNT_ID_STG="${BILLING_ACCOUNT_ID_STG:-017363-055589-E21116}"
REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-halunasu-services}"

CORE_STG="medical-core-stg"
CORE_PROD="medical-core-497610"
PRODUCT_PROJECTS=(
  "halunasu-charting-stg"
  "halunasu-charting-prod"
  "halunasu-fee-stg"
  "halunasu-fee-prod"
  "halunasu-referral-stg"
  "halunasu-referral-prod"
)
ALL_RUNTIME_PROJECTS=("${CORE_STG}" "${CORE_PROD}" "${PRODUCT_PROJECTS[@]}")
ACTIVE_RUNTIME_PROJECTS=()
SKIPPED_RUNTIME_PROJECTS=()

echo "P10 low-cost runtime project provisioning"
echo "Apply: ${APPLY}"
echo "Billing account STG: ${BILLING_ACCOUNT_ID_STG}"
echo "Billing account PROD: ${BILLING_ACCOUNT_ID_PROD}"
echo "Region: ${REGION}"
echo "Repository: ${REPOSITORY}"
echo
echo "Guardrails:"
echo "- no Terraform"
echo "- no Cloud Run minimum instances"
echo "- no Cloud Scheduler"
echo "- no Cloud SQL, GKE, VM, NAT, static IP, or Load Balancer"
echo "- creates only required APIs, Firestore, Artifact Registry, service accounts, minimal IAM, and runtime secrets"
echo

if [[ "${APPLY}" == "true" && "${P10_ALLOW_BILLING:-}" != "yes" ]]; then
  echo "Refusing to apply without P10_ALLOW_BILLING=yes" >&2
  exit 65
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH" >&2
  exit 127
fi

run_or_print() {
  if [[ "${APPLY}" == "true" ]]; then
    "$@"
  else
    printf 'DRY RUN:'
    printf ' %q' "$@"
    echo
  fi
}

project_number() {
  gcloud projects describe "$1" --format="value(projectNumber)" --quiet
}

billing_enabled() {
  gcloud billing projects describe "$1" --format="value(billingEnabled)" --quiet 2>/dev/null || true
}

billing_account_name() {
  gcloud billing projects describe "$1" --format="value(billingAccountName)" --quiet 2>/dev/null || true
}

target_billing_account() {
  local project="$1"
  if [[ "${project}" == "${CORE_STG}" || "${project}" == *-stg ]]; then
    printf '%s' "${BILLING_ACCOUNT_ID_STG}"
  else
    printf '%s' "${BILLING_ACCOUNT_ID_PROD}"
  fi
}

enable_services() {
  local project="$1"
  shift
  run_or_print gcloud services enable "$@" --project "${project}" --quiet
}

ensure_billing() {
  local project="$1"
  local current_account
  local target_account
  current_account="$(billing_account_name "${project}")"
  target_account="$(target_billing_account "${project}")"
  if [[ "${current_account}" == "billingAccounts/${target_account}" ]]; then
    echo "Billing already linked: ${project} -> ${target_account}"
    return 0
  fi
  if [[ "${APPLY}" == "true" ]]; then
    local output
    if output="$(gcloud billing projects link "${project}" --billing-account "${target_account}" --quiet 2>&1)"; then
      echo "${output}"
      return 0
    fi
    echo "WARN billing link failed for ${project}; skipping this project."
    echo "${output}"
    return 1
  fi
  run_or_print gcloud billing projects link "${project}" --billing-account "${target_account}" --quiet
  return 0
}

project_is_active() {
  local candidate="$1"
  local project
  for project in "${ACTIVE_RUNTIME_PROJECTS[@]}"; do
    if [[ "${candidate}" == "${project}" ]]; then
      return 0
    fi
  done
  return 1
}

ensure_artifact_repo() {
  local project="$1"
  if gcloud artifacts repositories describe "${REPOSITORY}" --project "${project}" --location "${REGION}" --quiet >/dev/null 2>&1; then
    echo "Artifact Registry already exists: ${project}/${REPOSITORY}"
    return
  fi
  run_or_print gcloud artifacts repositories create "${REPOSITORY}" \
    --project "${project}" \
    --location "${REGION}" \
    --repository-format docker \
    --description "Halunasu low-cost service images" \
    --quiet
}

ensure_firestore() {
  local project="$1"
  if gcloud firestore databases describe --database="(default)" --project "${project}" --quiet >/dev/null 2>&1; then
    echo "Firestore already exists: ${project}/(default)"
    return
  fi
  run_or_print gcloud firestore databases create \
    --database="(default)" \
    --project "${project}" \
    --location="${REGION}" \
    --type=firestore-native \
    --quiet
}

ensure_cloud_build_account_roles() {
  local project="$1"
  local number
  local member
  number="$(project_number "${project}")"
  member="serviceAccount:${number}-compute@developer.gserviceaccount.com"
  add_project_role "${project}" "${member}" roles/logging.logWriter
  add_project_role "${project}" "${member}" roles/artifactregistry.writer
  add_project_role "${project}" "${member}" roles/storage.objectViewer
}

ensure_service_account() {
  local project="$1"
  local account_id="$2"
  local display_name="$3"
  local email="${account_id}@${project}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${email}" --project "${project}" --quiet >/dev/null 2>&1; then
    echo "Service account already exists: ${email}"
    return
  fi
  run_or_print gcloud iam service-accounts create "${account_id}" \
    --project "${project}" \
    --display-name "${display_name}" \
    --quiet
}

add_project_role() {
  local project="$1"
  local member="$2"
  local role="$3"
  if [[ "${APPLY}" == "true" ]]; then
    local attempt
    local output
    for attempt in 1 2 3 4 5; do
      if output="$(gcloud projects add-iam-policy-binding "${project}" \
        --member "${member}" \
        --role "${role}" \
        --condition=None \
        --quiet 2>&1 >/dev/null)"; then
        echo "Ensured IAM: ${project} ${role} ${member}"
        return
      fi
      if grep -Eiq 'conflict|etag' <<<"${output}" && [[ "${attempt}" != "5" ]]; then
        sleep "${attempt}"
        continue
      fi
      echo "${output}" >&2
      return 1
    done
  else
    run_or_print gcloud projects add-iam-policy-binding "${project}" \
      --member "${member}" \
      --role "${role}" \
      --condition=None \
      --quiet
  fi
}

ensure_secret() {
  local project="$1"
  local secret="$2"
  if gcloud secrets describe "${secret}" --project "${project}" --quiet >/dev/null 2>&1; then
    echo "Secret already exists: ${project}/${secret}"
    return
  fi
  run_or_print gcloud secrets create "${secret}" \
    --project "${project}" \
    --replication-policy automatic \
    --quiet
}

add_secret_version() {
  local project="$1"
  local secret="$2"
  local value="$3"
  local enabled_count
  local enabled_versions
  enabled_versions="$(gcloud secrets versions list "${secret}" --project "${project}" --filter="state:enabled" --format="value(name)" --quiet 2>/dev/null || true)"
  if [[ -z "${enabled_versions}" ]]; then
    enabled_count="0"
  else
    enabled_count="$(wc -l <<<"${enabled_versions}" | tr -d " ")"
  fi
  if [[ "${enabled_count}" != "0" ]]; then
    echo "Secret already has enabled version: ${project}/${secret}"
    return
  fi
  if [[ "${APPLY}" == "true" ]]; then
    printf '%s' "${value}" | gcloud secrets versions add "${secret}" --project "${project}" --data-file=- --quiet >/dev/null
  else
    echo "DRY RUN: add secret version ${project}/${secret}"
  fi
}

secret_value_or_generate() {
  local project="$1"
  local secret="$2"
  if gcloud secrets versions access latest --secret="${secret}" --project="${project}" --quiet >/dev/null 2>&1; then
    gcloud secrets versions access latest --secret="${secret}" --project="${project}" --quiet
  else
    openssl rand -base64 48
  fi
}

core_services=(artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com iam.googleapis.com run.googleapis.com secretmanager.googleapis.com)
product_services=(artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com iam.googleapis.com run.googleapis.com secretmanager.googleapis.com storage.googleapis.com)
charting_services=("${product_services[@]}" cloudtasks.googleapis.com)

for project in "${ALL_RUNTIME_PROJECTS[@]}"; do
  echo "== Project: ${project} =="
  if ensure_billing "${project}"; then
    ACTIVE_RUNTIME_PROJECTS+=("${project}")
  else
    SKIPPED_RUNTIME_PROJECTS+=("${project}")
    continue
  fi
  if [[ "${project}" == halunasu-charting-* ]]; then
    enable_services "${project}" "${charting_services[@]}"
  elif [[ "${project}" == halunasu-* ]]; then
    enable_services "${project}" "${product_services[@]}"
  else
    enable_services "${project}" "${core_services[@]}"
  fi
  ensure_artifact_repo "${project}"
  ensure_firestore "${project}"
  ensure_cloud_build_account_roles "${project}"
done

ensure_service_account "${CORE_STG}" "halunasu-platform-api" "Halunasu Platform API"
ensure_service_account "${CORE_PROD}" "halunasu-platform-api" "Halunasu Platform API"

for env in stg prod; do
  if [[ "${env}" == "stg" ]]; then
    core_project="${CORE_STG}"
    charting_project="halunasu-charting-stg"
    fee_project="halunasu-fee-stg"
    referral_project="halunasu-referral-stg"
  else
    core_project="${CORE_PROD}"
    charting_project="halunasu-charting-prod"
    fee_project="halunasu-fee-prod"
    referral_project="halunasu-referral-prod"
  fi

  project_is_active "${charting_project}" && ensure_service_account "${charting_project}" "halunasu-charting-api" "Halunasu Charting API"
  project_is_active "${charting_project}" && ensure_service_account "${charting_project}" "halunasu-charting-gateway" "Halunasu Charting Gateway"
  project_is_active "${charting_project}" && ensure_service_account "${charting_project}" "halunasu-charting-finalize" "Halunasu Charting Finalize"
  project_is_active "${fee_project}" && ensure_service_account "${fee_project}" "halunasu-fee-api" "Halunasu Fee API"
  project_is_active "${referral_project}" && ensure_service_account "${referral_project}" "halunasu-referral-api" "Halunasu Referral API"

  session_secret="$(secret_value_or_generate "${core_project}" "APP_SESSION_SIGNING_SECRET")"
  maintenance_secret="$(secret_value_or_generate "${core_project}" "PLATFORM_MAINTENANCE_SECRET")"
  finalize_secret=""
  if project_is_active "${charting_project}"; then
    finalize_secret="$(secret_value_or_generate "${charting_project}" "CHARTING_FINALIZE_INTERNAL_SECRET")"
  fi

  for project in "${core_project}" "${charting_project}" "${fee_project}" "${referral_project}"; do
    if ! project_is_active "${project}"; then
      echo "Skipping secrets for inactive project: ${project}"
      continue
    fi
    ensure_secret "${project}" "APP_SESSION_SIGNING_SECRET"
    add_secret_version "${project}" "APP_SESSION_SIGNING_SECRET" "${session_secret}"
  done

  ensure_secret "${core_project}" "PLATFORM_MAINTENANCE_SECRET"
  add_secret_version "${core_project}" "PLATFORM_MAINTENANCE_SECRET" "${maintenance_secret}"
  ensure_secret "${core_project}" "APP_FIELD_ENCRYPTION_KEY"
  add_secret_version "${core_project}" "APP_FIELD_ENCRYPTION_KEY" "$(secret_value_or_generate "${core_project}" "APP_FIELD_ENCRYPTION_KEY")"

  if project_is_active "${charting_project}"; then
    ensure_secret "${charting_project}" "CHARTING_FINALIZE_INTERNAL_SECRET"
    add_secret_version "${charting_project}" "CHARTING_FINALIZE_INTERNAL_SECRET" "${finalize_secret}"
    ensure_secret "${charting_project}" "PAIRING_SIGNING_SECRET"
    add_secret_version "${charting_project}" "PAIRING_SIGNING_SECRET" "$(secret_value_or_generate "${charting_project}" "PAIRING_SIGNING_SECRET")"
    ensure_secret "${charting_project}" "APP_FIELD_ENCRYPTION_KEY"
    add_secret_version "${charting_project}" "APP_FIELD_ENCRYPTION_KEY" "$(secret_value_or_generate "${charting_project}" "APP_FIELD_ENCRYPTION_KEY")"
  fi

  add_project_role "${core_project}" "serviceAccount:halunasu-platform-api@${core_project}.iam.gserviceaccount.com" roles/datastore.user
  add_project_role "${core_project}" "serviceAccount:halunasu-platform-api@${core_project}.iam.gserviceaccount.com" roles/logging.logWriter
  add_project_role "${core_project}" "serviceAccount:halunasu-platform-api@${core_project}.iam.gserviceaccount.com" roles/secretmanager.secretAccessor

  for spec in \
    "${charting_project}:halunasu-charting-gateway" \
    "${charting_project}:halunasu-charting-api" \
    "${charting_project}:halunasu-charting-finalize" \
    "${fee_project}:halunasu-fee-api" \
    "${referral_project}:halunasu-referral-api"; do
    project="${spec%%:*}"
    account_id="${spec##*:}"
    if ! project_is_active "${project}"; then
      echo "Skipping IAM for inactive project: ${project}/${account_id}"
      continue
    fi
    member="serviceAccount:${account_id}@${project}.iam.gserviceaccount.com"
    add_project_role "${project}" "${member}" roles/datastore.user
    add_project_role "${project}" "${member}" roles/logging.logWriter
    add_project_role "${project}" "${member}" roles/secretmanager.secretAccessor
    add_project_role "${core_project}" "${member}" roles/datastore.user
  done
done

echo "Provisioning complete."
if [[ "${#SKIPPED_RUNTIME_PROJECTS[@]}" -gt 0 ]]; then
  echo "Skipped projects due to billing/link readiness:"
  printf ' - %s\n' "${SKIPPED_RUNTIME_PROJECTS[@]}"
fi
