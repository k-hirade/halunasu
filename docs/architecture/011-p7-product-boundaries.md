# P7 Product Boundaries

Status: local implementation complete
Date: 2026-05-28
Cost profile: local only, no new GCP resources

## Purpose

Charting, fee calculation, and referral creation now share Platform master data. P7 defines the boundary that lets products cooperate without merging product databases or creating hidden dependencies.

## Rules

- Product APIs use `requireProductContext` from `@halunasu/auth-client`.
- Product APIs may read Platform master data for the signed `orgId`.
- Product APIs may write their own product records only.
- Product APIs must not import sibling product services, stores, contracts, or cores.
- Product web apps must not call sibling product API routes directly.
- Cross-product workflows must be explicit user actions.
- Imported content must be copied as a snapshot or artifact reference.
- Both source and target products must write audit events.

## Shared Product Context

All product APIs now use the same context helper:

```js
await requireProductContext(input, {
  platformStore,
  productId: "charting",
  productLabel: "Charting",
  allowedProductRoles: ["admin", "doctor", "nurse", "scribe"]
});
```

The helper verifies:

- signed Platform session
- session expiry
- login identity status
- token version
- member status
- product entitlement status: `enabled` or `trialing`
- product role or global admin role

## Current Product Stores

```text
organizations/{orgId}/charting_encounters/{encounterId}
organizations/{orgId}/fee_sessions/{feeSessionId}
organizations/{orgId}/referrals/{referralId}
```

Shared Platform references:

- `orgId`
- `memberId`
- `facilityId`
- `departmentId`
- `patientId`

Product records keep snapshots for historical reproducibility.

## Explicit Import API Shape

Future cross-product import should use an explicit export/import handoff, not direct target-product reads from the source product DB.

Source product export:

```text
POST /v1/charting/exports
```

Request:

```json
{
  "sourceType": "charting_encounter",
  "sourceId": "enc_123",
  "selectedSections": ["patientSnapshot", "soapDraft", "diagnoses"],
  "purpose": "referral_import"
}
```

Response:

```json
{
  "export": {
    "sourceProduct": "charting",
    "sourceType": "charting_encounter",
    "sourceId": "enc_123",
    "sourceSnapshot": {},
    "exportedAt": "2026-05-28T00:00:00.000Z"
  }
}
```

Target product import:

```text
POST /v1/referral/imports
```

Request:

```json
{
  "sourceProduct": "charting",
  "sourceType": "charting_encounter",
  "sourceId": "enc_123",
  "sourceSnapshot": {},
  "targetReferralId": "ref_123",
  "idempotencyKey": "charting:enc_123:referral:ref_123"
}
```

The target product stores copied data under its own product record:

```text
organizations/{orgId}/referrals/{referralId}/imports/{importId}
```

or embeds a compact import snapshot on the referral when the imported content is small.

## Audit Events

Source product:

```text
charting.export_created
```

Target product:

```text
referral.import_created
```

Safe payload fields:

- `sourceProduct`
- `sourceType`
- `sourceId`
- `targetProduct`
- `targetType`
- `targetId`
- `selectedSections`
- `importId` or `exportId`

Do not put PHI excerpts in audit `safePayload`.

## Verification

P7 boundary tests live in `packages/product-boundaries`.

```bash
npm run test --workspace @halunasu/product-boundaries
npm run test
npm run build
```

These tests fail if:

- a product API stops using `requireProductContext`
- a product API performs entitlement checks inline again
- a product service references sibling product services or packages
- a product UI calls sibling product API routes directly

## Cost Guardrails

P7 is local-only. Do not create GCP resources, Cloud Tasks, Pub/Sub, GCS buckets, or deploy new Cloud Run services for product import workflows until an actual workflow needs a controlled staging smoke.
