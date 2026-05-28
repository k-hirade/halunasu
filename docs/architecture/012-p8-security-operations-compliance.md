# P8 Security Operations Compliance

Status: local implementation complete
Date: 2026-05-28
Cost profile: local only, no new GCP resources

## Scope

P8 establishes the security and operations baseline for pre-customer development.

Implemented locally:

- static `security-boundaries` tests
- PHI-safe logging policy
- audit `safePayload` policy
- data request model for access/export/deletion/correction workflows
- secure cookie default outside local/test
- direct Firestore client access guardrails
- backup/restore plan without enabling scheduled backups
- incident response runbook
- IAM and Cloud Run auth review checklist
- dependency/security scanning policy

Deferred intentionally:

- logging sinks and exports
- scheduled backups
- new Cloud Run deploys
- new Secret Manager secrets
- GCS buckets
- third-party security tooling

## Security Boundary Tests

Run:

```bash
npm run test --workspace @halunasu/security-boundaries
npm run test
npm run build
```

The tests assert:

- API responses use `cache-control: no-store`
- API responses use `x-content-type-options: nosniff`
- CORS does not use wildcard origins
- product APIs use `requireProductContext`
- mutating product routes use CSRF helpers
- Platform login/signup rate limit code remains present
- production-like session cookies default to `Secure`
- browser apps do not import Firebase or Firestore client SDKs
- Firestore Admin SDK usage stays inside server `store/firestore-store.js` adapters
- service runtime code does not log request or clinical payloads
- audit `safePayload` blocks avoid obvious PHI fields

## PHI-Safe Logging Policy

Runtime logs may contain:

- service startup message
- route-level status metadata if added later
- non-PHI IDs only when operationally needed
- error codes and generic messages

Runtime logs must not contain:

- patient names
- birth dates
- transcripts
- clinical summaries
- referral purpose/body
- medication/order free text
- raw request bodies
- generated SOAP, receipt, referral, or PDF text
- secrets, tokens, cookies, CSRF tokens, MFA secrets, password setup tokens

Error responses must return generic server errors for 500s and must not echo raw request bodies.

## Audit Payload Policy

`audit_events.safePayload` is for low-risk operational metadata only.

Allowed examples:

- `patientId`
- `memberId`
- `facilityId`
- `departmentId`
- `encounterId`
- `feeSessionId`
- `referralId`
- `productId`
- `changedFields`
- `provider`
- non-PHI status and count fields

Forbidden examples:

- patient display names
- birth dates
- transcript text
- clinical summary text
- referral body text
- diagnosis/medication free text
- recipient doctor or institution names
- generated document text
- raw tokens or cookies

## Data Requests

The initial data request model is a Platform-owned org subcollection:

```text
organizations/{orgId}/data_requests/{requestId}
```

Supported request types:

- `access`
- `export`
- `deletion`
- `correction`

Supported statuses:

- `submitted`
- `reviewing`
- `completed`
- `rejected`
- `cancelled`

The model can reference:

- `requesterMemberId`
- `requesterEmail`
- `subjectPatientId`
- `productIds`
- `reason`
- `safePayload`

Deletion workflow ownership:

- Platform owns organization, member, facility, department, patient index, and data request records.
- Charting owns encounters, transcripts, SOAP drafts, and charting artifacts.
- Fee owns fee sessions, extraction/calculation outputs, receipt artifacts, and fee-specific imports.
- Referral owns referral drafts, recipient snapshots, PDF placeholders, and referral artifacts.

No automated deletion worker is created in P8. Until production readiness, deletion requests are tracked as records/contracts and executed manually with a documented checklist.

## Retention Defaults

Pre-customer local/staging defaults:

- avoid real PHI
- synthetic data only
- delete test orgs manually after smoke tests
- keep no long-lived generated artifacts unless needed for debugging
- do not create GCS artifact buckets until a product flow requires them

Production retention must be confirmed before first customer onboarding.

## Backup And Restore Plan

No scheduled backup is enabled in P8.

Before first real PHI:

1. Choose Firestore backup strategy for `medical-core-497610`.
2. Confirm expected monthly cost.
3. Document backup schedule and retention.
4. Run restore drill into a non-production project.
5. Verify Platform and product records restore together.
6. Verify no restored data is exposed to public unauthenticated endpoints.

Restore drill acceptance:

- one org restored
- one patient restored
- one charting encounter restored
- one fee session restored
- one referral restored
- audit events restored or explicitly documented as out of scope

## Incident Runbook

For suspected PHI exposure or unauthorized access:

1. Stop the affected public surface if needed.
2. Preserve logs and deployment metadata without expanding access.
3. Rotate affected secrets or session signing secret if exposure is plausible.
4. Revoke impacted member sessions by token version.
5. Identify affected orgs, patients, products, and time range.
6. Record an internal incident report.
7. Patch and test the fix.
8. Deploy only after the fix is verified.
9. Prepare customer/regulatory notification if required.

Do not copy PHI into Slack, issue trackers, commit messages, or audit `safePayload`.

## IAM And Cloud Run Auth Checklist

Before any staging or production product API deploy:

- Cloud Run `min-instances=0`
- staging `max-instances=1`
- Cloud Run ingress and auth reviewed
- no public unauthenticated product API unless app-level auth is active and tested
- runtime service account has only required Firestore/Secret access
- no product service account can access unrelated future GCS buckets
- Secret Manager access granted per service, not broadly
- no API keys or secrets in repository files
- no Terraform apply until explicitly approved

## Dependency And Security Scanning

Local P8 baseline:

```bash
npm run test
npm run build
git diff --check
```

Before production readiness:

- run `npm audit` and triage findings
- run Python dependency review after Python optional dependencies are finalized
- run GitHub secret scanning on the repository
- document accepted risks

Do not add paid scanning services until production launch planning requires them.
