# 023 P0-P2 Complete Migration Execution Plan

Last updated: 2026-05-31

## Goal

Complete the remaining migration work without weakening the Core Platform split.

The target architecture remains:

- Core Platform owns hospitals, members, shared master data, product entitlements, trial state, Stripe linkage, billing events, and shared auth.
- Charting owns charting sessions, transcripts, SOAP drafts, prompt profiles, and recording workflow.
- Fee owns fee sessions and calculation details.
- Referral owns referral drafts and documents.

## Execution Order

### P0-1 Firestore Rules And Indexes

Problem:

- `firestore.rules` and `firestore.indexes.json` exist in the repository, but the live GCP projects do not have the composite indexes deployed.
- Charting non-admin session queries need the `encounters.accessMemberIds + createdAt` composite index.
- Firestore must be explicitly deny-by-default because browser clients must only use Cloud Run APIs.

Implementation:

- Add `firebase.json` that points to the repository Firestore rules and indexes.
- Add `scripts/p17_deploy_firestore_security_and_indexes.sh` to deploy the same rules/index declarations to current Core/Product projects.
- Deploy to current stg/prod projects only, not deleted legacy projects.

Acceptance:

- Firebase deploy succeeds for each target project.
- Composite indexes are visible in GCP and eventually become `READY`.
- App access still works via Cloud Run APIs.

### P0-2 Platform Trial Reminder And Expiry

Problem:

- Product entitlements already store `trialEndsAt`, `reminderStartsAt`, `lastReminderSentAt`, and `reminderCount`.
- There is no runtime process that sends reminder mail or moves expired trials to `payment_required`.

Implementation:

- Add a Platform billing maintenance worker that:
  - scans active organizations and product entitlements,
  - sends daily reminder mail after `reminderStartsAt`,
  - skips reminders after payment, cancellation, or disablement,
  - marks expired unpaid trials as `payment_required`,
  - writes audit events.
- Add an internal Platform API endpoint guarded by a maintenance secret.
- Keep this runnable without adding GCP resources. A scheduled trigger can be added later if needed.

Acceptance:

- Test coverage proves reminders are sent once per day and expired trials are disabled.
- In production, a manual run can process reminders without modifying app code.

### P0-3 Billing Subscription Item Path

Problem:

- Current Checkout creates a subscription for the selected app.
- The final billing model is one Stripe Customer and one Stripe Subscription per hospital, with apps represented as Subscription Items.

Implementation:

- Keep initial app payment via Stripe Checkout when no subscription exists.
- When an active subscription already exists, add the app as a Subscription Item instead of creating a second subscription.
- Keep seat billing disabled but keep the data model and line-item support.

Acceptance:

- Charting-only payment remains unchanged.
- Future app enablement can add fee/referral to the existing hospital subscription.

### P0-4 Access Status Consistency

Problem:

- Docs allow `cancel_scheduled` until `currentPeriodEnd`, but app auth only allows `enabled` and `trialing`.

Implementation:

- Treat `cancel_scheduled` as usable until `currentPeriodEnd`.
- Apply the same rule in shared auth-client and Charting Gateway Platform bridge.

Acceptance:

- Product APIs and Charting Gateway agree on entitlement access.

### P0-5 LP Legal Text

Problem:

- The LP signup flow and billing catalog use a 14-day trial, but `tokushoho.html` still says 7 days.

Implementation:

- Change legal text to 14 days.

Acceptance:

- LP, signup, catalog, and docs agree on 14 days.

### P0-6 Charting Admin Data Source

Problem:

- Charting login uses Core Platform, but admin member APIs still read Charting product Firestore.
- Core prod has `prod-test` members, but Charting product Firestore has none.

Implementation:

- When Platform bridge is enabled:
  - read organizations and members from Core Platform store,
  - create/update/disable/password-reset/MFA-reset/revoke sessions against Core Platform store,
  - map Core product/global roles to Charting admin roles for the existing UI.
- Keep prompt profiles product-owned.

Acceptance:

- `/api/v1/admin/members` returns Core members for `prod-test`.
- Mutating member operations update Core Platform member/login identity data.

### P0-7 Prompt Profile Initial State

Problem:

- `prompt_profiles` can be empty in the Charting product project.
- Session prompt selection falls back to `system-default`, but admin prompt list can look completely empty.

Implementation:

- Always include the virtual `system-default` profile in admin prompt lists.
- Allow reading `system-default` through the admin get endpoint.
- Keep custom prompt profiles product-owned.

Acceptance:

- Prompt settings never render as an empty broken state.
- Custom prompt CRUD remains product-owned.

## P1 Follow-Up

### App-Level Cancel And Uncancel

Implementation:

- Add app-level cancel scheduling and cancellation reversal in Platform API.
- Keep Stripe Customer Portal for payment-method/invoice self-service.
- App-specific cancellation status must be written to `product_entitlements/{productId}` and `billing_events`.

### Platform List Pagination

Implementation:

- Add pagination/search to members, facilities, departments, patients, and audit events before production scale.

### Fee Result Storage Split

Implementation:

- Keep fee session summary on the session document.
- Move full calculation result and raw result to a child document or collection before large-volume use.

## P2 Follow-Up

### Referral Productionization

Implementation:

- Replace placeholder PDF output with real PDF generation and storage.
- Add pagination for referral lists.
- Do not mark referral sellable until this is complete.

### Fee/Referral Stripe Products

Implementation:

- Create fee/referral Product + Price entries only when they are ready to sell.
- Until then keep `signupSelectable=false` and `status=planned`.

### Health Endpoint Verification

Implementation:

- Verify Cloud Run direct URLs and Netlify proxy URLs return expected `/healthz` and `/readyz` responses.

## Execution Result 2026-05-31

Implemented:

- P0-1: Firestore rules/index deployment script was added and applied to current Core/Product stg/prod projects.
- P0-2: Platform billing maintenance endpoint and CLI runner were added. STG/PROD dry-run calls succeeded.
- P0-3: Existing Stripe subscription app enablement now adds a Subscription Item instead of creating a second subscription.
- P0-4: `cancel_scheduled` remains usable until `currentPeriodEnd` in shared auth and Charting Gateway.
- P0-5: LP legal text now says 14-day trial.
- P0-6: Charting admin organization/member APIs use Core Platform store when the Platform bridge is enabled.
- P0-7: Charting prompt admin list always includes the virtual `system-default` profile.
- Netlify proxy targets were corrected to the current Cloud Run service URLs and redeployed.
- Charting Next.js, LP, Core Admin, Fee Web, and Referral Web were redeployed to STG/PROD.

Verification:

- `npm run test --workspace @halunasu/platform-api`: 48 passed.
- `npm run test --workspace @halunasu/auth-client`: 7 passed.
- `npm run test --workspace @halunasu/charting-web`: 12 passed in the deploy/build pass.
- Charting Gateway has no dedicated test script; production smoke was run with a short-lived signed bearer token.
- `https://charting.halunasu.com/api/v1/admin/members` returned Core `prod-test` members: `goshi`, `keishi`, `migration-check`, `test`, `test-osone`.
- `https://charting.halunasu.com/api/v1/admin/soap-formats` returned two formats including `system-default`.
- LP/Fee Netlify proxy to Platform API returns expected unauthenticated `401` JSON for `/api/platform/v1/auth/session`.
- Platform API `/readyz` returns `200` for STG/PROD direct Cloud Run URLs.
- Core/Charting/Fee PROD composite indexes checked were `READY`.

Still intentionally not complete in this pass:

- Daily automatic scheduling is not provisioned. The maintenance endpoint and CLI are ready, but Cloud Scheduler was not added to avoid additional GCP resources until approved.
- App-level cancel/uncancel APIs are still P1. Expiry finalization is implemented for existing `cancel_scheduled` state.
- Fee result storage split and list pagination are still P1.
- Referral production PDF/storage work is still P2.
- Fee/Referral Stripe Products should be created only when each app is sellable.
