#!/usr/bin/env bash
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

APPLY="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY="true"
      shift
      ;;
    --help|-h)
      echo "Usage: TARGET_ENV=stg TARGET_SERVICE=fee-api $0 [--apply]" >&2
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-halunasu-services}"
TARGET_ENV="${TARGET_ENV:-stg}"
TARGET_SERVICE="${TARGET_SERVICE:-fee-api}"

STG_FEE_PROJECT="${STG_FEE_PROJECT:-halunasu-fee-stg}"
STG_CLOUDBUILD_BUCKETS="${STG_CLOUDBUILD_BUCKETS:-medical-core-stg_cloudbuild halunasu-charting-stg_cloudbuild halunasu-fee-stg_cloudbuild halunasu-referral-stg_cloudbuild}"

STG_ARTIFACT_KEEP_COUNT="${STG_ARTIFACT_KEEP_COUNT:-3}"
STG_ARTIFACT_DELETE_OLDER_THAN="${STG_ARTIFACT_DELETE_OLDER_THAN:-7d}"
STG_CLOUDBUILD_DELETE_AGE_DAYS="${STG_CLOUDBUILD_DELETE_AGE_DAYS:-3}"
STG_CLOUDBUILD_SOFT_DELETE_MODE="${STG_CLOUDBUILD_SOFT_DELETE_MODE:-clear}"
STG_CLOUDBUILD_SOFT_DELETE_DURATION="${STG_CLOUDBUILD_SOFT_DELETE_DURATION:-7d}"

ARTIFACT_WARN_GIB="${ARTIFACT_WARN_GIB:-5}"
CLOUDBUILD_WARN_GIB="${CLOUDBUILD_WARN_GIB:-2}"

run_or_print() {
  if [[ "${APPLY}" == "true" ]]; then
    "$@"
  else
    printf 'DRY RUN:'
    printf ' %q' "$@"
    echo
  fi
}

warn_gib() {
  local label="$1"
  local bytes="$2"
  local threshold_gib="$3"
  awk -v label="${label}" -v bytes="${bytes}" -v threshold="${threshold_gib}" '
    BEGIN {
      gib = bytes / 1024 / 1024 / 1024
      printf "%s: %.2f GiB\n", label, gib
      if (gib > threshold) {
        printf "WARNING: %s is above %.2f GiB\n", label, threshold
      }
    }
  '
}

write_artifact_cleanup_policy() {
  local policy_file="$1"
  cat > "${policy_file}" <<POLICY_JSON
[
  {
    "name": "keep-fee-api-stg-latest-${STG_ARTIFACT_KEEP_COUNT}",
    "action": {"type": "Keep"},
    "mostRecentVersions": {
      "packageNamePrefixes": ["fee-api-stg"],
      "keepCount": ${STG_ARTIFACT_KEEP_COUNT}
    }
  },
  {
    "name": "delete-fee-api-stg-older-than-${STG_ARTIFACT_DELETE_OLDER_THAN}",
    "action": {"type": "Delete"},
    "condition": {
      "tagState": "any",
      "packageNamePrefixes": ["fee-api-stg"],
      "olderThan": "${STG_ARTIFACT_DELETE_OLDER_THAN}"
    }
  }
]
POLICY_JSON
}

write_cloudbuild_lifecycle() {
  local lifecycle_file="$1"
  cat > "${lifecycle_file}" <<LIFECYCLE_JSON
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"age": ${STG_CLOUDBUILD_DELETE_AGE_DAYS}}
    }
  ]
}
LIFECYCLE_JSON
}

set_stg_artifact_cleanup_policy() {
  local policy_file="/tmp/halunasu-fee-stg-artifact-cleanup-policy.json"
  write_artifact_cleanup_policy "${policy_file}"
  echo "== Artifact Registry cleanup policy: ${STG_FEE_PROJECT}/${REPOSITORY} =="
  run_or_print gcloud artifacts repositories set-cleanup-policies "${REPOSITORY}" \
    --project "${STG_FEE_PROJECT}" \
    --location "${REGION}" \
    --policy "${policy_file}" \
    --quiet
  echo
}

prune_stg_fee_api_images_now() {
  local image_path="${REGION}-docker.pkg.dev/${STG_FEE_PROJECT}/${REPOSITORY}/fee-api-stg"
  echo "== Artifact Registry immediate prune: ${image_path}, keep latest ${STG_ARTIFACT_KEEP_COUNT} =="
  if [[ "${APPLY}" != "true" ]]; then
    echo "DRY RUN: would delete fee-api-stg images after the latest ${STG_ARTIFACT_KEEP_COUNT}"
    echo
    return
  fi

  local images_json="/tmp/halunasu-fee-stg-fee-api-images.json"
  gcloud artifacts docker images list "${image_path}" \
    --include-tags \
    --sort-by="~UPDATE_TIME" \
    --format=json \
    --quiet > "${images_json}"

  local delete_list="/tmp/halunasu-fee-stg-fee-api-delete-list.txt"
  jq -r --argjson keep "${STG_ARTIFACT_KEEP_COUNT}" '
    .[$keep:][]? | select(.package and .version) | "\(.package)@\(.version)"
  ' "${images_json}" > "${delete_list}"

  if [[ ! -s "${delete_list}" ]]; then
    echo "No fee-api-stg images to prune."
    echo
    return
  fi

  while IFS= read -r image_ref; do
    [[ -z "${image_ref}" ]] && continue
    gcloud artifacts docker images delete "${image_ref}" --delete-tags --quiet
  done < "${delete_list}"
  echo
}

set_stg_cloudbuild_lifecycle() {
  local lifecycle_file="/tmp/halunasu-stg-cloudbuild-lifecycle.json"
  write_cloudbuild_lifecycle "${lifecycle_file}"
  echo "== Cloud Build bucket lifecycle: delete objects older than ${STG_CLOUDBUILD_DELETE_AGE_DAYS} days =="
  local bucket
  for bucket in ${STG_CLOUDBUILD_BUCKETS}; do
    if [[ "${APPLY}" == "true" ]] && ! gcloud storage buckets describe "gs://${bucket}" --quiet >/dev/null 2>&1; then
      echo "Skipping missing bucket: gs://${bucket}"
      continue
    fi
    if [[ "${STG_CLOUDBUILD_SOFT_DELETE_MODE}" == "clear" ]]; then
      run_or_print gcloud storage buckets update "gs://${bucket}" \
        --lifecycle-file "${lifecycle_file}" \
        --clear-soft-delete \
        --quiet
    else
      run_or_print gcloud storage buckets update "gs://${bucket}" \
        --lifecycle-file "${lifecycle_file}" \
        --soft-delete-duration "${STG_CLOUDBUILD_SOFT_DELETE_DURATION}" \
        --quiet
    fi
  done
  echo
}

report_stg_sizes() {
  echo "== STG artifact/storage size check =="
  if [[ "${APPLY}" != "true" ]]; then
    echo "DRY RUN: size checks require --apply because gcloud may need live credentials."
    echo
    return
  fi

  local image_path="${REGION}-docker.pkg.dev/${STG_FEE_PROJECT}/${REPOSITORY}/fee-api-stg"
  local artifact_bytes
  artifact_bytes="$(gcloud artifacts docker images list "${image_path}" --include-tags --format=json --quiet \
    | jq '[.[].metadata.imageSizeBytes? // "0" | tonumber] | add // 0')"
  warn_gib "Artifact Registry fee-api-stg images" "${artifact_bytes}" "${ARTIFACT_WARN_GIB}"

  local bucket
  for bucket in ${STG_CLOUDBUILD_BUCKETS}; do
    if ! gcloud storage buckets describe "gs://${bucket}" --quiet >/dev/null 2>&1; then
      continue
    fi
    local bucket_bytes
    bucket_bytes="$(gcloud storage du --summarize "gs://${bucket}" 2>/dev/null | awk '{print $1 + 0}')"
    warn_gib "Cloud Build bucket gs://${bucket}" "${bucket_bytes}" "${CLOUDBUILD_WARN_GIB}"
  done
  echo
}

if [[ "${TARGET_ENV}" != "stg" ]]; then
  echo "Runtime artifact cleanup is intentionally aggressive only for STG. TARGET_ENV=${TARGET_ENV}; skipping."
  exit 0
fi

if [[ "${TARGET_SERVICE}" != "all" && "${TARGET_SERVICE}" != "fee-api" ]]; then
  echo "No runtime artifact cleanup target for TARGET_SERVICE=${TARGET_SERVICE}; skipping."
  exit 0
fi

echo "Runtime artifact cleanup"
echo "Apply: ${APPLY}"
echo "Target env: ${TARGET_ENV}"
echo "Target service: ${TARGET_SERVICE}"
echo "Artifact keep count: ${STG_ARTIFACT_KEEP_COUNT}"
echo "Artifact delete older than: ${STG_ARTIFACT_DELETE_OLDER_THAN}"
echo "Cloud Build delete age days: ${STG_CLOUDBUILD_DELETE_AGE_DAYS}"
echo "Cloud Build soft delete mode: ${STG_CLOUDBUILD_SOFT_DELETE_MODE}"
echo

set_stg_artifact_cleanup_policy
prune_stg_fee_api_images_now
set_stg_cloudbuild_lifecycle
report_stg_sizes

echo "Runtime artifact cleanup complete."
