# Referral API

Platform-session-validated referral letter API.

P6 local scope:

- uses signed Platform session from `platform-api`
- checks `product_entitlements/referral`
- uses `productRoles.referral` or global `org_admin`
- stores product records under `organizations/{orgId}/referrals`
- resolves Platform `patientId`, `facilityId`, `departmentId`, and `authorMemberId`
- stores patient/facility/department/author snapshots
- stores recipient institution and doctor snapshots
- creates only an inline PDF placeholder

No Cloud Run deploy, GCS bucket, external PDF renderer, LLM, or sibling product reads are required for P6.

In split GCP deployments, referral product data must use the referral project
while Platform/Core lookups use the Core project:

```text
GOOGLE_CLOUD_PROJECT=halunasu-referral-stg
REFERRAL_STORE_BACKEND=firestore
PLATFORM_STORE_BACKEND=firestore
PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg
```
