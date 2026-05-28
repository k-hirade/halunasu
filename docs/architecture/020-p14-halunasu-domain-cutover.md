# P14 Halunasu Domain Cutover

Status: in progress, browser apps unblocked by Netlify API proxy; Netlify custom domains and web DNS are attached; production admin/charting/referral certificates remain pending
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
| `referral.halunasu.com` | `halunasu-referral-prod` |
| `stg.app.halunasu.com` | `halunasu-charting-stg` alias |
| `mfc-stg.halunasu.com` | `halunasu-fee-stg` alias |

No Netlify domain assignments are pending as of 2026-05-29.

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
On 2026-05-29, `stg.app.halunasu.com` and `mfc-stg.halunasu.com` were assigned
to the new staging sites.

Cloudflare web DNS observations on 2026-05-29:

| Domain | Current DNS target | Required target |
| --- | --- | --- |
| `halunasu.com` | Netlify A records `75.2.60.5`, `99.83.231.61` | OK |
| `www.halunasu.com` | `halunasu-lp-prod.netlify.app` | OK |
| `admin.halunasu.com` | `halunasu-admin-prod.netlify.app` | OK |
| `charting.halunasu.com` | `halunasu-charting-prod.netlify.app` | OK |
| `app.halunasu.com` | `halunasu-charting-prod.netlify.app` | OK |
| `fee.halunasu.com` | `halunasu-fee-prod.netlify.app` | OK |
| `referral.halunasu.com` | `halunasu-referral-prod.netlify.app` | OK |
| `stg.halunasu.com` | `halunasu-lp-stg.netlify.app` | OK |
| `admin.stg.halunasu.com` | `halunasu-admin-stg.netlify.app` | OK |
| `charting.stg.halunasu.com` | `halunasu-charting-stg.netlify.app` | OK |
| `stg.app.halunasu.com` | `halunasu-charting-stg.netlify.app` | OK |
| `fee.stg.halunasu.com` | `halunasu-fee-stg.netlify.app` | OK |
| `mfc-stg.halunasu.com` | `halunasu-fee-stg.netlify.app` | OK |
| `referral.stg.halunasu.com` | `halunasu-referral-stg.netlify.app` | OK |

HTTPS observations on 2026-05-29:

| Domain group | Status |
| --- | --- |
| `halunasu.com`, `www.halunasu.com`, `fee.halunasu.com`, all staging web domains and staging aliases | HTTPS OK |
| `admin.halunasu.com`, `charting.halunasu.com`, `referral.halunasu.com` | DNS OK, Netlify certificate still pending |

## Cloud Run Domain Mappings

Public API mappings exist, but Cloudflare API DNS records are unresolved as of
2026-05-29. They are no longer required by the static app runtime while Netlify
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

1. Wait for Netlify certificates to become active for `admin.halunasu.com`, `charting.halunasu.com`, and `referral.halunasu.com`.
2. Optionally keep or remove Cloud Run API custom domains. The active static apps use Netlify proxy routes and do not require API DNS.
3. Verify:
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
4. Run STG browser login/product flow.
5. Repeat final browser verification for production domains after certificates are active.
