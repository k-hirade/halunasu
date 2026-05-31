#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/p17_deploy_firestore_security_and_indexes.sh [--apply] [project...]

Deploy firestore.rules and firestore.indexes.json to the current Halunasu
Core/Product GCP projects. Without --apply, this script prints the commands.

Default project set:
  medical-core-stg
  medical-core-497610
  halunasu-charting-stg
  halunasu-charting-prod
  halunasu-fee-stg
  halunasu-fee-prod
  halunasu-referral-stg
  halunasu-referral-prod
USAGE
}

APPLY="no"
PROJECTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY="yes"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      PROJECTS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#PROJECTS[@]} -eq 0 ]]; then
  PROJECTS=(
    medical-core-stg
    medical-core-497610
    halunasu-charting-stg
    halunasu-charting-prod
    halunasu-fee-stg
    halunasu-fee-prod
    halunasu-referral-stg
    halunasu-referral-prod
  )
fi

if [[ ! -f "firebase.json" || ! -f "firestore.rules" || ! -f "firestore.indexes.json" ]]; then
  echo "Run this script from the halunasu repository root." >&2
  exit 1
fi

for project in "${PROJECTS[@]}"; do
  if [[ "$APPLY" == "yes" ]]; then
    echo "Deploying Firestore rules to ${project}"
    token="$(gcloud auth print-access-token --quiet)"
    rules_payload="$(jq -n --rawfile content firestore.rules '{source:{files:[{name:"firestore.rules",content:$content}]}}')"
    ruleset_response="$(
      curl -sS -X POST \
        -H "Authorization: Bearer ${token}" \
        -H "X-Goog-User-Project: ${project}" \
        -H "Content-Type: application/json" \
        -d "${rules_payload}" \
        "https://firebaserules.googleapis.com/v1/projects/${project}/rulesets"
    )"
    ruleset_name="$(printf '%s' "${ruleset_response}" | jq -r '.name // empty')"
    if [[ -z "${ruleset_name}" ]]; then
      echo "Failed to create ruleset for ${project}:" >&2
      printf '%s\n' "${ruleset_response}" >&2
      exit 1
    fi
    release_payload="$(jq -n \
      --arg name "projects/${project}/releases/cloud.firestore" \
      --arg rulesetName "${ruleset_name}" \
      '{name:$name,rulesetName:$rulesetName}')"
    release_response="$(
      curl -sS -X POST \
        -H "Authorization: Bearer ${token}" \
        -H "X-Goog-User-Project: ${project}" \
        -H "Content-Type: application/json" \
        -d "${release_payload}" \
        "https://firebaserules.googleapis.com/v1/projects/${project}/releases"
    )"
    if printf '%s' "${release_response}" | jq -e '.error.code == 409' >/dev/null; then
      patch_payload="$(jq -n \
        --arg name "projects/${project}/releases/cloud.firestore" \
        --arg rulesetName "${ruleset_name}" \
        '{release:{name:$name,rulesetName:$rulesetName},updateMask:"rulesetName"}')"
      release_response="$(
        curl -sS -X PATCH \
          -H "Authorization: Bearer ${token}" \
          -H "X-Goog-User-Project: ${project}" \
          -H "Content-Type: application/json" \
          -d "${patch_payload}" \
          "https://firebaserules.googleapis.com/v1/projects/${project}/releases/cloud.firestore"
      )"
    fi
    if ! printf '%s' "${release_response}" | jq -e '.name' >/dev/null; then
      echo "Failed to update Firestore rules release for ${project}:" >&2
      printf '%s\n' "${release_response}" >&2
      exit 1
    fi

    echo "Deploying Firestore composite indexes to ${project}"
    while IFS= read -r index_json; do
      collection_group="$(printf '%s' "${index_json}" | jq -r '.collectionGroup')"
      query_scope="$(printf '%s' "${index_json}" | jq -r '.queryScope | ascii_downcase | gsub("_"; "-")')"
      field_config="$(printf '%s' "${index_json}" | jq -c '[.fields[] | {"field-path": .fieldPath} + (if has("order") then {"order": (.order | ascii_downcase)} elif has("arrayConfig") then {"array-config": (.arrayConfig | ascii_downcase)} else {} end)]')"
      if ! output="$(gcloud firestore indexes composite create \
        --project "${project}" \
        --database="(default)" \
        --collection-group="${collection_group}" \
        --query-scope="${query_scope}" \
        --field-config="${field_config}" \
        --async \
        --quiet 2>&1)"; then
        if [[ "${output}" == *"ALREADY_EXISTS"* || "${output}" == *"already exists"* ]]; then
          echo "Index already exists for ${project}/${collection_group}"
        elif [[ "${output}" == *"not necessary"* ]]; then
          echo "Index not necessary for ${project}/${collection_group}"
        else
          printf '%s\n' "${output}" >&2
          exit 1
        fi
      else
        printf '%s\n' "${output}"
      fi
    done < <(jq -c '.indexes[]' firestore.indexes.json)
  else
    echo "gcloud auth print-access-token >/dev/null"
    echo "curl -sS -X POST https://firebaserules.googleapis.com/v1/projects/${project}/rulesets ..."
    echo "curl -sS -X PATCH https://firebaserules.googleapis.com/v1/projects/${project}/releases/cloud.firestore?updateMask=rulesetName ..."
    echo "jq -c '.indexes[]' firestore.indexes.json | while read index; do gcloud firestore indexes composite create --project ${project} ...; done"
  fi
done
