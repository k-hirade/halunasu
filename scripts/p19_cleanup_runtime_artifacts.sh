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
      echo "Usage: TARGET_ENV=stg|prod|all TARGET_SERVICE=all $0 [--apply]" >&2
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
TARGET_SERVICE="${TARGET_SERVICE:-all}"

STG_ARTIFACT_KEEP_COUNT="${STG_ARTIFACT_KEEP_COUNT:-3}"
STG_ARTIFACT_DELETE_OLDER_THAN="${STG_ARTIFACT_DELETE_OLDER_THAN:-7d}"
STG_CLOUDBUILD_DELETE_AGE_DAYS="${STG_CLOUDBUILD_DELETE_AGE_DAYS:-3}"
STG_CLOUDBUILD_SOFT_DELETE_MODE="${STG_CLOUDBUILD_SOFT_DELETE_MODE:-clear}"
STG_CLOUDBUILD_SOFT_DELETE_DURATION="${STG_CLOUDBUILD_SOFT_DELETE_DURATION:-7d}"

PROD_ARTIFACT_KEEP_COUNT="${PROD_ARTIFACT_KEEP_COUNT:-30}"
PROD_ARTIFACT_DELETE_OLDER_THAN="${PROD_ARTIFACT_DELETE_OLDER_THAN:-90d}"
PROD_CLOUDBUILD_DELETE_AGE_DAYS="${PROD_CLOUDBUILD_DELETE_AGE_DAYS:-30}"
PROD_CLOUDBUILD_SOFT_DELETE_MODE="${PROD_CLOUDBUILD_SOFT_DELETE_MODE:-duration}"
PROD_CLOUDBUILD_SOFT_DELETE_DURATION="${PROD_CLOUDBUILD_SOFT_DELETE_DURATION:-7d}"

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

env_selected() {
  local env="$1"
  [[ "${TARGET_ENV}" == "all" || "${TARGET_ENV}" == "${env}" ]]
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

project_prefixes_for_env() {
  local env="$1"
  case "${env}" in
    stg)
      printf '%s|%s\n' "medical-core-stg" "platform-api-stg"
      printf '%s|%s\n' "halunasu-charting-stg" "charting-gateway-stg charting-api-stg charting-finalize-stg"
      printf '%s|%s\n' "halunasu-fee-stg" "fee-api-stg"
      printf '%s|%s\n' "halunasu-referral-stg" "referral-api-stg"
      ;;
    prod)
      printf '%s|%s\n' "medical-core-497610" "platform-api-prod"
      printf '%s|%s\n' "halunasu-charting-prod" "charting-gateway-prod charting-api-prod charting-finalize-prod"
      printf '%s|%s\n' "halunasu-fee-prod" "fee-api-prod"
      printf '%s|%s\n' "halunasu-referral-prod" "referral-api-prod"
      ;;
    *)
      echo "Unknown env: ${env}" >&2
      exit 65
      ;;
  esac
}

artifact_keep_count_for_env() {
  local env="$1"
  if [[ "${env}" == "prod" ]]; then
    echo "${PROD_ARTIFACT_KEEP_COUNT}"
  else
    echo "${STG_ARTIFACT_KEEP_COUNT}"
  fi
}

artifact_delete_older_than_for_env() {
  local env="$1"
  if [[ "${env}" == "prod" ]]; then
    echo "${PROD_ARTIFACT_DELETE_OLDER_THAN}"
  else
    echo "${STG_ARTIFACT_DELETE_OLDER_THAN}"
  fi
}

cloudbuild_delete_age_for_env() {
  local env="$1"
  if [[ "${env}" == "prod" ]]; then
    echo "${PROD_CLOUDBUILD_DELETE_AGE_DAYS}"
  else
    echo "${STG_CLOUDBUILD_DELETE_AGE_DAYS}"
  fi
}

cloudbuild_soft_delete_mode_for_env() {
  local env="$1"
  if [[ "${env}" == "prod" ]]; then
    echo "${PROD_CLOUDBUILD_SOFT_DELETE_MODE}"
  else
    echo "${STG_CLOUDBUILD_SOFT_DELETE_MODE}"
  fi
}

cloudbuild_soft_delete_duration_for_env() {
  local env="$1"
  if [[ "${env}" == "prod" ]]; then
    echo "${PROD_CLOUDBUILD_SOFT_DELETE_DURATION}"
  else
    echo "${STG_CLOUDBUILD_SOFT_DELETE_DURATION}"
  fi
}

write_artifact_cleanup_policy() {
  local policy_file="$1"
  local env="$2"
  local project="$3"
  shift 3
  local prefixes=("$@")
  local keep_count
  local older_than
  keep_count="$(artifact_keep_count_for_env "${env}")"
  older_than="$(artifact_delete_older_than_for_env "${env}")"

  local prefixes_json
  prefixes_json="$(printf '%s\n' "${prefixes[@]}" | jq -R . | jq -s .)"

  jq -n \
    --arg keepName "keep-${env}-latest-${keep_count}" \
    --arg deleteName "delete-${env}-older-than-${older_than}" \
    --argjson prefixes "${prefixes_json}" \
    --argjson keepCount "${keep_count}" \
    --arg olderThan "${older_than}" \
    '[
      {
        "name": $keepName,
        "action": {"type": "Keep"},
        "mostRecentVersions": {
          "packageNamePrefixes": $prefixes,
          "keepCount": $keepCount
        }
      },
      {
        "name": $deleteName,
        "action": {"type": "Delete"},
        "condition": {
          "tagState": "any",
          "packageNamePrefixes": $prefixes,
          "olderThan": $olderThan
        }
      }
    ]' > "${policy_file}"

  echo "Policy ${project}/${REPOSITORY}: prefixes=${prefixes[*]}, keep=${keep_count}, deleteOlderThan=${older_than}"
}

repo_exists() {
  local project="$1"
  if [[ "${APPLY}" != "true" ]]; then
    return 0
  fi
  gcloud artifacts repositories describe "${REPOSITORY}" \
    --project "${project}" \
    --location "${REGION}" \
    --quiet >/dev/null 2>&1
}

set_artifact_cleanup_policy() {
  local env="$1"
  local project="$2"
  shift 2
  local prefixes=("$@")
  local policy_file="/tmp/halunasu-${env}-${project}-artifact-cleanup-policy.json"

  if ! repo_exists "${project}"; then
    echo "Skipping missing Artifact Registry repo: ${project}/${REPOSITORY}"
    return
  fi

  write_artifact_cleanup_policy "${policy_file}" "${env}" "${project}" "${prefixes[@]}"
  run_or_print gcloud artifacts repositories set-cleanup-policies "${REPOSITORY}" \
    --project "${project}" \
    --location "${REGION}" \
    --policy "${policy_file}" \
    --quiet
}

prune_images_now() {
  local env="$1"
  local project="$2"
  shift 2
  local prefixes=("$@")
  local keep_count
  keep_count="$(artifact_keep_count_for_env "${env}")"

  if ! repo_exists "${project}"; then
    return
  fi

  local prefix
  for prefix in "${prefixes[@]}"; do
    local image_path="${REGION}-docker.pkg.dev/${project}/${REPOSITORY}/${prefix}"
    echo "Prune ${image_path}: keep latest ${keep_count}"
    if [[ "${APPLY}" != "true" ]]; then
      echo "DRY RUN: would delete ${prefix} images after the latest ${keep_count}"
      continue
    fi

    local images_json="/tmp/halunasu-${env}-${project}-${prefix}-images.json"
    if ! gcloud artifacts docker images list "${image_path}" \
      --include-tags \
      --sort-by="~UPDATE_TIME" \
      --format=json \
      --quiet > "${images_json}" 2>/dev/null; then
      echo "No image package found: ${image_path}"
      continue
    fi

    local delete_list="/tmp/halunasu-${env}-${project}-${prefix}-delete-list.txt"
    jq -r --argjson keep "${keep_count}" '
      .[$keep:][]? | select(.package and .version) | "\(.package)@\(.version)"
    ' "${images_json}" > "${delete_list}"

    if [[ ! -s "${delete_list}" ]]; then
      echo "No ${prefix} images to prune."
      continue
    fi

    while IFS= read -r image_ref; do
      [[ -z "${image_ref}" ]] && continue
      gcloud artifacts docker images delete "${image_ref}" --delete-tags --quiet
    done < "${delete_list}"
  done
}

write_cloudbuild_lifecycle() {
  local lifecycle_file="$1"
  local env="$2"
  local delete_age_days
  delete_age_days="$(cloudbuild_delete_age_for_env "${env}")"
  jq -n --argjson age "${delete_age_days}" '{
    "rule": [
      {
        "action": {"type": "Delete"},
        "condition": {"age": $age}
      }
    ]
  }' > "${lifecycle_file}"
}

set_cloudbuild_lifecycle() {
  local env="$1"
  local project="$2"
  local bucket="${project}_cloudbuild"
  local lifecycle_file="/tmp/halunasu-${env}-${project}-cloudbuild-lifecycle.json"
  local soft_delete_mode
  local soft_delete_duration
  soft_delete_mode="$(cloudbuild_soft_delete_mode_for_env "${env}")"
  soft_delete_duration="$(cloudbuild_soft_delete_duration_for_env "${env}")"

  write_cloudbuild_lifecycle "${lifecycle_file}" "${env}"
  if [[ "${APPLY}" == "true" ]] && ! gcloud storage buckets describe "gs://${bucket}" --quiet >/dev/null 2>&1; then
    echo "Skipping missing bucket: gs://${bucket}"
    return
  fi

  if [[ "${soft_delete_mode}" == "clear" ]]; then
    run_or_print gcloud storage buckets update "gs://${bucket}" \
      --lifecycle-file "${lifecycle_file}" \
      --clear-soft-delete \
      --quiet
  else
    run_or_print gcloud storage buckets update "gs://${bucket}" \
      --lifecycle-file "${lifecycle_file}" \
      --soft-delete-duration "${soft_delete_duration}" \
      --quiet
  fi
}

report_sizes_for_project() {
  local env="$1"
  local project="$2"
  shift 2
  local prefixes=("$@")

  if [[ "${APPLY}" != "true" ]]; then
    echo "DRY RUN: size checks require --apply because gcloud may need live credentials."
    return
  fi

  local prefix
  for prefix in "${prefixes[@]}"; do
    local image_path="${REGION}-docker.pkg.dev/${project}/${REPOSITORY}/${prefix}"
    local artifact_bytes
    artifact_bytes="$(gcloud artifacts docker images list "${image_path}" --include-tags --format=json --quiet 2>/dev/null \
      | jq '[.[].metadata.imageSizeBytes? // "0" | tonumber] | add // 0')"
    warn_gib "Artifact Registry ${project}/${prefix}" "${artifact_bytes}" "${ARTIFACT_WARN_GIB}"
  done

  local bucket="${project}_cloudbuild"
  if gcloud storage buckets describe "gs://${bucket}" --quiet >/dev/null 2>&1; then
    local bucket_bytes
    bucket_bytes="$(gcloud storage du --summarize "gs://${bucket}" 2>/dev/null | awk '{print $1 + 0}')"
    warn_gib "Cloud Build bucket gs://${bucket}" "${bucket_bytes}" "${CLOUDBUILD_WARN_GIB}"
  fi
}

cleanup_env() {
  local env="$1"
  echo "== ${env}: runtime artifact cleanup =="
  while IFS='|' read -r project prefix_string; do
    [[ -z "${project}" ]] && continue
    read -r -a prefixes <<< "${prefix_string}"
    set_artifact_cleanup_policy "${env}" "${project}" "${prefixes[@]}"
    prune_images_now "${env}" "${project}" "${prefixes[@]}"
    set_cloudbuild_lifecycle "${env}" "${project}"
    report_sizes_for_project "${env}" "${project}" "${prefixes[@]}"
  done < <(project_prefixes_for_env "${env}")
  echo
}

if [[ "${TARGET_SERVICE}" != "all" ]]; then
  echo "TARGET_SERVICE=${TARGET_SERVICE}; cleanup policies are repository-level, so all runtime service prefixes in the selected env are maintained."
fi

echo "Runtime artifact cleanup"
echo "Apply: ${APPLY}"
echo "Target env: ${TARGET_ENV}"
echo "Region: ${REGION}"
echo "Repository: ${REPOSITORY}"
echo "STG: keep=${STG_ARTIFACT_KEEP_COUNT}, deleteOlderThan=${STG_ARTIFACT_DELETE_OLDER_THAN}, cloudBuildAge=${STG_CLOUDBUILD_DELETE_AGE_DAYS}, softDelete=${STG_CLOUDBUILD_SOFT_DELETE_MODE}"
echo "PROD: keep=${PROD_ARTIFACT_KEEP_COUNT}, deleteOlderThan=${PROD_ARTIFACT_DELETE_OLDER_THAN}, cloudBuildAge=${PROD_CLOUDBUILD_DELETE_AGE_DAYS}, softDelete=${PROD_CLOUDBUILD_SOFT_DELETE_MODE}/${PROD_CLOUDBUILD_SOFT_DELETE_DURATION}"
echo

if env_selected "stg"; then
  cleanup_env "stg"
fi
if env_selected "prod"; then
  cleanup_env "prod"
fi

echo "Runtime artifact cleanup complete."
