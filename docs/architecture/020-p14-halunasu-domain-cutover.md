# P14 Halunasu Domain Cutover

Status: in progress, browser apps unblocked by Netlify API proxy; custom domains still waiting on Cloudflare DNS
Date: 2026-05-28
Cost profile: no new always-on resources; Cloud Run remains min instances 0 / max instances 1

## Purpose

P14 moves browser apps toward `halunasu.com` owned domains. P15 changed the active
browser runtime to use same-origin Netlify `/api/...` proxy routes, so login and
product flows no longer depend on browser-resolvable API custom domains.

## Completed

- Static app runtime endpoints now use same-origin API proxy paths:
  - STG/PROD: `/api/platform`, `/api/charting`, `/api/fee`, `/api/referral`
- Netlify `_redirects` maps those paths to raw Cloud Run `*.run.app` URLs from `config/runtime-proxy-targets.json`.
- Rebuilt and deployed STG/PROD static apps to the new Netlify sites.
- Created Cloud Run custom domain mappings for all STG/PROD public APIs.
- Updated Platform API deployment to use environment-specific cookie names with host-only cookie domains.
- Verified raw Cloud Run `/readyz` for all public APIs after redeploy.
- Verified Netlify same-origin proxy `/api/platform/readyz` and `/api/fee/readyz` on the production Fee app.

## Netlify Status

Assigned so far:

| Domain | Netlify site |
| --- | --- |
| `stg.halunasu.com` | `halunasu-lp-stg` |
| `admin.stg.halunasu.com` | `halunasu-admin-stg` |
| `fee.halunasu.com` | `halunasu-fee-prod` |

Pending because the current Netlify plan limits `custom_domain` changes to 3 per hour:

| Domain | Netlify site |
| --- | --- |
| `charting.stg.halunasu.com` | `halunasu-charting-stg` |
| `fee.stg.halunasu.com` | `halunasu-fee-stg` |
| `referral.stg.halunasu.com` | `halunasu-referral-stg` |
| `admin.halunasu.com` | `halunasu-admin-prod` |
| `charting.halunasu.com` | `halunasu-charting-prod` |
| `referral.halunasu.com` | `halunasu-referral-prod` |
| `halunasu.com` | `halunasu-lp-prod` |
| `www.halunasu.com` | `halunasu-lp-prod` alias |

Existing production LP remains on `harunas` until explicit final cutover.

## Cloud Run Domain Mappings

Public API mappings exist and are waiting on Cloudflare DNS records for certificate
provisioning. They are no longer required by the static app runtime while Netlify
same-origin proxying is active:

| Domain | Target |
| --- | --- |
| `api.stg.halunasu.com` | `ghs.googlehosted.com` |
| `charting-api.stg.halunasu.com` | `ghs.googlehosted.com` |
| `fee-api.stg.halunasu.com` | `ghs.googlehosted.com` |
| `referral-api.stg.halunasu.com` | `ghs.googlehosted.com` |
| `api.halunasu.com` | `ghs.googlehosted.com` |
| `charting-api.halunasu.com` | `ghs.googlehosted.com` |
| `fee-api.halunasu.com` | `ghs.googlehosted.com` |
| `referral-api.halunasu.com` | `ghs.googlehosted.com` |

## Cloudflare DNS

Required records are listed in:

```text
config/cloudflare-dns-records.json
```

Use DNS-only records at least until certificates are active. Cloudflare API credentials are not present in the local environment, so DNS changes were not automated.

## Remaining Steps

1. Add Cloudflare DNS web records from `config/cloudflare-dns-records.json`.
2. Wait for Netlify custom-domain rate limit to reset and attach the remaining Netlify domains.
3. Transfer `halunasu.com` and `www.halunasu.com` from old `harunas` to `halunasu-lp-prod` after confirming the new production LP deploy.
4. Wait for Netlify certificates to become active.
5. Optionally keep or remove Cloud Run API custom domains. The active static apps use Netlify proxy routes and do not require API DNS.
6. Verify:
   - `https://stg.halunasu.com`
   - `https://admin.stg.halunasu.com`
   - `https://charting.stg.halunasu.com`
   - `https://fee.stg.halunasu.com`
   - `https://referral.stg.halunasu.com`
   - same-origin `/api/platform/readyz`
   - same-origin product API `/readyz`
7. Run STG browser login/product flow.
8. Repeat final browser verification for production domains.
