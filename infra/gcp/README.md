# GCP Infrastructure

Terraform and GCP runbooks live here.

Cost control comes first. Read [cost-control.md](cost-control.md) before creating any resource.

Target projects:

- Core staging: `medical-core-stg`
- Core production: `medical-core-497610`
- Charting staging: `halunasu-charting-stg`
- Charting production: `halunasu-charting-prod`
- Fee staging: `halunasu-fee-stg`
- Fee production: `halunasu-fee-prod`
- Referral staging: `halunasu-referral-stg`
- Referral production: `halunasu-referral-prod`

Product projects are currently billing-disabled shells. Keep them that way until P10 intentionally enables a specific service path.

Potential future modules:

- Project services
- Service accounts
- Artifact Registry
- Firestore
- Cloud Storage buckets
- Cloud Tasks queues
- Secret Manager secret shells
- Cloud Run services

Initial Platform API environment:

```text
GOOGLE_CLOUD_PROJECT=medical-core-stg
GOOGLE_CLOUD_REGION=asia-northeast1
PLATFORM_STORE_BACKEND=firestore
```

Terraform is intentionally deferred for now. Use the P2 preflight and guarded deploy script for the first `platform-api` staging deploy.

```bash
./scripts/preflight_platform_api_stg_p2.sh
./scripts/deploy_platform_api_stg_zero_cost.sh
```
