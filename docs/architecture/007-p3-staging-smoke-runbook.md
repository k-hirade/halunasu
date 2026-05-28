# P3 Staging Smoke Runbook

Status: complete
Date: 2026-05-28
Owner: Halunasu platform

## Purpose

P3 verifies that LP signup has moved into the `halunasu` monorepo and that `platform-api` owns the full signup path:

1. signup application creation
2. email verification token consumption
3. organization/admin/product entitlement provisioning
4. admin password setup
5. admin login

The phase keeps cost low by reusing the P2 `medical-core-stg` resources and by avoiding email providers, Stripe, Terraform, Cloud SQL, queues, schedulers, or always-on instances.

## Implemented Scope

- Moved the existing static LP into `apps/lp`.
- Preserved legal, privacy, security, tokushoho, manual, static assets, and Netlify headers.
- Replaced LP CTA targets with `signup.html`.
- Added `apps/lp/signup.html` for Platform signup.
- Added `@halunasu/lp` static validation scripts.
- Added Platform signup routes:
  - `POST /v1/signup/applications`
  - `POST /v1/signup/verify-email`
  - `POST /v1/signup/setup-admin-password`
- Added token collections:
  - `signup_email_tokens/{tokenDigest}`
  - `password_setup_tokens/{tokenDigest}`
- Stores only SHA-256 token digests in Firestore; staging/local API responses still return raw tokens for smoke testing without email.
- Provisions organization, admin member, login identity, and requested product entitlements from verified signup.
- Keeps billing fields manual/trialing and does not integrate Stripe.
- Allows CORS preflight for signup routes from known LP/local origins, while Cloud Run itself remains IAM-private.

## Local Verification

Commands run:

```bash
npm test
npm run build
```

Result:

- `@halunasu/lp` static validation passed.
- `@halunasu/platform-api` passed 31 tests.
- `@halunasu/firestore-schema` passed 4 tests.
- `@halunasu/platform-contracts` passed 10 tests.
- Root build passed.

## Staging Deploy

Command run:

```bash
./scripts/deploy_platform_api_stg_zero_cost.sh --apply
```

Deploy result:

- Commit: `c06a3ad Complete P3 LP signup migration`
- Image tag: `asia-northeast1-docker.pkg.dev/medical-core-stg/halunasu-services/platform-api-stg:20260528-090022`
- Cloud Build ID: `aeb6d715-6cca-4739-b23b-c84f674711bd`
- Cloud Build duration: `59S`
- Uploaded source archive: `8.5 MiB`
- Cloud Run service: `platform-api-stg`
- Cloud Run revision: `platform-api-stg-00002-gqz`
- Service URL: `https://platform-api-stg-lp2t3inhza-an.a.run.app`

No Terraform was run. No new GCP service, repository, database, bucket, queue, scheduler, or secret was created by P3.

## Staging Smoke

One controlled signup flow was run with IAM-authenticated requests.

Smoke org:

```text
organizationCode: p3-smoke-20260528-0900
adminLoginId: p3-smoke-20260528-0900@example.com
requestedProducts: charting, fee, referral
```

Smoke result:

```json
{
  "ready": "ok",
  "application": "submitted",
  "verify": "provisioned",
  "org": "p3-smoke-20260528-0900",
  "entitlements": 3,
  "setupLogin": "p3-smoke-20260528-0900@example.com",
  "loginOrg": "p3-smoke-20260528-0900"
}
```

Unauthenticated `/readyz` returned `403`.

## Cost Guardrails Confirmed

- Cloud Run is still IAM-private; service IAM policy bindings are empty.
- Cloud Run template `autoscaling.knative.dev/maxScale` is `1`.
- Cloud Run template has no `minScale` annotation, so staging idles at the default `0`.
- Cloud Run CPU throttling is enabled.
- Cloud Run memory is `512Mi`.
- Cloud Run timeout is `60s`.
- Artifact Registry repository size after deploy: `158.737MB`.
- Artifact Registry size before P3 deploy was `115.514MB`.
- P3 deploy increased Artifact Registry storage by about `43.223MB`.

Known warnings:

- Cloud Build still reports that `866813206652-compute@developer.gserviceaccount.com` cannot write logs to Cloud Logging. This was intentionally not fixed to avoid adding permissions unless log retention is required.
- Docker build `npm install --omit=dev` reported 8 moderate npm audit findings. This did not block deployment, but should be reviewed before production hardening.

## Deferred

- Real email delivery for verification/setup tokens.
- Public LP-to-Platform deployment wiring. Current `platform-api-stg` remains IAM-private.
- Stripe/billing automation.
- Production deploy to `medical-core-497610`.
