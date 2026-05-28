#!/usr/bin/env bash
set -uo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

REGION="${REGION:-asia-northeast1}"
DEFAULT_PROJECTS=(
  "medical-stg-493105"
  "medical-fee-calculation-stg"
  "medical-492407"
  "medical-fee-calculation"
)

PROJECTS=("$@")
if [[ "${#PROJECTS[@]}" -eq 0 ]]; then
  PROJECTS=("${DEFAULT_PROJECTS[@]}")
fi

echo "P9 old environment read-only inventory"
echo "Region: ${REGION}"
echo "Projects: ${PROJECTS[*]}"
echo
echo "This script only reads metadata. It does not create backups, buckets, exports, services, secrets, or IAM bindings."
echo

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH" >&2
  exit 127
fi

account="$(gcloud config get-value account 2>/dev/null || true)"
echo "Active gcloud account: ${account:-unknown}"
echo

run_optional() {
  local label="$1"
  shift

  echo "## ${label}"
  local output
  if output="$("$@" 2>&1)"; then
    if [[ -n "${output}" ]]; then
      echo "${output}"
    else
      echo "(empty)"
    fi
  else
    echo "WARN: ${label} failed"
    echo "${output}"
  fi
  echo
}

for project in "${PROJECTS[@]}"; do
  echo "============================================================"
  echo "Project: ${project}"
  echo "============================================================"
  echo

  run_optional "Project metadata" \
    gcloud projects describe "${project}" \
      --format="table(projectId,name,projectNumber,lifecycleState)" \
      --quiet

  run_optional "Billing status" \
    gcloud billing projects describe "${project}" \
      --format="table(projectId,billingEnabled)" \
      --quiet

  run_optional "Enabled services relevant to shutdown" \
    gcloud services list \
      --enabled \
      --project "${project}" \
      --filter="config.name:(run.googleapis.com firestore.googleapis.com appengine.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com secretmanager.googleapis.com firebase.googleapis.com)" \
      --format="table(config.name)" \
      --quiet

  run_optional "Cloud Run services" \
    gcloud run services list \
      --project "${project}" \
      --region "${REGION}" \
      --format="table(metadata.name,status.url)" \
      --quiet

  run_optional "Firestore databases" \
    gcloud firestore databases list \
      --project "${project}" \
      --format="table(name,locationId,type,deleteProtectionState)" \
      --quiet

  run_optional "Secret names only" \
    gcloud secrets list \
      --project "${project}" \
      --format="table(name.basename(),replication.policy)" \
      --quiet

  run_optional "Artifact Registry repositories" \
    gcloud artifacts repositories list \
      --project "${project}" \
      --location "${REGION}" \
      --format="table(name,format,sizeBytes)" \
      --quiet

  run_optional "Storage buckets" \
    gcloud storage buckets list \
      --project "${project}" \
      --format="table(name,location,storageClass)" \
      --quiet
done

echo "Inventory complete."
echo "If you need a persistent record, re-run with shell redirection or tee into a local audit file."
