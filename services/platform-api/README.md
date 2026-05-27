# Platform API

Shared API for Halunasu platform concerns:

- signup
- authentication
- session / CSRF / MFA
- organizations
- members
- facilities
- departments
- patients
- product entitlements
- audit events

Current skeleton endpoints:

```text
GET /healthz
GET /readyz
GET /v1/organizations
POST /v1/organizations
GET /v1/organizations/{orgId}
GET /v1/organizations/{orgId}/members
POST /v1/organizations/{orgId}/members
GET /v1/organizations/{orgId}/members/{memberId}
GET /v1/organizations/{orgId}/patients
POST /v1/organizations/{orgId}/patients
GET /v1/organizations/{orgId}/patients/{patientId}
```

The current implementation uses an in-memory store. Firestore persistence is the next implementation step.

Local run:

```bash
npm run start --workspace @halunasu/platform-api
```

Default local project:

```text
medical-core-stg
```
