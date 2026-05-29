# P13 Netlify Sites

Status: complete; old Netlify sites deleted after P14/P15 cutover
Date: 2026-05-28
Cost profile: Netlify static sites only, no new GCP resources

## Purpose

P13 adds new Netlify sites in the existing GENNAI Netlify team for the unified Halunasu monorepo.

Historical production/staging sites used during the transition:

- `harunas`
- `harunas-stg`
- `harunas-app`
- `medical-fee-calculation-stg`

The new sites let the monorepo be deployed and verified before DNS/custom-domain
cutover. After verification, the historical sites were deleted on 2026-05-29.

## Created Sites

The canonical site map lives in:

```text
config/netlify-sites.json
```

### Staging

| App | Netlify site | Temporary URL | Target domain |
| --- | --- | --- | --- |
| LP | `halunasu-lp-stg` | `https://halunasu-lp-stg.netlify.app` | `https://stg.halunasu.com` |
| Core Admin | `halunasu-admin-stg` | `https://halunasu-admin-stg.netlify.app` | `https://admin.stg.halunasu.com` |
| Charting | `halunasu-charting-stg` | `https://halunasu-charting-stg.netlify.app` | `https://charting.stg.halunasu.com` |
| Fee | `halunasu-fee-stg` | `https://halunasu-fee-stg.netlify.app` | `https://fee.stg.halunasu.com` |
| Referral | `halunasu-referral-stg` | `https://halunasu-referral-stg.netlify.app` | `https://referral.stg.halunasu.com` |

### Production

| App | Netlify site | Temporary URL | Target domain |
| --- | --- | --- | --- |
| LP | `halunasu-lp-prod` | `https://halunasu-lp-prod.netlify.app` | `https://halunasu.com` |
| Core Admin | `halunasu-admin-prod` | `https://halunasu-admin-prod.netlify.app` | `https://admin.halunasu.com` |
| Charting | `halunasu-charting-prod` | `https://halunasu-charting-prod.netlify.app` | `https://charting.halunasu.com` |
| Fee | `halunasu-fee-prod` | `https://halunasu-fee-prod.netlify.app` | `https://fee.halunasu.com` |
| Referral | `halunasu-referral-prod` | `https://halunasu-referral-prod.netlify.app` | `https://referral.halunasu.com` |

## Deploy Model

Use local prebuilt static output for the first cutover phase:

```sh
npm run build:runtime-apps
npm run deploy:netlify-static -- --env stg --apply
```

The deploy script is dry-run by default. It only deploys when `--apply` is provided.

This avoids Netlify build-minute usage during the initial migration and keeps the old sites available for rollback.

## Deployment Status

2026-05-28:

- Created all 10 new Netlify sites in the existing GENNAI team.
- Deployed STG static output to the five STG sites.
- Verified the five STG temporary URLs return `200` and security headers.
- Deployed production static output to the five production sites during P14, but production browser rollout remains gated on custom-domain and DNS verification.

| App | STG deploy ID |
| --- | --- |
| LP | `6a17e0627bbc46865cee7374` |
| Core Admin | `6a17e06be9b0595c385aa1af` |
| Charting | `6a17e0764aa1245403777f66` |
| Fee | `6a17e07f64f531580878bb83` |
| Referral | `6a17e0875bf1278f1605baf1` |

## Current State

- Custom domains are attached to the `halunasu-*` Netlify sites.
- Cloudflare web DNS points at the new Netlify sites.
- HTTPS is active for all production and staging web domains.
- The old `harunas`, `harunas-stg`, `harunas-app`, and
  `medical-fee-calculation-stg` Netlify sites were deleted on 2026-05-29.
- Git-based automatic deploys are not configured yet; static deploys are still
  driven by the local guarded deploy script.
