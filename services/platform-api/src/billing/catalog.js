export const APP_BILLING_MODEL = "app_addon";
export const FLAT_APP_PRICING_MODEL = "flat_app_subscription_v1";
export const FUTURE_SEAT_PRICING_MODEL = "base_plus_billable_seats_v1";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PRODUCTS = Object.freeze({
  charting: Object.freeze({
    productId: "charting",
    displayName: "カルテ作成",
    status: "sellable",
    signupSelectable: true,
    pricingModel: FLAT_APP_PRICING_MODEL,
    stripeFlatPriceLookupKey: "halunasu_charting_flat_monthly_jpy_v1",
    monthlyAmountJpy: 30000,
    currency: "jpy",
    trialDays: 14,
    reminderStartDaysBeforeTrialEnd: 3,
    seatBilling: Object.freeze({
      enabled: false,
      billableProductRoles: Object.freeze(["admin", "doctor"]),
      includedBillableSeats: 1,
      extraSeatAmountJpy: 20000,
      stripeExtraSeatPriceLookupKey: "halunasu_charting_extra_seat_monthly_jpy_v1",
      prorationBehavior: "none"
    })
  }),
  fee: Object.freeze({
    productId: "fee",
    displayName: "診療報酬算定",
    status: "planned",
    signupSelectable: false
  }),
  referral: Object.freeze({
    productId: "referral",
    displayName: "紹介状作成",
    status: "planned",
    signupSelectable: false
  })
});

export function getBillingCatalog(env = process.env) {
  return {
    ...DEFAULT_PRODUCTS,
    charting: {
      ...DEFAULT_PRODUCTS.charting,
      stripeFlatPriceLookupKey: env.STRIPE_CHARTING_FLAT_PRICE_LOOKUP_KEY
        || env.HALUNASU_CHARTING_FLAT_PRICE_LOOKUP_KEY
        || DEFAULT_PRODUCTS.charting.stripeFlatPriceLookupKey,
      seatBilling: {
        ...DEFAULT_PRODUCTS.charting.seatBilling,
        stripeExtraSeatPriceLookupKey: env.STRIPE_CHARTING_EXTRA_SEAT_PRICE_LOOKUP_KEY
          || env.HALUNASU_CHARTING_EXTRA_SEAT_PRICE_LOOKUP_KEY
          || DEFAULT_PRODUCTS.charting.seatBilling.stripeExtraSeatPriceLookupKey
      }
    }
  };
}

export function getBillingProduct(productId = "charting", env = process.env) {
  return getBillingCatalog(env)[productId] || null;
}

export function normalizeSignupProductSelection(productIds = [], env = process.env) {
  const catalog = getBillingCatalog(env);
  const requested = Array.isArray(productIds) ? productIds : [];
  const selected = requested.find((productId) => catalog[productId]?.signupSelectable);
  return [selected || "charting"];
}

export function buildOrganizationBillingState(nowIso) {
  return {
    provider: "stripe",
    billingModel: APP_BILLING_MODEL,
    status: "trialing",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    updatedAt: nowIso
  };
}

export function buildPendingSetupEntitlement(productId, now = new Date(), env = process.env) {
  const product = requireBillingProduct(productId, env);
  return {
    productId,
    status: "disabled",
    plan: "trial_pending_setup",
    pricingModel: product.pricingModel,
    monthlyAmountJpy: product.monthlyAmountJpy,
    currency: product.currency,
    stripePriceLookupKey: product.stripeFlatPriceLookupKey,
    seatBilling: buildSeatBillingState(product, 1),
    startsAt: now.toISOString()
  };
}

export function buildTrialEntitlement(productId, now = new Date(), env = process.env) {
  const product = requireBillingProduct(productId, env);
  const trialStartsAt = now.toISOString();
  const trialEndsAt = addDays(now, product.trialDays).toISOString();
  const reminderStartsAt = addDays(now, product.trialDays - product.reminderStartDaysBeforeTrialEnd).toISOString();
  return {
    productId,
    status: "trialing",
    plan: "trial",
    pricingModel: product.pricingModel,
    monthlyAmountJpy: product.monthlyAmountJpy,
    currency: product.currency,
    trialStartsAt,
    trialEndsAt,
    reminderStartsAt,
    lastReminderSentAt: null,
    reminderCount: 0,
    stripePriceLookupKey: product.stripeFlatPriceLookupKey,
    seatBilling: buildSeatBillingState(product, 1),
    startsAt: trialStartsAt,
    endsAt: trialEndsAt
  };
}

export function buildCheckoutLineItemsForEntitlement(product, entitlement = {}) {
  const seatBilling = {
    ...product.seatBilling,
    ...(entitlement.seatBilling || {})
  };
  const lineItems = [{
    priceLookupKey: entitlement.stripePriceLookupKey || product.stripeFlatPriceLookupKey,
    quantity: 1,
    kind: "flat",
    productId: product.productId
  }];

  if (seatBilling.enabled && Number(seatBilling.extraSeatQuantity || 0) > 0) {
    lineItems.push({
      priceLookupKey: seatBilling.stripeExtraSeatPriceLookupKey,
      quantity: Math.max(Number(seatBilling.extraSeatQuantity || 0), 0),
      kind: "extra_seat",
      productId: product.productId
    });
  }

  return lineItems;
}

export function computeBillableSeatCount(members = [], productId, env = process.env) {
  const product = getBillingProduct(productId, env);
  const billableRoles = new Set(product?.seatBilling?.billableProductRoles || []);
  if (!billableRoles.size) {
    return 0;
  }

  return members.filter((member) => {
    if (member.status && member.status !== "active") {
      return false;
    }
    const roles = member.productRoles?.[productId] || [];
    return roles.some((role) => billableRoles.has(role));
  }).length;
}

export function buildSeatBillingState(product, billableSeatCount) {
  const includedSeats = product.seatBilling?.includedBillableSeats || 1;
  const count = Math.max(Number(billableSeatCount || 0), includedSeats);
  return {
    enabled: Boolean(product.seatBilling?.enabled),
    billableProductRoles: [...(product.seatBilling?.billableProductRoles || [])],
    includedBillableSeats: includedSeats,
    extraSeatAmountJpy: product.seatBilling?.extraSeatAmountJpy || 0,
    billableSeatCount: count,
    extraSeatQuantity: Math.max(count - includedSeats, 0),
    stripeExtraSeatPriceLookupKey: product.seatBilling?.stripeExtraSeatPriceLookupKey || null,
    stripeExtraSeatSubscriptionItemId: null,
    prorationBehavior: product.seatBilling?.prorationBehavior || "none"
  };
}

function requireBillingProduct(productId, env) {
  const product = getBillingProduct(productId, env);
  if (!product || product.status !== "sellable") {
    const error = new Error("Product is not sellable");
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = "productId";
    throw error;
  }
  return product;
}

function addDays(now, days) {
  return new Date(now.getTime() + Number(days || 0) * DAY_MS);
}
