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
```

Local run:

```bash
npm run start --workspace @halunasu/platform-api
```

Default local project:

```text
medical-core-stg
```

