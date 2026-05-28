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
DEFAULT_PROJECTS=(
  "medical-stg-493105"
  "medical-fee-calculation-stg"
)

IFS=" " read -r -a PROJECTS <<<"${P9_OLD_PROJECTS:-${DEFAULT_PROJECTS[*]}}"
IFS=" " read -r -a SERVICE_FILTER <<<"${P9_OLD_SERVICES:-}"

echo "P9 old environment Cloud Run shutdown guard"
echo "Region: ${REGION}"
echo "Projects: ${PROJECTS[*]}"
if [[ "${#SERVICE_FILTER[@]}" -gt 0 ]]; then
  echo "Services: ${SERVICE_FILTER[*]}"
fi
echo "Apply: ${APPLY}"
echo
echo "Guardrails:"
echo "- no Terraform"
echo "- no API enablement"
echo "- no Cloud Run image build or new service deploy"
echo "- existing-service updates can create Cloud Run config revisions"
echo "- no Firestore export or backup creation"
echo "- no bucket, secret, queue, scheduler, or database creation"
echo "- no project deletion"
echo "- Cloud Run services are only updated to min-instances=0, max-instances=1, CPU throttling"
echo "- public Cloud Run invoker bindings are removed when present"
echo

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH" >&2
  exit 127
fi

for project in "${PROJECTS[@]}"; do
  case "${project}" in
    medical-core-stg|medical-core-497610)
      echo "Refusing to mutate Core project in P9 old-environment script: ${project}" >&2
      exit 65
      ;;
  esac
done

if [[ "${APPLY}" == "true" && "${P9_ALLOW_MUTATION:-}" != "yes" ]]; then
  echo "Refusing to apply. Set P9_ALLOW_MUTATION=yes to mutate existing old Cloud Run services." >&2
  exit 65
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

remove_invoker_binding_if_present() {
  local service="$1"
  local project="$2"
  local member="$3"

  if [[ "${APPLY}" != "true" ]]; then
    run_or_print gcloud run services remove-iam-policy-binding "${service}" \
      --project "${project}" \
      --region "${REGION}" \
      --member "${member}" \
      --role roles/run.invoker \
      --quiet
    return
  fi

  local output
  if output="$(gcloud run services remove-iam-policy-binding "${service}" \
    --project "${project}" \
    --region "${REGION}" \
    --member "${member}" \
    --role roles/run.invoker \
    --quiet 2>&1)"; then
    echo "${output}"
  elif grep -Fq "Policy binding with the specified principal, role, and condition not found" <<<"${output}"; then
    echo "Invoker binding absent for ${member}; continuing."
  else
    echo "${output}" >&2
    return 1
  fi
}

service_selected() {
  local candidate="$1"
  if [[ "${#SERVICE_FILTER[@]}" -eq 0 ]]; then
    return 0
  fi

  for selected in "${SERVICE_FILTER[@]}"; do
    if [[ "${candidate}" == "${selected}" ]]; then
      return 0
    fi
  done

  return 1
}

for project in "${PROJECTS[@]}"; do
  echo "============================================================"
  echo "Project: ${project}"
  echo "============================================================"

  services="$(gcloud run services list \
    --project "${project}" \
    --region "${REGION}" \
    --format="value(metadata.name)" \
    --quiet 2>/dev/null || true)"

  if [[ -z "${services}" ]]; then
    echo "No Cloud Run services found or Cloud Run API is unavailable."
    echo
    continue
  fi

  while IFS= read -r service; do
    [[ -z "${service}" ]] && continue
    if ! service_selected "${service}"; then
      echo "Skipping service outside P9_OLD_SERVICES filter: ${service}"
      continue
    fi
    echo "Service: ${service}"

    run_or_print gcloud run services update "${service}" \
      --project "${project}" \
      --region "${REGION}" \
      --min-instances 0 \
      --max-instances 1 \
      --cpu-throttling \
      --quiet

    remove_invoker_binding_if_present "${service}" "${project}" allUsers
    remove_invoker_binding_if_present "${service}" "${project}" allAuthenticatedUsers
    echo
  done <<<"${services}"
done

if [[ "${APPLY}" != "true" ]]; then
  echo "Dry run only. To apply existing-service mutations:"
  echo "P9_ALLOW_MUTATION=yes $0 --apply"
fi
