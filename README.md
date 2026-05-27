# Halunasu

Halunasu is the unified medical platform repository for:

- Charting / SOAP generation
- Medical fee calculation
- Referral letter creation
- Shared platform data such as organizations, facilities, departments, members, login identities, billing state, and patient index

This repository starts with architecture documentation before code migration.

## Current Goal

Define the target architecture before moving code from the existing repositories:

- `medical`
- `medical-fee-calculation`
- `medical-lp`

The first architecture document is:

- [ASIS / TOBE Architecture](docs/architecture/001-asis-tobe-architecture.md)

## Initial Repository Shape

```text
halunasu/
  apps/
    lp/
    charting-web/
    fee-web/
    referral-web/
  services/
    platform-api/
    charting-api/
    charting-finalize/
    fee-api/
    referral-api/
  packages/
    platform-contracts/
    auth-client/
    web-ui/
    firestore-schema/
  python/
    medical_fee_calculation/
  infra/
    gcp/
  docs/
    architecture/
```

## Architecture Principle

Share platform master data. Do not merge product-owned clinical artifacts.

Common platform data should be owned by `platform-api`. Product services should reference shared IDs and keep product-specific snapshots for historical reproducibility.

