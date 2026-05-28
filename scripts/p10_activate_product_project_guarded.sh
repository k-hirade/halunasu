#!/usr/bin/env bash
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PRODUCT="${1:-charting}"
ENVIRONMENT="${2:-stg}"
APPLY="false"
if [[ "${3:-}" == "--apply" ]]; then
  APPLY="true"
elif [[ "${3:-}" != "" ]]; then
  echo "Usage: $0 [charting|fee|referral] [stg|prod] [--apply]" >&2
  exit 64
fi

case "${PRODUCT}:${ENVIRONMENT}" in
  charting:stg) PROJECT_ID="halunasu-charting-stg" ;;
  charting:prod) PROJECT_ID="halunasu-charting-prod" ;;
  fee:stg) PROJECT_ID="halunasu-fee-stg" ;;
  fee:prod) PROJECT_ID="halunasu-fee-prod" ;;
  referral:stg) PROJECT_ID="halunasu-referral-stg" ;;
  referral:prod) PROJECT_ID="halunasu-referral-prod" ;;
  *)
    echo "Unsupported product/environment: ${PRODUCT}/${ENVIRONMENT}" >&2
    exit 64
    ;;
esac

SERVICES=(
  artifactregistry.googleapis.com
  cloudbuild.googleapis.com
  firestore.googleapis.com
  iam.googleapis.com
  run.googleapis.com
  secretmanager.googleapis.com
  storage.googleapis.com
)

if [[ "${PRODUCT}" == "charting" ]]; then
  SERVICES+=(cloudtasks.googleapis.com)
fi

echo "P10 guarded product project activation"
echo "Product: ${PRODUCT}"
echo "Environment: ${ENVIRONMENT}"
echo "Project: ${PROJECT_ID}"
echo "Apply: ${APPLY}"
echo
echo "Guardrails:"
echo "- dry-run by default"
echo "- billing link requires --apply, P10_ALLOW_BILLING=yes, and BILLING_ACCOUNT_ID"
echo "- production requires P10_ALLOW_PROD=yes"
echo "- no Cloud Run deploy"
echo "- no Firestore database creation"
echo "- no Artifact Registry repository creation"
echo "- no service account creation"
echo "- no Secret Manager secret creation"
echo "- no bucket creation"
echo "- no Terraform"
echo

if [[ "${ENVIRONMENT}" == "prod" && "${P10_ALLOW_PROD:-}" != "yes" ]]; then
  echo "Refusing production activation without P10_ALLOW_PROD=yes" >&2
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

state="$(gcloud projects describe "${PROJECT_ID}" --format="value(lifecycleState)" --quiet)"
if [[ "${state}" != "ACTIVE" ]]; then
  echo "Project ${PROJECT_ID} must be ACTIVE, got ${state:-unknown}" >&2
  exit 65
fi

current_billing="$(gcloud billing projects describe "${PROJECT_ID}" --format="value(billingEnabled)" --quiet 2>/dev/null || true)"
echo "Current billingEnabled=${current_billing:-unknown}"

if [[ "${APPLY}" == "true" ]]; then
  if [[ "${P10_ALLOW_BILLING:-}" != "yes" ]]; then
    echo "Refusing to link billing without P10_ALLOW_BILLING=yes" >&2
    exit 65
  fi
  if [[ -z "${BILLING_ACCOUNT_ID:-}" ]]; then
    echo "Refusing to link billing without BILLING_ACCOUNT_ID" >&2
    exit 65
  fi
fi

if [[ "${current_billing}" != "True" ]]; then
  run_or_print gcloud billing projects link "${PROJECT_ID}" \
    --billing-account "${BILLING_ACCOUNT_ID:-BILLING_ACCOUNT_ID_REQUIRED}" \
    --quiet
else
  echo "Billing already linked; skipping billing link command."
fi

run_or_print gcloud services enable "${SERVICES[@]}" \
  --project "${PROJECT_ID}" \
  --quiet

echo
echo "Next manual gates after activation:"
echo "1. Create only the needed service account and Artifact Registry repository."
echo "2. Create Firestore only when the product staging smoke needs persistence."
echo "3. Deploy with Cloud Run min-instances=0 and max-instances=1."
echo "4. Keep production product projects billing-disabled until staging smoke passes."
