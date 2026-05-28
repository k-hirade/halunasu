# Fee Contracts

Shared request validation for the fee calculation product.

The v1 contract uses Platform identifiers as the primary boundary:

- `orgId` comes from the signed Platform session.
- `patientId` points to `organizations/{orgId}/patients/{patientId}`.
- `patientRef` is kept only as a source-system alias for imported chart data.
- `facilityId` points to Platform `facilities`; the API resolves `medicalInstitutionCode` and `regionalBureau` from that record.

The contract intentionally accepts a few legacy snake_case aliases while normalizing to camelCase. That keeps migration possible without making `tenant_id` a production boundary.
