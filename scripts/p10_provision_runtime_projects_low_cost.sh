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

BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-01AF66-9333E9-4574D9}"
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

echo "P10 low-cost runtime project provisioning"
echo "Apply: ${APPLY}"
echo "Billing account: ${BILLING_ACCOUNT_ID}"
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

enable_services() {
  local project="$1"
  shift
  run_or_print gcloud services enable "$@" --project "${project}" --quiet
}

ensure_billing() {
  local project="$1"
  local billing
  billing="$(billing_enabled "${project}")"
  if [[ "${billing}" == "True" ]]; then
    echo "Billing already linked: ${project}"
    return
  fi
  run_or_print gcloud billing projects link "${project}" --billing-account "${BILLING_ACCOUNT_ID}" --quiet
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
  run_or_print gcloud projects add-iam-policy-binding "${project}" \
    --member "${member}" \
    --role "${role}" \
    --condition=None \
    --quiet
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
  ensure_billing "${project}"
  if [[ "${project}" == halunasu-charting-* ]]; then
    enable_services "${project}" "${charting_services[@]}"
  elif [[ "${project}" == halunasu-* ]]; then
    enable_services "${project}" "${product_services[@]}"
  else
    enable_services "${project}" "${core_services[@]}"
  fi
  ensure_artifact_repo "${project}"
  ensure_firestore "${project}"
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

  ensure_service_account "${charting_project}" "halunasu-charting-api" "Halunasu Charting API"
  ensure_service_account "${charting_project}" "halunasu-charting-finalize" "Halunasu Charting Finalize"
  ensure_service_account "${fee_project}" "halunasu-fee-api" "Halunasu Fee API"
  ensure_service_account "${referral_project}" "halunasu-referral-api" "Halunasu Referral API"

  session_secret="$(secret_value_or_generate "${core_project}" "APP_SESSION_SIGNING_SECRET")"
  finalize_secret="$(secret_value_or_generate "${charting_project}" "CHARTING_FINALIZE_INTERNAL_SECRET")"

  for project in "${core_project}" "${charting_project}" "${fee_project}" "${referral_project}"; do
    ensure_secret "${project}" "APP_SESSION_SIGNING_SECRET"
    add_secret_version "${project}" "APP_SESSION_SIGNING_SECRET" "${session_secret}"
  done

  ensure_secret "${charting_project}" "CHARTING_FINALIZE_INTERNAL_SECRET"
  add_secret_version "${charting_project}" "CHARTING_FINALIZE_INTERNAL_SECRET" "${finalize_secret}"

  add_project_role "${core_project}" "serviceAccount:halunasu-platform-api@${core_project}.iam.gserviceaccount.com" roles/datastore.user
  add_project_role "${core_project}" "serviceAccount:halunasu-platform-api@${core_project}.iam.gserviceaccount.com" roles/logging.logWriter
  add_project_role "${core_project}" "serviceAccount:halunasu-platform-api@${core_project}.iam.gserviceaccount.com" roles/secretmanager.secretAccessor

  for spec in \
    "${charting_project}:halunasu-charting-api" \
    "${charting_project}:halunasu-charting-finalize" \
    "${fee_project}:halunasu-fee-api" \
    "${referral_project}:halunasu-referral-api"; do
    project="${spec%%:*}"
    account_id="${spec##*:}"
    member="serviceAccount:${account_id}@${project}.iam.gserviceaccount.com"
    add_project_role "${project}" "${member}" roles/datastore.user
    add_project_role "${project}" "${member}" roles/logging.logWriter
    add_project_role "${project}" "${member}" roles/secretmanager.secretAccessor
    add_project_role "${core_project}" "${member}" roles/datastore.user
  done
done

echo "Provisioning complete."
