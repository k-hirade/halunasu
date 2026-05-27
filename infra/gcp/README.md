# GCP Infrastructure

Terraform and GCP runbooks live here.

Cost control comes first. Read [cost-control.md](cost-control.md) before creating any resource.

Target projects:

- Staging: `medical-core-stg`
- Production/core: `medical-core-497610`

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
