import crypto from "node:crypto";
import { getBillingCatalog } from "./catalog.js";

const BILLING_ACTIVE_STATUSES = new Set(["active", "trialing", "pending_checkout"]);
const BILLING_RESTRICTED_STATUSES = new Set(["past_due", "grace_period", "unpaid"]);

export function verifyStripeWebhookSignature({
  payload,
  signatureHeader,
  endpointSecret,
  toleranceSeconds = 300,
  now = Date.now()
}) {
  if (!endpointSecret) {
    const error = new Error("STRIPE_WEBHOOK_SECRET is not configured");
    error.name = "StripeConfigurationError";
    error.statusCode = 503;
    throw error;
  }

  const parsed = parseStripeSignatureHeader(signatureHeader);
  const timestamp = Number(parsed.t?.[0] || 0);
  const signatures = parsed.v1 || [];
  if (!timestamp || signatures.length === 0) {
    const error = new Error("Stripe-Signature header is invalid");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }

  const ageSeconds = Math.abs(now - timestamp * 1000) / 1000;
  if (ageSeconds > toleranceSeconds) {
    const error = new Error("Stripe webhook signature is too old");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }

  const rawPayload = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ""), "utf8");
  const expected = crypto
    .createHmac("sha256", endpointSecret)
    .update(`${timestamp}.${rawPayload.toString("utf8")}`)
    .digest("hex");
  const valid = signatures.some((signature) => timingSafeEqualHex(signature, expected));
  if (!valid) {
    const error = new Error("Stripe webhook signature verification failed");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }

  return { timestamp };
}

export async function processStripeWebhookEvent({ store, event, now = new Date() }) {
  const existing = await store.getStripeEventReceipt?.(event.id);
  if (existing?.status === "processed" || existing?.status === "ignored") {
    return {
      receipt: existing,
      outcome: {
        replay: true,
        handled: existing.status === "processed"
      }
    };
  }

  if (!existing) {
    await store.createStripeEventReceipt?.({
      eventId: event.id,
      type: event.type,
      livemode: Boolean(event.livemode),
      apiVersion: event.api_version || null,
      objectId: event.data?.object?.id || null,
      payloadHash: payloadHash(event),
      status: "received",
      receivedAt: now.toISOString()
    });
  }

  const handler = eventHandlers[event.type];
  if (!handler) {
    const receipt = await store.updateStripeEventReceipt?.(event.id, {
      status: "ignored",
      processedAt: now.toISOString()
    });
    return {
      receipt,
      outcome: {
        handled: false,
        ignored: true
      }
    };
  }

  try {
    const outcome = await handler({ store, event, now });
    const receipt = await store.updateStripeEventReceipt?.(event.id, {
      status: "processed",
      processedAt: now.toISOString(),
      errorMessageSafe: null
    });
    return { receipt, outcome };
  } catch (error) {
    await store.updateStripeEventReceipt?.(event.id, {
      status: "failed",
      processedAt: now.toISOString(),
      errorMessageSafe: error.message || "failed"
    });
    throw error;
  }
}

async function handleCheckoutCompleted({ store, event, now }) {
  const object = event.data?.object || {};
  const organization = await resolveOrganizationForStripeObject(store, object);
  if (!organization) {
    return unresolvedOutcome(event, object);
  }

  return updateOrganizationFromStripe(store, organization, {
    event,
    now,
    billingStatus: "active",
    billingPatch: {
      stripeCustomerId: stringOrNull(object.customer) || organization.billing?.stripeCustomerId || null,
      stripeSubscriptionId: stringOrNull(object.subscription) || organization.billing?.stripeSubscriptionId || null,
      stripeCheckoutSessionId: stringOrNull(object.id) || organization.billing?.stripeCheckoutSessionId || null,
      stripePriceId: firstPriceId(object) || organization.billing?.stripePriceId || null
    },
    auditEventType: "billing.checkout.completed"
  });
}

async function handleSubscriptionUpdated({ store, event, now }) {
  const object = event.data?.object || {};
  const organization = await resolveOrganizationForStripeObject(store, object);
  if (!organization) {
    return unresolvedOutcome(event, object);
  }

  return updateOrganizationFromStripe(store, organization, {
    event,
    now,
    billingStatus: mapStripeSubscriptionStatus(object.status, object),
    billingPatch: {
      stripeCustomerId: stringOrNull(object.customer) || organization.billing?.stripeCustomerId || null,
      stripeSubscriptionId: stringOrNull(object.id) || organization.billing?.stripeSubscriptionId || null,
      stripePriceId: firstPriceId(object) || organization.billing?.stripePriceId || null,
      currentPeriodEnd: unixToIso(object.current_period_end),
      trialEndsAt: unixToIso(object.trial_end),
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end)
    },
    auditEventType: "billing.subscription.updated"
  });
}

async function handleSubscriptionDeleted({ store, event, now }) {
  const object = event.data?.object || {};
  const organization = await resolveOrganizationForStripeObject(store, object);
  if (!organization) {
    return unresolvedOutcome(event, object);
  }

  return updateOrganizationFromStripe(store, organization, {
    event,
    now,
    billingStatus: "canceled",
    billingPatch: {
      stripeCustomerId: stringOrNull(object.customer) || organization.billing?.stripeCustomerId || null,
      stripeSubscriptionId: stringOrNull(object.id) || organization.billing?.stripeSubscriptionId || null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null
    },
    auditEventType: "billing.subscription.deleted"
  });
}

async function handleInvoicePaid({ store, event, now }) {
  const object = event.data?.object || {};
  const organization = await resolveOrganizationForStripeObject(store, object);
  if (!organization) {
    return unresolvedOutcome(event, object);
  }

  return updateOrganizationFromStripe(store, organization, {
    event,
    now,
    billingStatus: "active",
    billingPatch: {
      stripeCustomerId: stringOrNull(object.customer) || organization.billing?.stripeCustomerId || null,
      stripeSubscriptionId: stripeObjectSubscriptionId(object) || organization.billing?.stripeSubscriptionId || null,
      currentPeriodEnd: invoicePeriodEnd(object),
      gracePeriodEndsAt: null
    },
    auditEventType: "billing.invoice.paid"
  });
}

async function handleInvoicePaymentFailed({ store, event, now }) {
  const object = event.data?.object || {};
  const organization = await resolveOrganizationForStripeObject(store, object);
  if (!organization) {
    return unresolvedOutcome(event, object);
  }

  return updateOrganizationFromStripe(store, organization, {
    event,
    now,
    billingStatus: "past_due",
    billingPatch: {
      stripeCustomerId: stringOrNull(object.customer) || organization.billing?.stripeCustomerId || null,
      stripeSubscriptionId: stripeObjectSubscriptionId(object) || organization.billing?.stripeSubscriptionId || null,
      gracePeriodEndsAt: organization.billing?.gracePeriodEndsAt || daysFrom(now, 7)
    },
    auditEventType: "billing.invoice.payment_failed"
  });
}

const eventHandlers = {
  "checkout.session.completed": handleCheckoutCompleted,
  "customer.subscription.created": handleSubscriptionUpdated,
  "customer.subscription.updated": handleSubscriptionUpdated,
  "customer.subscription.deleted": handleSubscriptionDeleted,
  "invoice.paid": handleInvoicePaid,
  "invoice.payment_succeeded": handleInvoicePaid,
  "invoice.payment_failed": handleInvoicePaymentFailed
};

async function updateOrganizationFromStripe(store, organization, {
  event,
  now,
  billingStatus,
  billingPatch,
  auditEventType
}) {
  const updatedBilling = compactObject({
    ...(organization.billing || {}),
    provider: "stripe",
    status: billingStatus,
    ...billingPatch,
    lastStripeEventId: event.id,
    updatedAt: now.toISOString()
  });
  const updatedAccess = accessForBillingStatus(organization, billingStatus, now);
  const updatedOrganization = await store.updateOrganization(organization.orgId, compactObject({
    status: organizationStatusForBillingStatus(billingStatus, organization.status),
    billing: updatedBilling,
    access: updatedAccess
  }));
  const syncedProductIds = await syncProductEntitlementsForBilling(store, updatedOrganization, billingStatus, now, {
    stripeObject: event.data?.object || {}
  });
  await store.createAuditEvent(updatedOrganization.orgId, {
    eventType: auditEventType,
    targetType: "organization",
    targetId: updatedOrganization.orgId,
    safePayload: {
      stripeEventId: event.id,
      stripeEventType: event.type,
      billingStatus,
      stripeCustomerId: updatedBilling.stripeCustomerId || null,
      stripeSubscriptionId: updatedBilling.stripeSubscriptionId || null,
      stripePriceId: updatedBilling.stripePriceId || null,
      productIds: syncedProductIds
    }
  });

  return {
    handled: true,
    orgId: updatedOrganization.orgId,
    billingStatus,
    productIds: syncedProductIds
  };
}

async function syncProductEntitlementsForBilling(store, organization, billingStatus, now, options = {}) {
  const existing = await safeListProductEntitlements(store, organization.orgId);
  const stripeItems = extractStripeItems(options.stripeObject);
  const productIds = resolveProductIdsForStripeSync({
    stripeObject: options.stripeObject,
    organization,
    existing,
    stripeItems
  });
  const entitlementStatus = productEntitlementStatusForBillingStatus(billingStatus);
  if (!entitlementStatus || productIds.size === 0) {
    return [];
  }

  for (const productId of productIds) {
    const current = existing.find((entitlement) => entitlement.productId === productId) || null;
    const product = getBillingCatalog()[productId] || {};
    const productItems = stripeItems.filter((item) => productIdForStripeItem(item, existing) === productId);
    const flatItem = productItems.find((item) => (
      item.priceId && item.priceId === current?.stripePriceId
    ) || (
      item.priceLookupKey && item.priceLookupKey === (current?.stripePriceLookupKey || product.stripeFlatPriceLookupKey)
    )) || productItems[0] || null;
    const extraSeatItem = productItems.find((item) => item !== flatItem) || null;
    const seatBilling = current?.seatBilling && extraSeatItem
      ? compactObject({
        ...current.seatBilling,
        stripeExtraSeatSubscriptionItemId: extraSeatItem.subscriptionItemId || current.seatBilling.stripeExtraSeatSubscriptionItemId || null,
        extraSeatQuantity: extraSeatItem.quantity ?? current.seatBilling.extraSeatQuantity
      })
      : undefined;
    const patch = compactObject({
      productId,
      status: entitlementStatus,
      plan: organization.billing?.stripeSubscriptionId ? "stripe" : current?.plan || "subscription",
      startsAt: current?.startsAt || now.toISOString(),
      currentPeriodEnd: organization.billing?.currentPeriodEnd || flatItem?.periodEnd || current?.currentPeriodEnd || null,
      cancelAtPeriodEnd: organization.billing?.cancelAtPeriodEnd,
      stripePriceId: flatItem?.priceId || current?.stripePriceId || organization.billing?.stripePriceId || null,
      stripeSubscriptionItemId: flatItem?.subscriptionItemId || current?.stripeSubscriptionItemId || null,
      seatBilling
    });

    if (current) {
      await store.updateProductEntitlement(organization.orgId, productId, patch);
    } else {
      await store.upsertProductEntitlement(organization.orgId, compactObject({
        ...patch,
        features: {}
      }));
    }
  }

  return [...productIds];
}

async function resolveOrganizationForStripeObject(store, object = {}) {
  const orgId = stripeObjectOrgId(object);
  if (orgId) {
    const organization = await store.getOrganization(orgId);
    if (organization) {
      return organization;
    }
  }

  const subscriptionId = stripeObjectSubscriptionId(object);
  if (subscriptionId && store.findOrganizationByStripeSubscriptionId) {
    const organization = await store.findOrganizationByStripeSubscriptionId(subscriptionId);
    if (organization) {
      return organization;
    }
  }

  const customerId = stringOrNull(object.customer);
  if (customerId && store.findOrganizationByStripeCustomerId) {
    return store.findOrganizationByStripeCustomerId(customerId);
  }

  return null;
}

function accessForBillingStatus(organization, billingStatus, now) {
  if (BILLING_ACTIVE_STATUSES.has(billingStatus)) {
    return {
      ...(organization.access || {}),
      status: "active",
      reason: null,
      restrictedAt: null
    };
  }

  if (BILLING_RESTRICTED_STATUSES.has(billingStatus)) {
    return {
      ...(organization.access || {}),
      status: "billing_action_required",
      reason: `billing.${billingStatus}`,
      restrictedAt: organization.access?.restrictedAt || now.toISOString()
    };
  }

  if (billingStatus === "canceled") {
    return {
      ...(organization.access || {}),
      status: "canceled",
      reason: "billing.canceled",
      restrictedAt: organization.access?.restrictedAt || now.toISOString()
    };
  }

  if (billingStatus === "suspended") {
    return {
      ...(organization.access || {}),
      status: "suspended",
      reason: "billing.suspended",
      restrictedAt: organization.access?.restrictedAt || now.toISOString()
    };
  }

  return organization.access || {};
}

function organizationStatusForBillingStatus(billingStatus, currentStatus) {
  if (billingStatus === "active") {
    return "active";
  }
  if (billingStatus === "trialing") {
    return "trialing";
  }
  if (billingStatus === "canceled" || billingStatus === "suspended") {
    return "suspended";
  }
  return currentStatus;
}

function productEntitlementStatusForBillingStatus(billingStatus) {
  if (billingStatus === "active") {
    return "enabled";
  }
  if (billingStatus === "trialing") {
    return "trialing";
  }
  if (billingStatus === "pending_checkout") {
    return "checkout_pending";
  }
  if (billingStatus === "past_due") {
    return "past_due";
  }
  if (billingStatus === "unpaid") {
    return "payment_required";
  }
  if (billingStatus === "canceled" || billingStatus === "suspended") {
    return "disabled";
  }
  return null;
}

function mapStripeSubscriptionStatus(status, subscription = {}) {
  if (subscription.cancellation_details?.reason === "cancellation_requested") {
    return "canceled";
  }

  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "canceled":
      return status;
    case "paused":
      return "suspended";
    case "incomplete":
    case "incomplete_expired":
      return "pending_checkout";
    default:
      return "pending_checkout";
  }
}

function stripeObjectOrgId(object = {}) {
  const candidates = [
    object.metadata?.orgId,
    object.subscription_details?.metadata?.orgId,
    object.parent?.subscription_details?.metadata?.orgId,
    object.client_reference_id
  ];
  return candidates.find((value) => typeof value === "string" && value.startsWith("org_")) || null;
}

function resolveProductIdsForStripeSync({ stripeObject = {}, organization = {}, existing = [], stripeItems = [] }) {
  const resolved = new Set(metadataProductIds(stripeObject));
  for (const item of stripeItems) {
    const productId = productIdForStripeItem(item, existing);
    if (productId) {
      resolved.add(productId);
    }
  }

  if (resolved.size === 0 && stripeObjectSubscriptionId(stripeObject) === organization.billing?.stripeSubscriptionId) {
    for (const entitlement of existing) {
      if (
        entitlement.stripeSubscriptionItemId
        || entitlement.stripePriceId
        || entitlement.status === "checkout_pending"
      ) {
        resolved.add(entitlement.productId);
      }
    }
  }

  const catalog = getBillingCatalog();
  return new Set([...resolved].filter((productId) => catalog[productId]));
}

function productIdForStripeItem(item, existing = []) {
  if (!item) {
    return null;
  }

  const existingMatch = existing.find((entitlement) => (
    item.subscriptionItemId && item.subscriptionItemId === entitlement.stripeSubscriptionItemId
  ) || (
    item.priceId && item.priceId === entitlement.stripePriceId
  ) || (
    item.priceLookupKey && item.priceLookupKey === entitlement.stripePriceLookupKey
  ) || (
    item.subscriptionItemId && item.subscriptionItemId === entitlement.seatBilling?.stripeExtraSeatSubscriptionItemId
  ) || (
    item.priceLookupKey && item.priceLookupKey === entitlement.seatBilling?.stripeExtraSeatPriceLookupKey
  ));
  if (existingMatch) {
    return existingMatch.productId;
  }

  const catalog = getBillingCatalog();
  return Object.values(catalog).find((product) => (
    item.priceLookupKey && item.priceLookupKey === product.stripeFlatPriceLookupKey
  ) || (
    item.priceLookupKey && item.priceLookupKey === product.seatBilling?.stripeExtraSeatPriceLookupKey
  ))?.productId || null;
}

function metadataProductIds(object = {}) {
  const values = [
    object.metadata?.productIds,
    object.metadata?.productId,
    object.subscription_details?.metadata?.productIds,
    object.subscription_details?.metadata?.productId,
    object.parent?.subscription_details?.metadata?.productIds,
    object.parent?.subscription_details?.metadata?.productId
  ];
  return values.flatMap(parseProductIds);
}

function parseProductIds(value) {
  if (Array.isArray(value)) {
    return value.flatMap(parseProductIds);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractStripeItems(object = {}) {
  const subscriptionItems = arrayOrEmpty(object.items?.data).map((item) => ({
    subscriptionItemId: stringOrNull(item.id),
    priceId: stringOrNull(item.price?.id),
    priceLookupKey: stringOrNull(item.price?.lookup_key),
    quantity: item.quantity,
    periodEnd: unixToIso(item.current_period_end || item.period?.end)
  }));
  const invoiceItems = arrayOrEmpty(object.lines?.data).map((line) => ({
    subscriptionItemId: stringOrNull(line.subscription_item)
      || stringOrNull(line.parent?.subscription_item_details?.subscription_item),
    priceId: stringOrNull(line.price?.id) || stringOrNull(line.pricing?.price_details?.price),
    priceLookupKey: stringOrNull(line.price?.lookup_key),
    quantity: line.quantity,
    periodEnd: unixToIso(line.period?.end)
  }));
  const checkoutLineItems = arrayOrEmpty(object.line_items?.data).map((line) => ({
    subscriptionItemId: stringOrNull(line.subscription_item),
    priceId: stringOrNull(line.price?.id),
    priceLookupKey: stringOrNull(line.price?.lookup_key),
    quantity: line.quantity,
    periodEnd: unixToIso(line.period?.end)
  }));

  return [...subscriptionItems, ...invoiceItems, ...checkoutLineItems].filter((item) => (
    item.subscriptionItemId || item.priceId || item.priceLookupKey
  ));
}

function stripeObjectSubscriptionId(object = {}) {
  return stringOrNull(object.subscription)
    || stringOrNull(object.parent?.subscription_details?.subscription)
    || stringOrNull(object.subscription_details?.subscription)
    || stringOrNull(object.id?.startsWith?.("sub_") ? object.id : null);
}

function firstPriceId(object = {}) {
  return stringOrNull(object.items?.data?.[0]?.price?.id)
    || stringOrNull(object.lines?.data?.[0]?.price?.id)
    || stringOrNull(object.display_items?.[0]?.price?.id);
}

function invoicePeriodEnd(object = {}) {
  const timestamp = object.lines?.data?.[0]?.period?.end || object.period_end;
  return unixToIso(timestamp);
}

function unresolvedOutcome(event, object) {
  return {
    handled: false,
    deferred: true,
    reason: "organization_not_found",
    stripeEventId: event.id,
    stripeObjectId: object.id || null
  };
}

function parseStripeSignatureHeader(signatureHeader) {
  return String(signatureHeader || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const separator = item.indexOf("=");
      if (separator === -1) {
        return acc;
      }
      const key = item.slice(0, separator);
      const value = item.slice(separator + 1);
      acc[key] = acc[key] || [];
      acc[key].push(value);
      return acc;
    }, {});
}

function timingSafeEqualHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function payloadHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

function unixToIso(timestamp) {
  return timestamp ? new Date(Number(timestamp) * 1000).toISOString() : null;
}

function daysFrom(now, days) {
  return new Date(now.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000).toISOString();
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

async function safeListProductEntitlements(store, orgId) {
  try {
    return await store.listProductEntitlements(orgId);
  } catch {
    return [];
  }
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function compactObject(input = {}) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
