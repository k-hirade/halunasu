# Halunasu

Halunasu is the unified medical platform repository for:

- Charting / SOAP generation
- Medical fee calculation
- Referral letter creation
- Shared platform data such as organizations, facilities, departments, members, login identities, billing state, and patient index

This repository is now the active unified application repository.

## Architecture Documents

- [ASIS / TOBE Architecture](docs/architecture/001-asis-tobe-architecture.md)
- [Platform Data Model](docs/architecture/002-platform-data-model.md)
- [GCP Environment Plan](docs/architecture/003-gcp-environment-plan.md)
- [Migration Execution Plan](docs/architecture/004-migration-execution-plan.md)
- [Rearchitecture Completion Roadmap](docs/architecture/005-rearchitecture-completion-roadmap.md)

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

## GCP Projects

Target core projects:

- Staging: `medical-core-stg`
- Production/core: `medical-core-497610`

Historical product projects are no longer active runtime targets for the migrated browser apps.

## Local Commands

```bash
npm run test
npm run start:platform-api
npm run start:charting-api
npm run start:fee-api
npm run start:referral-api
```

## Deploy

Cloud Run and Netlify deploy scripts are guarded for cost control. Cloud Run
services default to min instances `0` and max instances `1`.

```bash
npm run build:runtime-apps
npm run deploy:netlify-static -- --env stg --apply
npm run deploy:netlify-static -- --env prod --apply
```

## Migration Status

The historical local source clones were removed after the Halunasu monorepo and
custom-domain cutover were verified. New work should happen in this repository.
