# P4 Charting Migration Runbook

Status: complete for local code
Date: 2026-05-28
Owner: Halunasu platform

## Purpose

P4 moves charting behavior into the new architecture without bringing over the old charting-owned signup, organization provisioning, billing, or runtime bootstrap paths.

The implemented boundary is:

- Platform owns auth, organizations, members, facilities, departments, patients, and product entitlements.
- Charting owns encounters and SOAP drafts.
- Charting references Platform master IDs and stores snapshots needed for historical reproducibility.

## Implemented Scope

Apps:

- `apps/charting-web`
  - Static first-pass charting UI.
  - Logs in through Platform `POST /v1/auth/login`.
  - Creates patients through `charting-api`, which delegates to Platform.
  - Creates encounters with `patientId`, `facilityId`, and `departmentId`.
  - Creates mock SOAP drafts.

Services:

- `services/charting-api`
  - Verifies signed Platform `halunasu_session`.
  - Checks current login identity token version.
  - Checks `charting` product entitlement.
  - Requires Platform CSRF token on mutating browser requests.
  - Creates/lists Platform patients via Platform store.
  - Creates/lists/updates product-owned charting encounters.
  - Creates mock SOAP drafts under charting-owned encounter data.

- `services/charting-finalize`
  - Local/mock internal worker endpoint.
  - Kept undeployed in P4.
  - Does not add STT, OpenAI, Deepgram, Cloud Tasks, or GCS usage.

Packages:

- `packages/auth-client`
  - Verifies Platform session cookies for product services.
  - Enforces Platform CSRF.
  - Checks global/product roles from Platform session payload.

- `packages/charting-contracts`
  - Charting request validators.
  - Does not own Platform master schemas.

- `packages/charting-core`
  - Builds charting encounters.
  - Patches charting-owned metadata.
  - Builds mock SOAP drafts.

## API Surface

```text
GET /healthz
GET /readyz

GET /v1/charting/context

GET /v1/charting/patients
POST /v1/charting/patients

GET /v1/charting/encounters
POST /v1/charting/encounters
GET /v1/charting/encounters/{encounterId}
PATCH /v1/charting/encounters/{encounterId}
POST /v1/charting/encounters/{encounterId}/mock-soap
GET /v1/charting/encounters/{encounterId}/soap-drafts
```

Charting encounters are stored under:

```text
organizations/{orgId}/charting_encounters/{encounterId}
```

Each encounter includes:

- `orgId`
- `patientId`
- `patientSnapshot`
- `facilityId`
- `departmentId`
- `createdByMemberId`
- `doctorMemberId`
- charting-owned transcript/notes/status/SOAP draft references

## Local Verification

Commands run:

```bash
npm test
npm run build
```

Result:

- `@halunasu/charting-web` static validation passed.
- `@halunasu/charting-api` passed 5 tests.
- `@halunasu/charting-finalize` passed 2 tests.
- `@halunasu/auth-client` passed 3 tests.
- `@halunasu/charting-contracts` passed 3 tests.
- `@halunasu/charting-core` passed 3 tests.
- Existing P1-P3 workspaces continued to pass.

## Cost Guardrails

P4 intentionally did not deploy new Cloud Run services.

No new GCP resources were created:

- No Terraform.
- No Cloud Run deploy for `charting-api`.
- No Cloud Run deploy for `charting-finalize`.
- No OpenAI or Deepgram secrets.
- No Cloud Tasks.
- No GCS bucket for raw audio.
- No live STT.

The implementation uses mock SOAP generation only.

## Deferred

- Porting the full old Next.js charting interface.
- Live realtime audio/WebSocket gateway.
- Final transcript pass.
- OpenAI SOAP generation.
- Raw audio storage and retention cleanup.
- Staging deploy of `charting-api`.
- Async Cloud Tasks invocation of `charting-finalize`.

These should be introduced only when the UI migration needs them and after a separate cost review.
