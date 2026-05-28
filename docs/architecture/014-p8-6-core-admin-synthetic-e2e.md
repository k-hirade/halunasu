# P8.6 Core Admin Synthetic E2E

Status: local implementation complete
Date: 2026-05-28
Cost profile: local only, no new GCP resources

## Purpose

P8.6 verifies that the Core can be operated locally before old environments are shut down.

It adds:

- static Core Admin console
- local synthetic end-to-end tests
- role/scope checks for Core operations
- documentation for the remaining Core operation gaps

No Cloud Run deploy, Secret Manager secret, Firestore write, GCS bucket, Cloud Tasks queue, Cloud Scheduler job, backup, or Terraform apply is part of P8.6.

## Core Admin

The static console lives at:

```text
apps/core-admin
```

It supports:

- Platform login through `POST /v1/auth/login`
- session check through `GET /v1/auth/session`
- organization selection
- organization creation for `platform_admin`
- member creation
- facility creation
- department creation
- patient creation
- product entitlement upsert
- data request create/update
- audit event review

The app uses:

- `halunasu_session` cookie
- `halunasu_csrf` cookie
- `x-csrf-token` header for protected mutations
- no Firebase client SDK
- no direct Firestore access

Run:

```bash
npm run test --workspace @halunasu/core-admin
```

## Synthetic E2E

The local E2E package lives at:

```text
packages/core-e2e
```

The main flow covers:

1. Signup application creation.
2. Email verification token consumption.
3. Admin password setup.
4. Platform login.
5. Facility creation.
6. Department creation.
7. Patient creation with Core patient identifiers.
8. Charting encounter creation.
9. Mock SOAP draft creation.
10. Fee session creation.
11. Mock fee calculation.
12. Referral draft creation.
13. PDF placeholder creation.
14. Data request creation.
15. Audit event verification.

The role/scope flow verifies:

- same-org viewer can read shared patient list
- same-org viewer cannot mutate Core admin records
- another org admin cannot read the first org
- `platform_admin` can list organizations

Run:

```bash
npm run test --workspace @halunasu/core-e2e
```

## Verification

Run:

```bash
npm run test --workspace @halunasu/core-admin
npm run test --workspace @halunasu/core-e2e
npm run test
npm run build
git diff --check
```

## Remaining Work Before P9

P8.6 is enough to proceed to old environment shutdown planning.

Still intentionally deferred:

- hosted Core Admin deployment
- production email delivery
- production Core IAM review
- automated data export/deletion/correction execution
- encrypted MFA secret storage
- Firestore backup enablement
- production restore drill
