# Performance Recovery Plan

## Current Finding

The production latency regression is not primarily caused by Cloudflare DNS. The current charting app pays latency in three places:

1. Browser requests go through the Netlify Next.js API proxy before reaching Cloud Run.
2. Protected charting gateway requests hydrate operator context from Platform Firestore on each request.
3. Admin/settings screens fan out into several protected API calls, so the proxy and auth hydration costs are repeated.

The charting web path does not normally call `charting-api` over HTTP for the admin/settings screens. The gateway directly owns the charting store and the platform store in-process, so the first fix should reduce repeated HTTP/API fanout and repeated auth hydration rather than assuming a `charting-gateway -> charting-api -> platform-api` chain.

## Implementation Order

### Phase 1: Admin Bootstrap Aggregation

Goal: replace the admin initial-load fanout with a single protected gateway request.

Current admin initial load:

```text
GET /api/v1/operator/me
GET /api/v1/admin/organizations
GET /api/v1/admin/role-definitions
GET /api/v1/admin/soap-formats
GET /api/v1/admin/members
GET /api/v1/admin/audit-events
```

Target initial load after the auth hook has hydrated access:

```text
GET /api/v1/admin/bootstrap?orgId=<selected>&section=<active-section>
```

The bootstrap response should include:

- `session`
- `organizations`
- `selectedOrgId`
- `roles`
- `formats`
- `members`
- `events`
- `canManagePlatform`

Permission behavior should match the existing individual endpoints:

- no settings permission: reject with the same access error
- no admin-console permission: return empty `roles` and `events`
- no member-management permission: return empty `members`
- no prompt-management permission: return empty `formats`
- non-platform users cannot request another organization

The `section` parameter keeps each settings page from waiting for unrelated data:

- `formats`: organizations, prompt summaries, and members for assignment only. It skips roles and audit events.
- `members`: organizations, roles, members, and prompt summaries.
- `audit`: organizations, members for actor labels, and audit events.
- `home`, `audio-test`, `account`: session and organization context only unless the screen explicitly fetches more.

Prompt summaries intentionally omit large `outputTemplate`, `customization`, and `sections` fields. The prompt editor fetches `GET /api/v1/admin/soap-formats/:formatId` only for the selected prompt.

### Phase 2: Proxy Bypass

Goal: remove the per-request Netlify Next Function cost for `/api/v1/*`.

Implemented approach:

- Business API calls use `GATEWAY_BASE_URL` / `NEXT_PUBLIC_GATEWAY_BASE_URL` and go directly to Cloud Run.
- Operator auth endpoints use `GATEWAY_AUTH_BASE_URL` / `NEXT_PUBLIC_GATEWAY_AUTH_BASE_URL`.
- In production charting deploys, `GATEWAY_AUTH_BASE_URL` is intentionally set to an empty string, so login, MFA, logout, CSRF, and `/operator/me` stay on the same-origin `/api/v1` Netlify proxy. This preserves the existing first-party session cookie behavior.
- The Next route proxy remains as an auth path and fallback path, but ordinary authenticated app calls carry the returned bearer token to Cloud Run directly.

This avoids depending on third-party `run.app` cookies in browsers while removing the Netlify function hop from the high-volume application calls.

### Phase 3: Operator Context Cache

Goal: reduce repeated Platform Firestore reads inside `hydratePlatformOperatorPayload`.

Use a short process-local cache keyed by stable session identity:

```text
organizationCode + loginId + tokenVersion + memberId
```

The gateway uses a short process-local cache. The default TTL is 3000 ms and can be tuned with `OPERATOR_CONTEXT_CACHE_TTL_MS`; the default max size is 1000 entries and can be tuned with `OPERATOR_CONTEXT_CACHE_MAX_ENTRIES`.

Invalidation-sensitive operations clear the affected member or organization cache after a successful platform mutation:

- recording preference change
- prompt assignment
- password reset
- role change
- member status change
- session revocation
- MFA reset
- organization recording/default prompt changes

Admin member listing also had an independent N+1 identity lookup for MFA state. Firestore `listMembers` now batch-fetches those login identity documents instead of calling `getLoginIdentity` once per member.

### Phase 4: Static Shell Cleanup

Goal: avoid no-store SSR where the page can read URL state on the client.

Candidates:

- `/mobile/join`
- `/mobile/audio-test`
- selected session shell routes if they can be safely made client-param driven

## Verification

For every phase, collect these timings before and after:

```bash
curl -sS -o /dev/null -w 'code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n' https://charting.halunasu.com/api/v1/operator/me
curl -sS -o /dev/null -w 'code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n' https://charting-gateway-prod-6dyw4sykta-an.a.run.app/api/v1/operator/me
curl -sS -o /dev/null -w 'code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n' https://charting.halunasu.com/admin
```

For Phase 1 specifically, browser/network inspection should show one admin bootstrap request instead of five separate admin read requests during initial settings load.
