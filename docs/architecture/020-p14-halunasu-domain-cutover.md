# P14 Halunasu Domain Cutover

Status: complete for browser-app migration; optional API custom domains remain unresolved and unused by the active runtime
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
- Verified HTTPS for all production and staging web domains, including legacy aliases.
- Verified production login and initial product data reads through custom domains for Admin, Charting, Fee, Referral, and the legacy `app.halunasu.com` Charting alias.

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
| All production web domains and aliases | HTTPS OK |
| All staging web domains and aliases | HTTPS OK |

Production app API observations on 2026-05-29:

| Domain | Verified checks |
| --- | --- |
| `admin.halunasu.com` | login, session |
| `charting.halunasu.com` | login, session, patients, facilities, departments, encounters |
| `app.halunasu.com` | login, session, patients, facilities, departments, encounters |
| `fee.halunasu.com` | login, session, patients, facilities, departments, fee sessions |
| `referral.halunasu.com` | login, session, patients, facilities, departments, referrals |

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

## Remaining Optional Steps

1. Decide whether to keep or remove Cloud Run API custom domain mappings. The active static apps use Netlify proxy routes and do not require API DNS.
2. If keeping API custom domains, add Cloudflare DNS records for the `*-api` names in `config/cloudflare-dns-records.json`.
3. Optionally run a full browser-level STG/PROD regression after future UI changes; API-level custom-domain migration checks are complete.
