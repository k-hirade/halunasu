#!/usr/bin/env bash
set -uo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-medical-core-stg}"
REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-halunasu-services}"
SERVICE_NAME="${SERVICE_NAME:-platform-api-stg}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-halunasu-platform-api@${PROJECT_ID}.iam.gserviceaccount.com}"
DATABASE_ID="${DATABASE_ID:-(default)}"

failures=0
warnings=0

if [[ "${PROJECT_ID}" != "medical-core-stg" ]]; then
  echo "FAIL PROJECT_ID must be medical-core-stg for P2 staging preflight."
  exit 65
fi

echo "P2 read-only preflight"
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Repository: ${REPOSITORY}"
echo "Cloud Run service: ${SERVICE_NAME}"
echo "Service account: ${SERVICE_ACCOUNT}"
echo

account="$(gcloud config get-value account 2>/dev/null)"
echo "Active gcloud account: ${account:-unknown}"
echo

check_required() {
  local label="$1"
  shift

  local output
  if output="$("$@" 2>&1)"; then
    echo "OK   ${label}"
  else
    echo "FAIL ${label}"
    echo "${output}"
    failures=$((failures + 1))
  fi
  echo
}

check_optional() {
  local label="$1"
  shift

  local output
  if output="$("$@" 2>&1)"; then
    echo "OK   ${label}"
    if [[ -n "${output}" ]]; then
      echo "${output}"
    fi
  else
    echo "WARN ${label}"
    echo "${output}"
    warnings=$((warnings + 1))
  fi
  echo
}

check_required "project access" \
  gcloud projects describe "${PROJECT_ID}" \
    --format="value(projectId)" \
    --quiet

billing_output="$(gcloud billing projects describe "${PROJECT_ID}" --format="value(billingEnabled)" --quiet 2>&1)"
billing_status=$?
if [[ "${billing_status}" -eq 0 && "${billing_output}" == "True" ]]; then
  echo "OK   billing enabled"
elif [[ "${billing_status}" -eq 0 ]]; then
  echo "FAIL billing enabled"
  echo "billingEnabled=${billing_output}"
  failures=$((failures + 1))
else
  echo "FAIL billing enabled"
  echo "${billing_output}"
  failures=$((failures + 1))
fi
echo

services_output="$(gcloud services list --enabled --project "${PROJECT_ID}" --format="value(config.name)" --quiet 2>&1)"
services_status=$?
if [[ "${services_status}" -eq 0 ]]; then
  echo "OK   enabled services list"
  for service in \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    firestore.googleapis.com \
    iam.googleapis.com \
    run.googleapis.com; do
    if grep -Fxq "${service}" <<<"${services_output}"; then
      echo "OK   service enabled: ${service}"
    else
      echo "FAIL service disabled: ${service}"
      failures=$((failures + 1))
    fi
  done
else
  echo "FAIL enabled services list"
  echo "${services_output}"
  failures=$((failures + 1))
fi
echo

check_required "Artifact Registry repository exists" \
  gcloud artifacts repositories describe "${REPOSITORY}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --format="value(name)" \
    --quiet

check_required "Cloud Run service account exists" \
  gcloud iam service-accounts describe "${SERVICE_ACCOUNT}" \
    --project "${PROJECT_ID}" \
    --format="value(email)" \
    --quiet

check_required "Firestore database exists" \
  gcloud firestore databases describe \
    --database="${DATABASE_ID}" \
    --project "${PROJECT_ID}" \
    --format="value(name)" \
    --quiet

check_optional "Cloud Run service state if already deployed" \
  gcloud run services describe "${SERVICE_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --format="value(status.url)" \
    --quiet

echo "Summary: ${failures} failure(s), ${warnings} warning(s)."
if [[ "${failures}" -gt 0 ]]; then
  exit 1
fi
