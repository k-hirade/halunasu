# P14 Halunasu Domain Cutover

Status: in progress, waiting on Netlify custom-domain rate limit and Cloudflare DNS updates
Date: 2026-05-28
Cost profile: no new always-on resources; Cloud Run remains min instances 0 / max instances 1

## Purpose

P14 moves browser apps and APIs from temporary `*.netlify.app` and raw `*.run.app` URLs to `halunasu.com` owned domains.

## Completed

- Static app runtime endpoints now use Halunasu API domains:
  - STG: `api.stg.halunasu.com`, `charting-api.stg.halunasu.com`, `fee-api.stg.halunasu.com`, `referral-api.stg.halunasu.com`
  - PROD: `api.halunasu.com`, `charting-api.halunasu.com`, `fee-api.halunasu.com`, `referral-api.halunasu.com`
- Rebuilt and deployed STG/PROD static apps to the new Netlify sites.
- Created Cloud Run custom domain mappings for all STG/PROD public APIs.
- Redeployed Cloud Run APIs with environment-specific cookie names and domains.
- Verified raw Cloud Run `/readyz` for all public APIs after redeploy.

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

All public API mappings exist and are waiting on Cloudflare DNS records for certificate provisioning:

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

1. Add Cloudflare DNS records from `config/cloudflare-dns-records.json`.
2. Wait for Netlify custom-domain rate limit to reset and attach the remaining Netlify domains.
3. Transfer `halunasu.com` and `www.halunasu.com` from old `harunas` to `halunasu-lp-prod` after confirming the new production LP deploy.
4. Wait for Netlify and Cloud Run certificates to become active.
5. Verify:
   - `https://stg.halunasu.com`
   - `https://admin.stg.halunasu.com`
   - `https://charting.stg.halunasu.com`
   - `https://fee.stg.halunasu.com`
   - `https://referral.stg.halunasu.com`
   - all STG API `/readyz`
6. Run STG browser login/product flow.
7. Repeat final browser verification for production domains.
