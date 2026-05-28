# P8.5 Core Hardening

Status: local implementation complete
Date: 2026-05-28
Cost profile: local only, no new GCP resources

## Purpose

P8.5 closes the main gaps left after the Core foundation work:

- Platform/Core CRUD routes must not be public app-level routes.
- Shared patient data must be strong enough to become the common patient index.
- Audit `safePayload` must be allowlisted, not trusted as an arbitrary object.
- `data_requests` must exist as a real Platform API/store workflow.
- Production-like sessions must require an explicit signing secret.

No Cloud Run deploy, Secret Manager secret, Firestore backup, GCS bucket, Cloud Tasks queue, Scheduler job, or Terraform apply is part of P8.5.

## Implemented

### Core API Authorization

Public routes remain limited to:

- health/readiness
- auth login
- signup application submission
- email verification token consumption
- admin password setup token consumption

Protected Platform routes now require a valid `halunasu_session`:

- global organization listing/creation requires `platform_admin`
- organization-scoped admin routes require same-org `org_admin` or `platform_admin`
- product entitlement routes require `org_admin`, `billing_admin`, or `platform_admin`
- mutating protected routes require the Platform CSRF cookie/header pair
- cross-org access is rejected at the application layer

### Patient Core Model

The shared patient contract now supports:

- `primaryPatientNumber`
- structured `patientIdentifiers`
- `contact`
- `insurance`
- `publicInsurance`
- `consent`
- `duplicateCandidateIds`
- existing merge target support through `mergedIntoPatientId`

This is still intentionally a v1 Core patient index. Product outputs keep snapshots for historical reproducibility.

### Audit Payload Guard

`audit_events.safePayload` and `data_requests.safePayload` now pass through a strict allowlist.

The allowlist permits operational IDs, statuses, changed field names, counts, providers, and product IDs. It drops obvious PHI-bearing fields such as names, birth dates, notes, clinical text, and arbitrary nested maps.

### Data Requests

The Platform API now exposes:

```text
GET   /v1/organizations/{orgId}/data-requests
POST  /v1/organizations/{orgId}/data-requests
GET   /v1/organizations/{orgId}/data-requests/{requestId}
PATCH /v1/organizations/{orgId}/data-requests/{requestId}
```

Requests are stored under:

```text
organizations/{orgId}/data_requests/{requestId}
```

Create/update operations write audit events:

- `data_request.created`
- `data_request.updated`

P8.5 does not add an automated deletion worker. Execution of deletion/export/correction remains a later production-readiness workflow.

### Session Secret Enforcement

Production-like environments now require an explicit session signing secret. Local/test/development may still use the local fallback.

This prevents accidentally deploying a production-like service using the local-only session secret.

## Verification

Run:

```bash
npm run test --workspace @halunasu/platform-contracts
npm run test --workspace @halunasu/platform-api
npm run test --workspace @halunasu/auth-client
npm run test --workspace @halunasu/security-boundaries
npm run test
npm run build
git diff --check
```

## Remaining Core Work

Still not solved by P8.5:

- Core admin UI for organization/member/facility/patient/data request management.
- Real email provider integration for signup.
- Automated data export/deletion/correction execution.
- Encrypted MFA secret storage.
- Firestore Timestamp migration decision.
- Production backup/restore enablement and restore drill.
- Production IAM and custom domain finalization.
