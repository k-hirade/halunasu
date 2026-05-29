# P12 Static Hosting And Domain Plan

Status: complete; direct API custom domains superseded by Netlify same-origin proxying
Date: 2026-05-28
Cost profile: code/config only so far, no new GCP resources

## Purpose

P12 prepares frontend hosting and custom domains without adding paid infrastructure.

The key architectural constraint is browser cookies. Platform issues the signed session cookie, and product APIs must receive the same cookie. The active runtime now uses Netlify same-origin `/api/...` proxy routes, so the browser stores host-only cookies for the app origin and Netlify forwards product API requests to Cloud Run.

## Domain Map

The planned domain map lives in:

```text
config/runtime-domains.json
```

### Production

| Surface | Domain |
| --- | --- |
| LP | `https://halunasu.com` |
| Core Admin | `https://admin.halunasu.com` |
| Charting app | `https://charting.halunasu.com` |
| Fee app | `https://fee.halunasu.com` |
| Referral app | `https://referral.halunasu.com` |
| Platform/Product APIs | Same-origin `/api/...` proxy routes |

Production cookies:

- Domain: host-only on the active app origin
- Session cookie: `halunasu_session`
- CSRF cookie: `halunasu_csrf`

Existing production LP domain handling:

- `halunasu.com` is the primary LP domain.
- `www.halunasu.com` currently redirects to `halunasu.com` and should remain an alias/redirect after cutover.
- The domain is managed in Cloudflare and currently points to Netlify, so the LP cutover should transfer the Netlify custom-domain assignment rather than recreate DNS from scratch.

### Staging

| Surface | Domain |
| --- | --- |
| LP | `https://stg.halunasu.com` |
| Core Admin | `https://admin.stg.halunasu.com` |
| Charting app | `https://charting.stg.halunasu.com` |
| Fee app | `https://fee.stg.halunasu.com` |
| Referral app | `https://referral.stg.halunasu.com` |
| Platform/Product APIs | Same-origin `/api/...` proxy routes |

Staging cookies:

- Domain: host-only on the active app origin
- Session cookie: `halunasu_stg_session`
- CSRF cookie: `halunasu_stg_csrf`

Staging uses separate cookie names so production cookies cannot collide with staging requests, even while both use host-only app-origin cookies.

## Implementation Status

Implemented in code:

- Platform API must not set `APP_COOKIE_DOMAIN` while browser apps use Netlify same-origin API proxy routes.
- Platform API and product APIs can use `APP_SESSION_COOKIE_NAME` and `APP_CSRF_COOKIE_NAME`.
- Platform API now returns credentialed CORS headers for all `/v1/*` routes, not only signup.
- Product APIs allow the planned production and staging app origins.
- Existing Netlify preview and localhost origins remain allowed for development.

Final applied shape:

- Browser apps use host-only cookies on each Netlify app domain.
- Netlify `_redirects` proxies `/api/...` paths to raw Cloud Run `*.run.app` URLs.
- Direct API custom domains are not active and their Cloud Run domain mappings were removed during old-asset cleanup.

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

1. Keep using guarded local static deploys unless Git-based Netlify deploys are intentionally added.
2. Run browser E2E after future UI changes.
