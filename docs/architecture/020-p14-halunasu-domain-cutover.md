# P14 Halunasu Domain Cutover

Status: in progress, browser apps unblocked by Netlify API proxy; most production web domains are attached; remaining domains are gated by Netlify custom-domain rate limits and Cloudflare DNS cleanup
Date: 2026-05-29
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
| `charting.stg.halunasu.com` | `halunasu-charting-stg` |
| `fee.stg.halunasu.com` | `halunasu-fee-stg` |
| `referral.stg.halunasu.com` | `halunasu-referral-stg` |
| `halunasu.com` | `halunasu-lp-prod` |
| `www.halunasu.com` | `halunasu-lp-prod` alias |
| `admin.halunasu.com` | `halunasu-admin-prod` |
| `charting.halunasu.com` | `halunasu-charting-prod` |
| `app.halunasu.com` | `halunasu-charting-prod` alias |
| `fee.halunasu.com` | `halunasu-fee-prod` |

Pending because the current Netlify plan limits `custom_domain` changes to 3 per hour:

| Domain | Netlify site |
| --- | --- |
| `referral.halunasu.com` | `halunasu-referral-prod` |
| `stg.app.halunasu.com` | `halunasu-charting-stg` alias |
| `mfc-stg.halunasu.com` | `halunasu-fee-stg` alias |

The old `harunas`, `harunas-app`, `harunas-stg`, and
`medical-fee-calculation-stg` Netlify sites no longer own custom domains.

Legacy aliases to migrate:

| Legacy domain | New Netlify site |
| --- | --- |
| `app.halunasu.com` | `halunasu-charting-prod` |
| `stg.app.halunasu.com` | `halunasu-charting-stg` |
| `mfc-stg.halunasu.com` | `halunasu-fee-stg` |

On 2026-05-28, those legacy domains were removed from the old Netlify sites.
On 2026-05-29, `app.halunasu.com` was assigned to `halunasu-charting-prod`.
Assigning the remaining legacy aliases is gated by the current Netlify Free plan
custom domain rate limit.

Cloudflare DNS observations on 2026-05-29:

| Domain | Current DNS target | Required target |
| --- | --- | --- |
| `halunasu.com` | Netlify A records `75.2.60.5`, `99.83.231.61` | OK |
| `www.halunasu.com` | `harunas.netlify.app` | `halunasu-lp-prod.netlify.app` |
| `app.halunasu.com` | `harunas-app.netlify.app` | `halunasu-charting-prod.netlify.app` |
| `stg.app.halunasu.com` | `harunas-stg.netlify.app` | `halunasu-charting-stg.netlify.app` |
| `mfc-stg.halunasu.com` | `medical-fee-calculation-stg.netlify.app` | `halunasu-fee-stg.netlify.app` |
| `admin.halunasu.com` | unresolved | `halunasu-admin-prod.netlify.app` |
| `charting.halunasu.com` | unresolved | `halunasu-charting-prod.netlify.app` |
| `referral.halunasu.com` | unresolved | `halunasu-referral-prod.netlify.app` |

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

1. Fix Cloudflare DNS web records from `config/cloudflare-dns-records.json`.
2. Wait for Netlify custom-domain rate limit to reset and attach the remaining production and legacy alias domains.
3. Wait for Netlify certificates to become active.
4. Optionally keep or remove Cloud Run API custom domains. The active static apps use Netlify proxy routes and do not require API DNS.
5. Verify:
   - `https://stg.halunasu.com`
   - `https://admin.stg.halunasu.com`
   - `https://charting.stg.halunasu.com`
   - `https://fee.stg.halunasu.com`
   - `https://referral.stg.halunasu.com`
   - `https://halunasu.com`
   - `https://www.halunasu.com`
   - `https://admin.halunasu.com`
   - `https://charting.halunasu.com`
   - `https://app.halunasu.com`
   - `https://fee.halunasu.com`
   - `https://referral.halunasu.com`
   - same-origin `/api/platform/readyz`
   - same-origin product API `/readyz`
6. Run STG browser login/product flow.
7. Repeat final browser verification for production domains.
