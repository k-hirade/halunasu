# P11 Frontend Runtime Wiring

Status: done, switched to Halunasu API domains in P14
Date: 2026-05-28
Cost profile: local build only, no GCP resources

## Purpose

P11 connects the static frontend apps to the deployed STG/PROD APIs without hard-coding one environment into source HTML.

The source apps keep empty runtime meta tags. The build script creates environment-specific static output under `dist/runtime-apps`, which is ignored by git and can be deployed to Netlify or any static host.

## Runtime Endpoints

The canonical endpoint map lives in:

```text
config/runtime-endpoints.json
```

Current environments:

| Environment | Platform API | Charting API | Fee API | Referral API |
| --- | --- | --- | --- | --- |
| STG | `platform-api-stg` | `charting-api-stg` | `fee-api-stg` | `referral-api-stg` |
| PROD | `platform-api-prod` | `charting-api-prod` | `fee-api-prod` | `referral-api-prod` |

## Build

Run:

```bash
npm run build:runtime-apps
```

This writes:

```text
dist/runtime-apps/stg/lp
dist/runtime-apps/stg/core-admin
dist/runtime-apps/stg/charting-web
dist/runtime-apps/stg/fee-web
dist/runtime-apps/stg/referral-web

dist/runtime-apps/prod/lp
dist/runtime-apps/prod/core-admin
dist/runtime-apps/prod/charting-web
dist/runtime-apps/prod/fee-web
dist/runtime-apps/prod/referral-web
```

Each generated HTML file receives the correct runtime meta values:

- `halunasu-platform-api-base-url`
- `halunasu-charting-api-base-url`
- `halunasu-fee-api-base-url`
- `halunasu-referral-api-base-url`

## Deployment Notes

- Deploy the generated app directory, not the source app directory, when using real STG/PROD APIs.
- `dist/runtime-apps` is intentionally untracked.
- Generated apps point at Halunasu API domains, not raw Cloud Run `*.run.app` URLs.
- DNS and Cloud Run custom domain mappings must be complete before browser flows use those domains.
- Product app login depends on Platform session cookies. Keep API and app origins aligned with the CORS allowlist before customer use.

## Next Work

- Choose the static hosting target for each app.
- Map custom app/API domains.
- Update service CORS allowlists if the final app origins differ from `halunasu.com` or Netlify deploy preview domains.
- Add live browser E2E against one STG generated app after hosting is selected.
