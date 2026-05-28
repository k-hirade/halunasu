#!/usr/bin/env bash
set -uo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

CORE_PROJECTS=(
  "medical-core-stg"
  "medical-core-497610"
)

PRODUCT_PROJECTS=(
  "halunasu-charting-stg"
  "halunasu-charting-prod"
  "halunasu-fee-stg"
  "halunasu-fee-prod"
  "halunasu-referral-stg"
  "halunasu-referral-prod"
)

OLD_PROJECTS=(
  "medical-stg-493105"
  "medical-fee-calculation-stg"
  "medical-492407"
  "medical-fee-calculation"
)

failures=0
warnings=0

echo "P10 project split read-only preflight"
echo
echo "This script does not create projects, enable APIs, link billing, deploy services, create databases, create secrets, or create buckets."
echo

if ! command -v gcloud >/dev/null 2>&1; then
  echo "FAIL gcloud is not installed or not on PATH" >&2
  exit 127
fi

account="$(gcloud config get-value account 2>/dev/null || true)"
echo "Active gcloud account: ${account:-unknown}"
echo

project_state() {
  gcloud projects describe "$1" --format="value(lifecycleState)" --quiet 2>/dev/null
}

billing_enabled() {
  gcloud billing projects describe "$1" --format="value(billingEnabled)" --quiet 2>/dev/null
}

enabled_services() {
  gcloud services list --enabled --project "$1" --format="value(config.name)" --quiet 2>/dev/null
}

for project in "${CORE_PROJECTS[@]}"; do
  echo "## Core project: ${project}"
  state="$(project_state "${project}")"
  if [[ "${state}" == "ACTIVE" ]]; then
    echo "OK   lifecycleState=ACTIVE"
  else
    echo "FAIL expected ACTIVE, got ${state:-unknown}"
    failures=$((failures + 1))
  fi
  billing="$(billing_enabled "${project}")"
  echo "INFO billingEnabled=${billing:-unknown}"
  echo
done

for project in "${PRODUCT_PROJECTS[@]}"; do
  echo "## Product project shell: ${project}"
  state="$(project_state "${project}")"
  if [[ "${state}" == "ACTIVE" ]]; then
    echo "OK   lifecycleState=ACTIVE"
  else
    echo "FAIL expected ACTIVE, got ${state:-unknown}"
    failures=$((failures + 1))
  fi

  billing="$(billing_enabled "${project}")"
  echo "INFO billingEnabled=${billing:-unknown}"

  services="$(enabled_services "${project}")"
  for service in run.googleapis.com firestore.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com; do
    if grep -Fxq "${service}" <<<"${services}"; then
      echo "INFO runtime service enabled: ${service}"
    fi
  done
  echo
done

for project in "${OLD_PROJECTS[@]}"; do
  echo "## Old project: ${project}"
  state="$(project_state "${project}")"
  if [[ "${state}" == "DELETE_REQUESTED" ]]; then
    echo "OK   lifecycleState=DELETE_REQUESTED"
  else
    echo "FAIL expected DELETE_REQUESTED, got ${state:-unknown}"
    failures=$((failures + 1))
  fi
  echo
done

echo "Summary: ${failures} failure(s), ${warnings} warning(s)."
if [[ "${failures}" -gt 0 ]]; then
  exit 1
fi
