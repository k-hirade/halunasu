# P11 Frontend Runtime Wiring

Status: done, switched to same-origin Netlify API proxy in P15
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

Current browser-facing endpoints:

| Environment | Platform API | Charting API | Fee API | Referral API |
| --- | --- | --- | --- | --- |
| STG | `/api/platform` | `/api/charting` | `/api/fee` | `/api/referral` |
| PROD | `/api/platform` | `/api/charting` | `/api/fee` | `/api/referral` |

The Netlify proxy target map lives in:

```text
config/runtime-proxy-targets.json
```

Generated `_redirects` files route those same-origin paths to the environment's
raw Cloud Run `*.run.app` service URLs.

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
- Generated apps point at same-origin `/api/...` paths, not browser-visible API domains.
- Netlify `_redirects` proxies those paths to raw Cloud Run `*.run.app` URLs.
- Product app login depends on Platform session cookies. Active deployment uses host-only cookies so both Netlify default domains and future `halunasu.com` app domains work without cross-site cookie rejection.

## Next Work

- Choose the static hosting target for each app.
- Finish custom app DNS for `halunasu.com` domains.
- Keep API custom domains as optional; static apps do not depend on them while the Netlify proxy remains in place.
- Add live browser E2E against one STG generated app.
