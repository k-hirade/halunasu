# Charting API

Target location for the current realtime charting gateway from `halunasu-medical-record/services/gateway`.

This service should validate Platform sessions and own charting product records only.

Implemented P4 API surface:

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
POST /v1/charting/encounters/{encounterId}/soap-drafts/generate
GET /v1/charting/encounters/{encounterId}/soap-drafts
```

Auth is Platform-owned. This service verifies the signed `halunasu_session`
cookie, checks current login identity token version, checks `charting` product
entitlement, and requires the Platform CSRF token on mutating browser requests.

Patients are created/read through the Platform store. Charting encounters and
SOAP drafts are product-owned records under:

```text
organizations/{orgId}/charting_encounters/{encounterId}
```

In split GCP deployments, charting product data must use the charting project
while Platform/Core lookups use the Core project:

```text
GOOGLE_CLOUD_PROJECT=halunasu-charting-stg
CHARTING_STORE_BACKEND=firestore
PLATFORM_STORE_BACKEND=firestore
PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg
```
