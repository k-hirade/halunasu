# P2 Staging Smoke Runbook

Status: complete
Date: 2026-05-27
Owner: Halunasu platform

## Purpose

P2 verifies that `platform-api` can run in `medical-core-stg` with the smallest practical cost and no public unauthenticated access.

This phase must not create resources automatically by default.

## Current Preflight Result

Read-only checks were started on 2026-05-27. P2 deploy completed on 2026-05-27.

Initial observed state:

- Local dry-run deploy command passed.
- Active local `gcloud` account was updated from `keisi.hirade.97@gmail.com` to `info@halunasu.com`.
- `info@halunasu.com` can access `medical-core-stg`.
- `medical-core-stg` project number is `866813206652`.
- Billing is not enabled on `medical-core-stg`.
- Artifact Registry API is currently disabled for `medical-core-stg`.
- Cloud Build API is currently disabled for `medical-core-stg`.
- Cloud Firestore API is currently disabled for `medical-core-stg`.
- Cloud Run Admin API is currently disabled for `medical-core-stg`.
- `halunasu-platform-api@medical-core-stg.iam.gserviceaccount.com` does not exist yet.
- Read-only preflight result after billing check update: 9 failure(s), 1 warning(s).
- API enablement was attempted once and failed before making changes because billing is not linked.
Final state:

- Billing was linked to `medical-core-stg`.
- Required APIs were enabled.
- Artifact Registry repository `halunasu-services` was created in `asia-northeast1`.
- Service account `halunasu-platform-api@medical-core-stg.iam.gserviceaccount.com` was created.
- The runtime service account was granted `roles/datastore.user`.
- Firestore Native `(default)` database was created in `asia-northeast1`.
- Firestore database reported `freeTier: true` at creation time.
- Cloud Build used `866813206652-compute@developer.gserviceaccount.com`; this service account was granted:
  - `roles/storage.objectViewer` on `gs://medical-core-stg_cloudbuild`
  - `roles/artifactregistry.writer` on Artifact Registry repository `halunasu-services`
- One Cloud Build ran successfully.
- One image was pushed:
  `asia-northeast1-docker.pkg.dev/medical-core-stg/halunasu-services/platform-api-stg:20260527-220836`
- Artifact Registry repository size after deploy was `115.514MB`.
- `platform-api-stg` was deployed to Cloud Run.
- Cloud Run service URL:
  `https://platform-api-stg-lp2t3inhza-an.a.run.app`
- Cloud Run settings after deploy:
  - `ready=True`
  - `minScale=0`
  - `maxScale=1`
  - `serviceAccount=halunasu-platform-api@medical-core-stg.iam.gserviceaccount.com`
- Cloud Run IAM policy is empty, so no `allUsers` unauthenticated public access is granted.
- Unauthenticated `/readyz` returned `403`.
- IAM-authenticated `/readyz` returned `200`.
- One controlled Firestore write/read smoke succeeded:
  - organizationCode: `p2-smoke-20260527221259`
  - orgId: `org_1eefcbb152c24f8e806692bd8c`
- No Terraform was run.

Known warning:

- Cloud Build reported that `866813206652-compute@developer.gserviceaccount.com` cannot write logs to Cloud Logging. The build still completed successfully. Do not add `roles/logging.logWriter` unless build log retention becomes necessary.

## Cost Guardrails

Keep all of these true:

- Cloud Run `min-instances=0`.
- Cloud Run staging `max-instances=1`.
- Cloud Run `--no-allow-unauthenticated`.
- No Terraform apply.
- No Cloud SQL.
- No VM.
- No GKE.
- No NAT.
- No external HTTPS Load Balancer.
- No Cloud Scheduler.
- No Cloud Tasks.
- No BigQuery.
- No third-party API secrets.

## Required Existing Resources

P2 deploy needs these prerequisites in `medical-core-stg`:

```text
Billing must be linked to medical-core-stg before Cloud Run, Cloud Build,
and Artifact Registry can be enabled.
```

```text
artifactregistry.googleapis.com
cloudbuild.googleapis.com
firestore.googleapis.com
iam.googleapis.com
run.googleapis.com
```

```text
Artifact Registry repository:
  asia-northeast1 / halunasu-services

Cloud Run service account:
  halunasu-platform-api@medical-core-stg.iam.gserviceaccount.com

Firestore database:
  (default)
```

Runtime service account role:

```text
roles/datastore.user
```

The deploy operator needs permission to submit Cloud Build, push to Artifact Registry, deploy Cloud Run, and act as the Cloud Run service account.

## Manual Prerequisite Commands

Do not run these until the operator confirms the small expected costs and billing is linked to `medical-core-stg`.

Enable only required APIs:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  iam.googleapis.com \
  run.googleapis.com \
  --project medical-core-stg
```

Create the Docker repository if missing:

```bash
gcloud artifacts repositories create halunasu-services \
  --repository-format docker \
  --location asia-northeast1 \
  --description "Halunasu staging service images" \
  --project medical-core-stg
```

Create the runtime service account if missing:

```bash
gcloud iam service-accounts create halunasu-platform-api \
  --display-name "Halunasu Platform API Staging" \
  --project medical-core-stg
```

Grant Firestore access to the runtime service account:

```bash
gcloud projects add-iam-policy-binding medical-core-stg \
  --member serviceAccount:halunasu-platform-api@medical-core-stg.iam.gserviceaccount.com \
  --role roles/datastore.user
```

Create Firestore Native database if missing:

```bash
gcloud firestore databases create \
  --database "(default)" \
  --location asia-northeast1 \
  --type firestore-native \
  --project medical-core-stg
```

## Preflight

Run this first. It is read-only.

```bash
./scripts/preflight_platform_api_stg_p2.sh
```

The preflight must pass before running deploy.

## Dry Run

Run the deploy dry-run and inspect the exact commands.

```bash
./scripts/deploy_platform_api_stg_zero_cost.sh
```

Expected guardrails:

```text
Cloud Run min instances: 0
Cloud Run max instances: 1
--no-allow-unauthenticated
```

## Deploy

Only after preflight passes:

```bash
./scripts/deploy_platform_api_stg_zero_cost.sh --apply
```

This builds one container image and deploys one Cloud Run service. It can create small Cloud Build and Artifact Registry usage, but Cloud Run should idle at zero instances.

## Smoke

After deploy, call `/readyz` with IAM auth only:

```bash
SERVICE_URL="$(gcloud run services describe platform-api-stg --project medical-core-stg --region asia-northeast1 --format='value(status.url)')"
curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${SERVICE_URL}/readyz"
```

Expected result:

```json
{
  "status": "ok",
  "service": "platform-api",
  "env": "stg",
  "projectId": "medical-core-stg",
  "region": "asia-northeast1"
}
```

Do not run Firestore write smoke until `/readyz` works and billing is checked.
