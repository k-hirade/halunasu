# P13 Netlify Sites

Status: started
Date: 2026-05-28
Cost profile: Netlify static sites only, no new GCP resources

## Purpose

P13 adds new Netlify sites in the existing GENNAI Netlify team for the unified Halunasu monorepo.

Existing production/staging sites are intentionally left untouched:

- `harunas`
- `harunas-stg`
- `harunas-app`
- `medical-fee-calculation-stg`

The new sites let the monorepo be deployed and verified before DNS/custom-domain cutover.

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

## Current Limits

- Custom domains are not attached yet.
- Custom domains are only partially attached because Netlify limits `custom_domain` changes to 3 per hour on the current plan.
- `halunasu.com` and `www.halunasu.com` remain attached to the existing `harunas` Netlify site until explicit production LP cutover.
- DNS records are not changed yet.
- Git-based automatic deploys are not configured yet.
- The temporary `*.netlify.app` URLs are for static page verification only.
- Full login/product browser flows still require API custom domains and cookie env rollout.

## Next Steps

1. Deploy STG static output to the new Netlify STG sites.
2. Verify STG pages load from the temporary Netlify URLs.
3. Map API custom domains to Cloud Run.
4. Redeploy Cloud Run with custom cookie/CORS env vars.
5. Attach STG web custom domains and update DNS.
6. Run browser E2E through STG custom domains.
7. Repeat for production after STG passes.
