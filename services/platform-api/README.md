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

Current endpoints:

```text
GET /healthz
GET /readyz

POST /v1/auth/login
POST /v1/auth/logout
GET /v1/auth/session
POST /v1/auth/mfa/enroll
POST /v1/auth/mfa/verify

GET /v1/signup/applications
POST /v1/signup/applications
GET /v1/signup/applications/{applicationId}
POST /v1/signup/verify-email
POST /v1/signup/setup-admin-password

GET /v1/organizations
POST /v1/organizations
GET /v1/organizations/{orgId}
PATCH /v1/organizations/{orgId}

GET /v1/organizations/{orgId}/members
POST /v1/organizations/{orgId}/members
GET /v1/organizations/{orgId}/members/{memberId}
PATCH /v1/organizations/{orgId}/members/{memberId}

GET /v1/organizations/{orgId}/facilities
POST /v1/organizations/{orgId}/facilities
GET /v1/organizations/{orgId}/facilities/{facilityId}
PATCH /v1/organizations/{orgId}/facilities/{facilityId}

GET /v1/organizations/{orgId}/departments
POST /v1/organizations/{orgId}/departments
GET /v1/organizations/{orgId}/departments/{departmentId}
PATCH /v1/organizations/{orgId}/departments/{departmentId}

GET /v1/organizations/{orgId}/patients
POST /v1/organizations/{orgId}/patients
GET /v1/organizations/{orgId}/patients/{patientId}
PATCH /v1/organizations/{orgId}/patients/{patientId}

GET /v1/organizations/{orgId}/product-entitlements
POST /v1/organizations/{orgId}/product-entitlements
GET /v1/organizations/{orgId}/product-entitlements/{productId}
PATCH /v1/organizations/{orgId}/product-entitlements/{productId}

GET /v1/organizations/{orgId}/audit-events
POST /v1/organizations/{orgId}/audit-events
GET /v1/organizations/{orgId}/audit-events/{eventId}
```

Member creation accepts an optional `password` field. When supplied, Platform creates a top-level
`login_identities/{organizationCode:loginId}` record with a scrypt password hash.

Auth uses:

- signed httpOnly `halunasu_session` cookie
- non-httpOnly `halunasu_csrf` cookie
- `x-csrf-token` header for mutating authenticated auth routes
- TOTP MFA enrollment/verification for privileged members

Login and signup application creation are rate-limited through the shared `rate_limits` store.
Mutating Platform routes write safe audit events without PHI-heavy payloads.

Signup flow:

1. `POST /v1/signup/applications` stores the application and creates a short-lived email verification token.
2. `POST /v1/signup/verify-email` consumes the email token, provisions an organization, initial admin member, login identity, and product entitlements.
3. `POST /v1/signup/setup-admin-password` consumes the setup token and sets the admin password.

Staging/local responses include the token values so the flow can be tested without an email provider. Production should send those tokens through a mailer instead of showing them in the browser.

Store backends:

```text
PLATFORM_STORE_BACKEND=memory
PLATFORM_STORE_BACKEND=firestore
```

Use `firestore` in `medical-core-stg` / `medical-core-497610` Cloud Run deployments. Local development defaults to `memory`.

Local run:

```bash
npm run start --workspace @halunasu/platform-api
```

Default local project:

```text
medical-core-stg
```

Firestore deployment requires Application Default Credentials locally, or the Cloud Run service account in GCP.

Do not deploy this service with unauthenticated public access until the P2 smoke checklist is complete.
