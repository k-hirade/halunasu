# Fee API

Platform-session-validated medical fee calculation API.

P5 local scope:

- uses the signed Platform session from `platform-api`
- checks `product_entitlements/fee`
- uses `productRoles.fee` or global `org_admin`
- stores fee product records under `organizations/{orgId}/fee_sessions`
- resolves `patientId`, `facilityId`, and `departmentId` from Platform master data
- stores patient/facility/department snapshots for historical reproducibility
- runs only deterministic `mock` calculation

No production path uses `OPERATOR_ACCOUNTS_JSON`, old `tenant_id`, OpenAI keys, Cloud Tasks, or GCS.

## Local

```bash
npm run test --workspace @halunasu/fee-api
npm run start --workspace @halunasu/fee-api
```

The default store backend is memory. Firestore is available only when `FEE_STORE_BACKEND=firestore` or `PLATFORM_STORE_BACKEND=firestore` is explicitly set.

In split GCP deployments, fee product data must use the fee project while
Platform/Core lookups use the Core project:

```text
GOOGLE_CLOUD_PROJECT=halunasu-fee-stg
FEE_STORE_BACKEND=firestore
PLATFORM_STORE_BACKEND=firestore
PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg
```
