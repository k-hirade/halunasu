# Charting Web

Target location for the current charting UI from `halunasu-medical-record/apps/web`.

This app should authenticate through Platform and call `charting-api` for product behavior.

P4 ships this as a static first-pass workspace so it adds no Next.js runtime or
deployment cost yet.

It supports:

- Platform login through `POST /v1/auth/login`
- Platform patient creation through `charting-api`
- charting encounter creation with `patientId`, `facilityId`, and `departmentId`
- mock SOAP draft creation

Local check:

```bash
npm test --workspace @halunasu/charting-web
```

When Platform API and Charting API run on different origins, open:

```text
index.html?platformApi=http://localhost:8080&chartingApi=http://localhost:8083
```
