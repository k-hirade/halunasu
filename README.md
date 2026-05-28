# Halunasu

Halunasu is the unified medical platform repository for:

- Charting / SOAP generation
- Medical fee calculation
- Referral letter creation
- Shared platform data such as organizations, facilities, departments, members, login identities, billing state, and patient index

This repository starts with architecture documentation before code migration.

## Current Goal

Define the target architecture before moving code from the existing source repositories:

- `k-hirade/medical` via local `../halunasu-medical-record`
- `k-hirade/medical-fee-calculation` via local `../halunasu-fee-calculation`
- `k-hirade/medical-lp` via local `../medical-lp`

The first architecture document is:

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

Historical product projects remain migration sources until the new core environment is ready.

## Local Commands

```bash
npm run test
npm run start:platform-api
npm run start:charting-api
npm run start:fee-api
npm run start:referral-api
```

## Staging Deploy

The first staging deploy is intentionally guarded for cost control.

```bash
scripts/deploy_platform_api_stg_zero_cost.sh
```

The command above is dry-run only. It prints the build/deploy commands and creates nothing. Use `--apply` only after confirming the required existing resources and expected cost impact. The first staging deploy is not public because `platform-api` auth is not implemented yet.

## Source Repositories

The current local source repositories are:

- `../halunasu-medical-record` for the existing charting and platform-like code
- `../halunasu-fee-calculation` for the existing fee calculation code
- `../medical-lp` for the existing LP

Their GitHub remotes remain unchanged until code migration is complete.
