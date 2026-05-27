# GCP Infrastructure

Terraform and GCP runbooks live here.

Target projects:

- Staging: `medical-core-stg`
- Production/core: `medical-core-497610`

Initial modules:

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
