# P12 Static Hosting And Domain Plan

Status: started
Date: 2026-05-28
Cost profile: code/config only so far, no new GCP resources

## Purpose

P12 prepares frontend hosting and custom domains without adding paid infrastructure.

The key architectural constraint is browser cookies. Platform issues the signed session cookie, and product APIs must receive the same cookie. Therefore real STG/PROD browser flows should not use raw `*.run.app` API URLs. They should use Halunasu-owned API subdomains with shared same-site cookies.

## Domain Map

The planned domain map lives in:

```text
config/runtime-domains.json
```

### Production

| Surface | Domain |
| --- | --- |
| LP | `https://www.halunasu.com` |
| Core Admin | `https://admin.halunasu.com` |
| Charting app | `https://charting.halunasu.com` |
| Fee app | `https://fee.halunasu.com` |
| Referral app | `https://referral.halunasu.com` |
| Platform API | `https://api.halunasu.com` |
| Charting API | `https://charting-api.halunasu.com` |
| Fee API | `https://fee-api.halunasu.com` |
| Referral API | `https://referral-api.halunasu.com` |

Production cookies:

- Domain: `.halunasu.com`
- Session cookie: `halunasu_session`
- CSRF cookie: `halunasu_csrf`

### Staging

| Surface | Domain |
| --- | --- |
| LP | `https://stg.halunasu.com` |
| Core Admin | `https://admin.stg.halunasu.com` |
| Charting app | `https://charting.stg.halunasu.com` |
| Fee app | `https://fee.stg.halunasu.com` |
| Referral app | `https://referral.stg.halunasu.com` |
| Platform API | `https://api.stg.halunasu.com` |
| Charting API | `https://charting-api.stg.halunasu.com` |
| Fee API | `https://fee-api.stg.halunasu.com` |
| Referral API | `https://referral-api.stg.halunasu.com` |

Staging cookies:

- Domain: `.stg.halunasu.com`
- Session cookie: `halunasu_stg_session`
- CSRF cookie: `halunasu_stg_csrf`

Staging uses separate cookie names so production `.halunasu.com` cookies cannot collide with staging requests.

## Implementation Status

Implemented in code:

- Platform API can set `APP_COOKIE_DOMAIN`.
- Platform API and product APIs can use `APP_SESSION_COOKIE_NAME` and `APP_CSRF_COOKIE_NAME`.
- Platform API now returns credentialed CORS headers for all `/v1/*` routes, not only signup.
- Product APIs allow the planned production and staging app origins.
- Existing Netlify preview and localhost origins remain allowed for development.

Not yet applied to GCP:

- Cloud Run custom domain mappings are not created yet.
- DNS records are not created yet.
- Cloud Run services are not redeployed with custom cookie env vars yet.
- Static app hosting targets are not created yet.

## Recommended Hosting

Use the existing Netlify operation for frontend static hosting:

- Do not introduce a new frontend hosting provider for this phase.
- Reuse the existing Netlify account/team and connect the new monorepo apps there.
- Add separate Netlify sites per app/domain when operationally simpler than path-based routing.
- It keeps GCP monthly cost unchanged.
- Custom domains are free on Netlify.
- Existing LP already has `netlify.toml`.

Use Cloud Run only for APIs. Avoid HTTPS Load Balancer, Cloud CDN, Cloud Storage website hosting with load balancer, Cloud SQL, VMs, and always-on services for this phase.

## Next Steps

1. Configure the existing Netlify operation for the five static apps.
2. Create Cloud Run custom domain mappings for API services.
3. Add DNS records for app and API domains.
4. Redeploy Cloud Run services with the correct cookie env vars per environment.
5. Switch frontend runtime endpoint config from raw Cloud Run URLs to custom API domains.
6. Run browser E2E on STG login, patient creation, charting, fee, and referral flows.
