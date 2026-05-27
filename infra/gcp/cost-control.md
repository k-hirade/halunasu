# Cost Control Policy

Status: active  
Date: 2026-05-27  
Owner: Halunasu platform

## Goal

Keep `medical-core-stg` as close to zero cost as possible while the product is still pre-customer.

No command in this repository should create paid infrastructure by default. Scripts must default to dry-run or require an explicit `--apply`.

## Hard Rules

- Do not create VM instances.
- Do not create GKE clusters.
- Do not create Cloud SQL.
- Do not create NAT gateways.
- Do not create external HTTPS Load Balancers.
- Do not reserve static IP addresses.
- Do not create BigQuery datasets/jobs.
- Do not create Cloud Scheduler jobs.
- Do not create Cloud Tasks queues until async work is actually needed.
- Do not create always-on Cloud Run instances.
- Do not enable Cloud Run CPU always allocated.
- Do not add Cloud Run minimum instances above `0`.
- Do not add production secrets or third-party API keys until a route needs them.
- Do not allow unauthenticated public access until app-level auth is implemented.
- Do not run Terraform apply for now.

## Allowed For Staging

Allowed only when explicitly needed:

- Cloud Run service with `min-instances=0`.
- Cloud Run service with `max-instances=1`.
- Firestore `(default)` database in `medical-core-stg`.
- Artifact Registry repository for one service image.
- Minimal service account for `platform-api`.

Even these should not be created automatically by default.

## Platform API Staging Settings

Use these settings for the first Cloud Run staging deploy:

```text
PROJECT_ID=medical-core-stg
REGION=asia-northeast1
SERVICE_NAME=platform-api-stg
MIN_INSTANCES=0
MAX_INSTANCES=1
CPU=1
MEMORY=512Mi
TIMEOUT=60
CONCURRENCY=80
PLATFORM_STORE_BACKEND=firestore
ALLOW_UNAUTHENTICATED=false
```

The service scales to zero when idle. Avoid smoke tests that create database writes unless the write path is intentionally being verified.

## Terraform Decision

Do not add or apply Terraform yet.

Reason:

- The immediate goal is a single low-cost Cloud Run API.
- Terraform itself is not the expensive part, but a Terraform workflow can make it too easy to create buckets, queues, service accounts, IAM bindings, or other resources before they are needed.
- Manual, explicit `gcloud` commands with dry-run defaults are safer at this stage.

Reconsider Terraform only after:

- at least two Cloud Run services need repeatable deployment, or
- IAM drift becomes hard to track manually, or
- production launch planning starts.

## Current Resource Creation Policy

The deploy script in `scripts/deploy_platform_api_stg_zero_cost.sh`:

- defaults to dry-run
- requires `--apply` for build/deploy
- does not enable APIs
- does not create Artifact Registry repositories
- does not create Firestore
- does not create service accounts
- does not create Secret Manager secrets
- does not create buckets
- deploys Cloud Run with `min-instances=0` and `max-instances=1`
- deploys Cloud Run with `--no-allow-unauthenticated`

Create prerequisites manually only when needed, and check billing after each step.
