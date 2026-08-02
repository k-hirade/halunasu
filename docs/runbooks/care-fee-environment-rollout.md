# Care Fee environment rollout

Last updated: 2026-08-02

This runbook provisions the independent emergency-treatment-management checker. STG and PROD are separate rollouts. The application does not persist raw CSV files in Cloud Storage. Cloud Build staging buckets contain source bundles only and must never receive PHI.

## Current state

| Environment | GCP project | Cloud Run | Netlify | State |
| --- | --- | --- | --- | --- |
| STG | `halunasu-care-stg` | `care-fee-api-stg` | `halunasu-care-fee-stg` | deployed; DNS and TLS active |
| PROD | `halunasu-care-prod` | `care-fee-api-prod` | `halunasu-care-fee-prod` | deployed for demo validation; DNS and TLS active |

The default Netlify domains are usable now:

- STG: `https://halunasu-care-fee-stg.netlify.app`
- PROD: `https://halunasu-care-fee-prod.netlify.app`

The custom domains are active with Netlify-managed TLS. Production PHI acceptance remains blocked on the acceptance checklist, backup decision, and restore drill; the current PROD tenant is for synthetic/demo validation.

### Deployed low-cost profile

- Care Cloud Run: `minScale=0`, `maxScale=1`, `1 CPU`, `512MiB`, CPU throttling enabled.
- Care Firestore: `(default)` database in `asia-northeast1`, free-tier database, deny-all direct client rules.
- Care API STG revision at rollout: `care-fee-api-stg-00002-9r5`.
- Care API PROD revision at rollout: `care-fee-api-prod-00001-j89`.
- Fee integration STG revision at rollout: `fee-api-stg-00223-dkz`.
- Fee integration PROD revision at rollout: `fee-api-prod-00085-jtb`.
- Fee runtime capacity and OpenAI-primary extraction settings were preserved during integration rollout.
- No application upload bucket, Cloud Scheduler, Cloud SQL, VM, GKE, NAT, static IP, or load balancer was created.
- Source CSV and generated results are not stored in Cloud Storage.

## 0. Local release gate

Run from the repository root.

```bash
npm run test:care-fee-gold
npm test --workspace @halunasu/care-fee-api
npm test --workspace @halunasu/care-fee-web
npm run test:care-fee-ops
npm run eval:care-emergency-csv -- \
  --input samples/care-fee/emergency-treatment-template.csv \
  --output /tmp/care-fee-result.csv
```

All commands must pass before requesting an environment.

## 1. User-owned external resources

The user creates these resources because project ownership, billing, Netlify team selection, and DNS approval are outside the repository.

### STG

1. Create the GCP project shell. If an organization policy requires a parent, create it in the GCP console under the approved folder instead of omitting the parent.

```bash
gcloud projects create halunasu-care-stg --name="Halunasu Care STG"
```

2. Confirm the active Netlify team, then create the site.

```bash
netlify status
netlify sites:create --name halunasu-care-fee-stg
```

Record the Netlify site UUID. Do not register it in the repository until the API URL also exists.

### PROD

Repeat only after STG acceptance.

```bash
gcloud projects create halunasu-care-prod --name="Halunasu Care PROD"
netlify status
netlify sites:create --name halunasu-care-fee-prod
```

## 2. Activate and provision STG

The guarded activation is dry-run first. It links the existing STG billing account and enables only the APIs used by the low-cost runtime.

```bash
scripts/p10_activate_product_project_guarded.sh care stg

P10_ALLOW_BILLING=yes \
BILLING_ACCOUNT_ID=017363-055589-E21116 \
scripts/p10_activate_product_project_guarded.sh care stg --apply

P10_ALLOW_BILLING=yes \
TARGET_PRODUCT=care \
TARGET_ENV=stg \
scripts/p10_provision_runtime_projects_low_cost.sh --apply

FIRESTORE_INDEXES_FILE=firestore.care.indexes.json \
scripts/p17_deploy_firestore_security_and_indexes.sh \
  --apply halunasu-care-stg
```

The provisioner creates Firestore, Artifact Registry, a short-lived regional Cloud Build staging bucket, the dedicated runtime service account, and environment-specific secrets. It does not create an application upload bucket or Cloud Scheduler.

## 3. Deploy and register STG

`CPU` is the supported deploy variable. Do not use `FEE_CPU` or `CARE_CPU`.

```bash
MIN_INSTANCES=0 \
MAX_INSTANCES=1 \
CPU=1 \
TARGET_ENV=stg \
TARGET_SERVICE=care-fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply

CARE_FEE_API_URL="$(gcloud run services describe care-fee-api-stg \
  --project halunasu-care-stg \
  --region asia-northeast1 \
  --format='value(status.url)')"

curl -sS --max-time 180 "${CARE_FEE_API_URL}/readyz" | jq '{
  status,
  service,
  env,
  projectId,
  ruleVersion,
  masterVersion,
  structuredCsvOpenAiCalls,
  automation
}'
```

Register the Netlify UUID created in section 1. Run once without `--apply`, inspect the output, then apply.

```bash
npm run register:care-fee-environment -- \
  --env stg \
  --site-id <STG_NETLIFY_SITE_UUID> \
  --care-fee-api-url "${CARE_FEE_API_URL}"

npm run register:care-fee-environment -- \
  --env stg \
  --site-id <STG_NETLIFY_SITE_UUID> \
  --care-fee-api-url "${CARE_FEE_API_URL}" \
  --apply

npm run deploy:netlify-admin-fee-next -- \
  --env stg \
  --app care-fee-web \
  --apply
```

Add `care.stg.halunasu.com` as the Netlify custom domain, then create only the DNS record Netlify reports for that site.

## 4. Seed the STG tenant

This creates only the independent `care_fee` entitlement and three role-separated users in Core. Password output stays under ignored `.secrets/`.

```bash
npm run seed:core-account -- \
  --env stg \
  --organization-code care-demo-stg \
  --organization-name "Care Demo STG" \
  --login-ids care-demo-admin,care-demo-clerk,care-demo-doctor \
  --products care_fee \
  --facility-name "Care Demo STG" \
  --department-name "介護請求" \
  --member-role-profile care-demo \
  --member-display-prefix "Care Demo" \
  --skip-demo-patient \
  --generate-password-file .secrets/care-demo-stg-password.txt \
  --apply
```

Log in and save the facility code, care office number, timezone, service codes, and facility variants before importing managed CSV data.

## 5. Enable the Fee integration in STG

Deploy Care first. Before redeploying Fee, read the live Fee CPU, memory, and maximum scale and reuse them. This prevents a Care rollout from changing Fee capacity.

```bash
CPU="$(gcloud run services describe fee-api-stg \
  --project halunasu-fee-stg \
  --region asia-northeast1 \
  --format='value(spec.template.spec.containers[0].resources.limits.cpu)')"
FEE_MEMORY="$(gcloud run services describe fee-api-stg \
  --project halunasu-fee-stg \
  --region asia-northeast1 \
  --format='value(spec.template.spec.containers[0].resources.limits.memory)')"
FEE_MAX_INSTANCES="$(gcloud run services describe fee-api-stg \
  --project halunasu-fee-stg \
  --region asia-northeast1 \
  --format='value(spec.template.metadata.annotations.autoscaling.knative.dev/maxScale)')"

MIN_INSTANCES=0 \
MAX_INSTANCES=1 \
CPU="${CPU}" \
FEE_MEMORY="${FEE_MEMORY}" \
FEE_MAX_INSTANCES="${FEE_MAX_INSTANCES}" \
TARGET_ENV=stg \
TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

The deployer discovers the Care Cloud Run URL and sets the versioned evidence endpoint on Fee. No Care service receives Fee Firestore IAM.

## 6. STG acceptance

- `/readyz` reports `status=ok`, `structuredCsvOpenAiCalls=0`, and `monthlyWorkerReady=true`.
- Spot CSV returns a result without persisting source or result rows.
- Managed CSV creates only valid episodes and preserves row-level errors in the result CSV.
- Same managed input is idempotent.
- Monthly run is idempotent for the same revision.
- Clerk, doctor, and admin roles have the expected read/write/decision boundaries.
- 1–3 days, day 4, non-consecutive days, second monthly claim, conflict, and unknown inputs match gold.
- Fee evidence creates reviewable Care episodes but never confirms or claims them automatically.
- Cloud Logging contains structured performance/audit metadata and no raw CSV or clinical text.
- Cloud Run remains `minScale=0` and bounded at the intended maximum.
- Desktop, mobile, CSV download, and monthly print paths work at `care.stg.halunasu.com`.

Monthly automation is not scheduled until the facility supplies its closing day, execution time, timezone, and rerun window. The token-protected worker endpoint is already implemented; scheduler creation is a separate operational approval, not part of the low-cost provisioner.

## 7. PROD rollout

After STG acceptance, repeat sections 2–6 with:

- environment `prod`
- GCP project `halunasu-care-prod`
- Cloud Run service `care-fee-api-prod`
- Netlify site `halunasu-care-fee-prod`
- domain `care.halunasu.com`
- billing account `01AF66-9333E9-4574D9`
- organization code `care-demo`
- password file `.secrets/care-demo-password.txt`

Production activation additionally requires `P10_ALLOW_PROD=yes`:

```bash
P10_ALLOW_PROD=yes \
P10_ALLOW_BILLING=yes \
BILLING_ACCOUNT_ID=01AF66-9333E9-4574D9 \
scripts/p10_activate_product_project_guarded.sh care prod --apply
```

Provision only the Care production project and its existing Core/Fee integration secrets. This scoped mode does not walk or provision unrelated runtime projects.

```bash
P10_ALLOW_PROD=yes \
P10_ALLOW_BILLING=yes \
TARGET_PRODUCT=care \
TARGET_ENV=prod \
scripts/p10_provision_runtime_projects_low_cost.sh --apply

FIRESTORE_INDEXES_FILE=firestore.care.indexes.json \
scripts/p17_deploy_firestore_security_and_indexes.sh \
  --apply halunasu-care-prod
```

Do not copy STG records or passwords into PROD. Firestore backup/scheduled export is not enabled because it introduces a new recurring resource and cost. Obtain explicit approval, then enable the chosen backup mechanism and complete a restore drill before accepting production PHI.
