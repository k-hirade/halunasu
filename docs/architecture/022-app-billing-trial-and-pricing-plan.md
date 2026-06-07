# 022 App Billing Trial And Pricing Plan

Last updated: 2026-05-31

## Decision

Halunasu billing will be app-based from the beginning, even though only `charting` is sellable now.

Final Stripe architecture:

- One Stripe Customer per hospital.
- One Stripe Subscription per hospital.
- Each paid app is represented by one or more Subscription Items on that shared Subscription.
- Product access is controlled by `organizations/{orgId}/product_entitlements/{productId}`.
- A hospital can pay for one app without enabling the other apps.
- Payment method, invoice history, tax settings, and billing portal are shared at the hospital Customer/Subscription level.

Current commercial decision:

- Signup app selection is single-select.
- Only `charting` can be selected at launch.
- `fee` and `referral` remain visible as future products only if the UI can clearly mark them unavailable; otherwise hide them.
- Trial is 14 days with no Stripe registration.
- Stripe Checkout is not started during signup or password setup.
- Reminder mail starts 3 days before trial end and is sent daily until the selected app is paid, canceled, or the organization is closed.
- Current price is flat 30,000 JPY/month per selected app.
- Current price does not change when `admin` or `doctor` count changes.
- Future seat billing will count app-level `admin` and `doctor` roles only, not every active member.
- Future extra seat price is 20,000 JPY/month per additional billable user, effective from the next invoice with no proration.

This means the first implementation must keep the future seat-billing mechanism in the data model and service boundaries, but keep `seatBilling.enabled=false` and avoid showing seat-change modals for now.

## ASIS

Current implementation is not aligned with the decision above.

- `apps/lp/signup.html` sends all products by default: `charting`, `fee`, `referral`.
- `apps/lp/signup.html` starts Stripe Checkout after password setup via `startCheckout: true`.
- Platform data already has `organizations/{orgId}/product_entitlements/{productId}`, but the fields are too small for app-specific trial, pricing, reminder, cancellation, and future seat billing.
- Platform billing Checkout currently uses a single Stripe Price lookup key, `medical_ai_monthly_jpy_v2`.
- Existing Stripe live/test Price for `medical_ai_monthly_jpy_v2` is 22,000 JPY/month, so it must not be reused for the new 30,000 JPY commercial decision.
- Trial expiration and daily reminder jobs are not active in the Core Platform runtime.
- Product APIs mainly check product entitlement. Organization-wide billing/access and app-specific billing states must become one shared gate.

## TOBE

Core Platform owns billing, trial, product entitlement, reminders, and Stripe linkage.

Product apps own product data only:

- `charting`: sessions, transcripts, SOAP, recording workflow
- `fee`: fee sessions and calculation results
- `referral`: referral drafts and documents

The Platform owns:

- organization
- member
- product roles
- product entitlement
- app billing state
- trial windows
- billing reminders
- checkout creation
- Stripe webhook processing
- cancellation schedule
- future seat billing preview and audit

## Product Catalog

Add a Platform-side billing catalog. It can be code-backed first, then moved to Firestore if needed.

```js
{
  productId: "charting",
  displayName: "カルテ作成",
  status: "sellable",
  signupSelectable: true,
  pricingModel: "flat_app_subscription_v1",
  stripeFlatPriceLookupKey: "halunasu_charting_flat_monthly_jpy_v1",
  monthlyAmountJpy: 30000,
  trialDays: 14,
  reminderStartDaysBeforeTrialEnd: 3,
  seatBilling: {
    enabled: false,
    billableProductRoles: ["admin", "doctor"],
    includedBillableSeats: 1,
    extraSeatAmountJpy: 20000,
    stripeExtraSeatPriceLookupKey: "halunasu_charting_extra_seat_monthly_jpy_v1",
    prorationBehavior: "none"
  }
}
```

Initial catalog entries for `fee` and `referral`:

```js
{
  productId: "fee",
  displayName: "診療報酬算定",
  status: "planned",
  signupSelectable: false
}
```

```js
{
  productId: "referral",
  displayName: "紹介状作成",
  status: "planned",
  signupSelectable: false
}
```

## Data Model

Keep organization billing as the aggregate contract state.

```js
organizations/{orgId}.billing = {
  provider: "stripe",
  billingModel: "app_addon",
  status: "trialing" | "active" | "payment_required" | "past_due" | "canceled",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  // Shared subscription for all app items.
  updatedAt: "..."
}
```

Use product entitlement as the app-specific billing and access source of truth.

```js
organizations/{orgId}/product_entitlements/{productId} = {
  productId: "charting",
  status: "trialing" | "payment_required" | "checkout_pending" | "enabled" | "past_due" | "cancel_scheduled" | "canceled" | "disabled",
  pricingModel: "flat_app_subscription_v1",
  monthlyAmountJpy: 30000,
  currency: "jpy",

  trialStartsAt: "...",
  trialEndsAt: "...",
  reminderStartsAt: "...",
  lastReminderSentAt: null,
  reminderCount: 0,

  stripePriceLookupKey: "halunasu_charting_flat_monthly_jpy_v1",
  stripePriceId: null,
  // Stripe Subscription Item for this app's flat monthly price.
  stripeSubscriptionItemId: null,

  seatBilling: {
    enabled: false,
    billableProductRoles: ["admin", "doctor"],
    includedBillableSeats: 1,
    extraSeatAmountJpy: 20000,
    billableSeatCount: 1,
    extraSeatQuantity: 0,
    stripeExtraSeatPriceLookupKey: "halunasu_charting_extra_seat_monthly_jpy_v1",
    stripeExtraSeatSubscriptionItemId: null,
    prorationBehavior: "none"
  },

  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  cancelScheduledAt: null,
  canceledAt: null,
  updatedAt: "..."
}
```

Add an append-only billing event collection for audit and future billing UX.

```js
organizations/{orgId}/billing_events/{eventId} = {
  productId: "charting",
  eventType: "trial_started" | "checkout_created" | "payment_activated" | "reminder_sent" | "trial_expired" | "seat_count_changed" | "cancel_scheduled" | "cancel_reverted" | "canceled",
  actorMemberId: null,
  oldValue: {},
  newValue: {},
  effectiveAt: "...",
  safePayload: {},
  createdAt: "..."
}
```

## Signup Flow

Target flow:

```text
LP signup
-> app selection: charting only
-> email verification
-> organization + admin member provisioning
-> admin password setup
-> charting entitlement trial starts
-> redirect to charting login
```

Required behavior changes:

- Remove `startCheckout: true` from password setup.
- Do not create Stripe Checkout during signup.
- Store only the selected product in `requestedProducts`.
- Start trial when the admin can actually use the product. Prefer password setup completion over email verification so trial days are not consumed while setup is incomplete.
- Create only selected product entitlements. Do not silently grant `fee` or `referral`.

## Trial And Reminder Policy

Trial is Platform-owned, not Stripe-owned.

For `charting`:

- `trialStartsAt`: password setup completion time
- `trialEndsAt`: `trialStartsAt + 14 days`
- `reminderStartsAt`: `trialEndsAt - 3 days`

Daily reminder rules:

- Send to `org_admin` and `billing_admin` contacts.
- Send once per product per calendar day.
- Continue after trial end while status is `payment_required`.
- Stop when product status becomes `enabled`, `cancel_scheduled`, `canceled`, or `disabled`.
- Store idempotency in `billing_events` or a dedicated `billing_reminder_receipts/{orgId_productId_yyyyMMdd}` collection.

The reminder link must point to Halunasu billing UI, not a static Stripe Payment Link:

```text
https://charting.halunasu.com/billing?product=charting
```

Checkout must be created only after an authenticated billing/admin user opens the billing flow.

## Stripe Design

Use a shared Customer and shared Subscription, with app-specific Subscription Items.

Initial `charting` payment:

```text
authenticated billing/admin user
-> POST /v1/billing/products/charting/checkout-session
-> Stripe Checkout creates the hospital Customer if missing
-> Stripe Checkout creates the first hospital Subscription
-> the first Subscription contains charting's flat monthly Subscription Item
-> webhook stores stripeSubscriptionId on organization.billing
-> webhook stores stripeSubscriptionItemId on product_entitlements/charting
```

Future app add-on payment after the hospital already has a Subscription:

```text
authenticated billing/admin user
-> app add confirmation in Halunasu billing UI
-> Platform adds a new Subscription Item to the existing hospital Subscription
-> no second Stripe Customer
-> no second Stripe Subscription
-> product_entitlements/{productId} stores that app's Subscription Item id
```

Create a new Price for the new decision.

Required current Price:

```text
lookup_key: halunasu_charting_flat_monthly_jpy_v1
amount: 30000
currency: jpy
interval: month
usage_type: licensed
```

Created Stripe objects:

```text
STG:
  product: prod_UcCJKmdjjbk4OA
  price: price_1TcxvCADFhjr3GQSrP1zj0it
  livemode: false

PROD:
  product: prod_UcCKbfDFVgxjOs
  price: price_1TcxvaADFhjr3GQSAZUkG5EU
  livemode: true
```

Do not reuse `medical_ai_monthly_jpy_v2` for the new launch price because it currently points to 22,000 JPY/month.
The LP legal display and legacy fallback plan constants must show the current launch price: 30,000 JPY tax-exclusive / 33,000 JPY tax-inclusive.

Initial Checkout Session line items:

```js
line_items: [
  {
    price: chartingFlatPriceId,
    quantity: 1
  }
]
```

Future seat billing line items, when enabled:

```js
line_items: [
  {
    price: chartingFlatPriceId,
    quantity: 1
  },
  {
    price: chartingExtraSeatPriceId,
    quantity: Math.max(billableSeatCount - 1, 0)
  }
]
```

Future app add-ons use separate flat app Prices:

```text
halunasu_fee_flat_monthly_jpy_v1
halunasu_referral_flat_monthly_jpy_v1
```

Those Prices are not created or used until the apps become sellable.

When future seat billing is enabled, member role changes update the extra seat Subscription Item:

```js
stripe.subscriptionItems.update(extraSeatSubscriptionItemId, {
  quantity: extraSeatQuantity,
  proration_behavior: "none"
});
```

Current implementation must not update invoice amount on member count changes because `seatBilling.enabled=false`.

## Member Count Policy

Current launch:

- `admin` and `doctor` counts are computed and stored for visibility/audit only.
- The amount remains 30,000 JPY/month regardless of count.
- No billing confirmation modal is shown on member creation or role changes.

Future seat billing:

- Billable roles are app-level `admin` and `doctor`.
- `org_admin` alone is not billable unless the member also has app-level `admin` or `doctor`.
- `billing_admin` alone is not billable.
- `nurse`, `medical_scribe`, reception, auditor, and disabled members are not billable.
- Adding a billable role shows a billing preview modal before saving.
- Removing a billable role shows a next-invoice reduction notice before saving.
- Amount changes are effective on the next invoice with no proration.

Future modal copy:

```text
カルテ作成の課金対象ユーザーが 2人から3人に増えます。
将来のseat課金が有効な場合、次回請求から月額が増えます。
現在の契約では人数が増えても月額30,000円のままです。
```

While `seatBilling.enabled=false`, show no modal. Keep the preview service and event model so the feature can be enabled later without redesigning billing state.

## Cancellation Flow

Cancellation is app-specific.

Current launch behavior:

```text
Billing UI
-> charting contract card
-> cancel button
-> confirmation
-> cancel_scheduled
-> access continues until currentPeriodEnd
-> scheduled job disables entitlement after currentPeriodEnd and removes the charting Subscription Item
```

Rules:

- During trial before payment: cancellation disables the product immediately and stops reminders.
- During paid period: cancellation schedules end-of-period termination.
- A billing/admin user can revert cancellation before `currentPeriodEnd`.
- Stripe Customer Portal may be used for payment method and invoice management, but app add/cancel should be controlled by Halunasu UI to keep app entitlement state consistent.
- If the last app item is canceled, the shared Subscription can be canceled at period end.
- If other app items remain active, only the canceled app's Subscription Item is removed at period end and the shared Subscription remains active.

Entitlement transitions:

```text
trialing -> disabled
enabled -> cancel_scheduled -> canceled/disabled
cancel_scheduled -> enabled
past_due -> payment_required or canceled, depending on Stripe state and grace policy
```

## Product Access Gate

Every product API must check both:

1. the shared Platform session and member/product role
2. the product entitlement billing/access state

Allowed product entitlement statuses:

- `trialing`
- `enabled`
- `cancel_scheduled` until `currentPeriodEnd`

Disallowed for product use:

- `payment_required`
- `checkout_pending`
- `past_due` after grace policy
- `canceled`
- `disabled`

Billing/admin pages remain accessible to `org_admin` and `billing_admin` so they can pay or manage cancellation.

## Implementation Plan

### P0: Catalog And Contracts

- Add Platform billing catalog for `charting`, `fee`, `referral`.
- Add contract fields for app billing state, reminder fields, cancellation fields, and dormant seat billing fields.
- Add tests for catalog normalization and entitlement schema.

### P1: Signup App Selection

- Change LP signup form to single-select product.
- Enable only `charting`.
- Store selected product as `requestedProducts: ["charting"]`.
- Remove `startCheckout: true` from password setup.
- Update LP tests to assert no immediate Stripe redirect.

### P2: Trial Start

- Start selected product trial on password setup completion.
- Write `trialStartsAt`, `trialEndsAt`, `reminderStartsAt`, `monthlyAmountJpy=30000`.
- Ensure unselected products have no entitlement or `not_selected` only if UI needs it.
- Update signup/provisioning tests.

### P3: Billing UI And Checkout

- Add app-specific billing status response.
- Add `POST /v1/billing/products/:productId/checkout-session`.
- Use `halunasu_charting_flat_monthly_jpy_v1` with quantity 1.
- Store `stripeSubscriptionItemId` from webhook.
- Keep old organization-level `/billing/checkout-session` only as a compatibility wrapper if needed.
- For the first paid app, Checkout creates the shared Subscription.
- For future app additions, add Subscription Items to the existing shared Subscription instead of creating another Subscription.

### P4: Reminder And Trial Expiration

- Add internal job handler for daily reminder scan.
- Add internal job handler for trial expiration.
- Send Resend reminder mail from `reminderStartsAt` onward.
- Set entitlement `payment_required` when trial expires without payment.
- Keep login/billing access available for admin users.

### P5: Future Seat Mechanism, Disabled

- Implement `computeBillableSeatCount(orgId, productId)` for app-level `admin` and `doctor`.
- Store `billableSeatCount` and `extraSeatQuantity`, but do not change price while `seatBilling.enabled=false`.
- Add billing preview API that returns current flat price and future seat count.
- Add audit event `seat_count_changed` when counts change.
- Do not show member-change billing modal until `seatBilling.enabled=true`.

### P6: Cancellation

- Add app-specific cancel and uncancel endpoints.
- Schedule cancellation at period end for paid products.
- Disable immediately for unpaid trial products.
- Add scheduled enforcement to disable `cancel_scheduled` entitlements after `currentPeriodEnd`.
- Add billing events and tests for cancel/uncancel.

### P7: Stripe And Deploy

- Create STG and PROD Stripe Prices:
  - `halunasu_charting_flat_monthly_jpy_v1` at 30,000 JPY/month
  - future inactive or unused: `halunasu_charting_extra_seat_monthly_jpy_v1` at 20,000 JPY/month
- Update Cloud Run env from `STRIPE_PRICE_LOOKUP_KEY=medical_ai_monthly_jpy_v2` to product catalog based lookup keys.
- Deploy Platform API, LP, and Charting.
- Verify STG flow:
  - signup charting
  - no Stripe redirect
  - trial active
  - reminder dry run
  - checkout creates 30,000 JPY subscription
  - webhook enables charting
  - member count change does not change amount
  - cancellation schedules end-of-period stop

## Non-Goals For Initial Launch

- Multiple app selection during signup
- Selling `fee`
- Selling `referral`
- Seat-based billing activation
- Billing modal on admin/doctor changes
- Prorated mid-cycle charges
- Usage-based billing by encounter count or LLM token usage
