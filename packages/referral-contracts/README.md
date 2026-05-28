# Referral Contracts

Shared request validation for the referral letter product.

The v1 contract is Platform-first:

- `orgId` comes from the signed Platform session.
- `patientId`, `facilityId`, `departmentId`, and `authorMemberId` are Platform references.
- product data is stored under `organizations/{orgId}/referrals/{referralId}`.
- recipient institution and doctor details are copied as product-owned snapshots.
