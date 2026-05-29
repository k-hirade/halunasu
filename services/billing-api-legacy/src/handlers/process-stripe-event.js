import crypto from "node:crypto";

import { getOrganizationAccessStatus } from "@medical/core";

import { mapStripeSubscriptionStatus } from "../lib/billing-status.js";

function payloadHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

function addDaysIso(baseIso, days = 0) {
  const date = new Date(baseIso || Date.now());
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

function buildAccessPatchForBillingStatus(organization, billingStatus, { now } = {}) {
  const accessStatus = getOrganizationAccessStatus(organization);
  const restrictedAt = organization?.access?.restrictedAt || now;

  if (["trialing", "active", "pending_checkout"].includes(billingStatus)) {
    if (accessStatus === "pending_setup") {
      return null;
    }

    return {
      status: "active",
      reason: null,
      restrictedAt: null
    };
  }

  if (["past_due", "grace_period", "unpaid"].includes(billingStatus)) {
    return {
      status: "billing_action_required",
      reason: `billing.${billingStatus}`,
      restrictedAt
    };
  }

  if (billingStatus === "suspended") {
    return {
      status: "suspended",
      reason: "billing.suspended",
      restrictedAt
    };
  }

  if (billingStatus === "canceled") {
    return {
      status: "canceled",
      reason: "billing.canceled",
      restrictedAt
    };
  }

  return null;
}

async function updateOrganizationBillingAndAccess({
  store,
  orgId,
  billingPatch,
  accessPatch = null,
  billingAuditType = "billing.subscription.updated",
  accessAuditType = "billing.access.updated"
}) {
  let organization = await store.updateOrganizationBilling?.({
    orgId,
    patch: billingPatch,
    auditType: billingAuditType
  });

  if (accessPatch) {
    organization = await store.updateOrganizationAccess?.({
      orgId,
      patch: accessPatch,
      auditType: accessAuditType
    }) || organization;
  }

  return organization;
}

async function findSignupForStripeEvent({ store, signupId = null, orgId = null, subscriptionId = null, customerId = null } = {}) {
  if (signupId) {
    const signup = await store.getSignupApplication?.(signupId);
    if (signup) {
      return signup;
    }
  }

  if (orgId) {
    const signup = await store.findSignupApplicationByOrgId?.(orgId);
    if (signup) {
      return signup;
    }
  }

  if (subscriptionId) {
    const signup = await store.findSignupApplicationByStripeSubscriptionId?.(subscriptionId);
    if (signup) {
      return signup;
    }
  }

  if (customerId) {
    const signup = await store.findSignupApplicationByStripeCustomerId?.(customerId);
    if (signup) {
      return signup;
    }
  }

  return null;
}

async function handleCheckoutCompleted({ store, event }) {
  const object = event.data?.object || {};
  const signupId = object.client_reference_id || object.metadata?.signupId || object.subscription_details?.metadata?.signupId;
  const orgId = object.metadata?.orgId || object.subscription_details?.metadata?.orgId || null;

  const signup = await findSignupForStripeEvent({
    store,
    signupId,
    orgId,
    subscriptionId: object.subscription || null,
    customerId: object.customer || null
  });
  if (!signup) {
    return { handled: false, reason: "signup_not_found", signupId, orgId };
  }

  if (signup.status === "provisioned" && signup.orgId && signup.memberId) {
    await store.updateSignupApplication?.(signup.signupId, {
      stripeCustomerId: object.customer || signup.stripeCustomerId || null,
      stripeSubscriptionId: object.subscription || signup.stripeSubscriptionId || null,
      stripeCheckoutSessionId: object.id || signup.stripeCheckoutSessionId || null
    });

    if (signup.orgId) {
      await store.updateOrganizationBilling?.({
        orgId: signup.orgId,
        patch: {
          stripeCustomerId: object.customer || null,
          stripeSubscriptionId: object.subscription || null,
          lastStripeEventId: event.id
        },
        auditType: "billing.checkout.completed"
      });
    }

    return {
      handled: true,
      signup
    };
  }

  await store.updateSignupApplication(signupId, {
    stripeCustomerId: object.customer || signup.stripeCustomerId || null,
    stripeSubscriptionId: object.subscription || signup.stripeSubscriptionId || null,
    stripeCheckoutSessionId: object.id || signup.stripeCheckoutSessionId || null,
    status: "provisioning"
  });

  const provisioned = await store.provisionOrganizationWithAdminMember?.({
    organizationCode: signup.organizationCode,
    displayName: signup.displayName,
    adminLoginId: signup.adminLoginId,
    adminDisplayName: signup.adminDisplayName,
    adminEmail: signup.adminEmail,
    billing: {
      provider: "stripe",
      planCode: signup.planCode,
      status: "trialing",
      stripeCustomerId: object.customer || signup.stripeCustomerId || null,
      stripeSubscriptionId: object.subscription || signup.stripeSubscriptionId || null,
      stripePriceId: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      gracePeriodEndsAt: null,
      cancelAtPeriodEnd: false,
      seatQuantity: 1,
      lastStripeEventId: event.id
    },
    access: {
      status: "pending_setup",
      reason: "password_setup_required",
      restrictedAt: null
    }
  });

  const token = await store.createPasswordSetupToken?.({
    orgId: provisioned.organization.orgId,
    memberId: provisioned.member.memberId,
    organizationDisplayName: provisioned.organization.displayName,
    memberDisplayName: provisioned.member.displayName,
    email: signup.adminEmail
  });

  const updated = await store.updateSignupApplication(signupId, {
    stripeCustomerId: object.customer || signup.stripeCustomerId || null,
    stripeSubscriptionId: object.subscription || signup.stripeSubscriptionId || null,
    stripeCheckoutSessionId: object.id || signup.stripeCheckoutSessionId || null,
    orgId: provisioned.organization.orgId,
    memberId: provisioned.member.memberId,
    passwordSetupTokenId: token.tokenId,
    status: "provisioned"
  });

  return {
    handled: true,
    signup: updated,
    provisioned
  };
}

async function handleSubscriptionUpdated({ store, event, config }) {
  const object = event.data?.object || {};
  const signupId = object.metadata?.signupId || null;
  const orgId = object.metadata?.orgId || null;
  const billingStatus = mapStripeSubscriptionStatus(object.status, {
    cancellationDetails: object.cancellation_details || null
  });

  if (signupId) {
    await store.updateSignupApplication?.(signupId, {
      stripeCustomerId: object.customer || null,
      stripeSubscriptionId: object.id || null
    });
  }

  const signup = await findSignupForStripeEvent({
    store,
    signupId,
    orgId,
    subscriptionId: object.id || null,
    customerId: object.customer || null
  });
  if (!signup?.orgId) {
    return { handled: true, deferred: true, signupId, orgId };
  }

  const currentOrganization = await store.getOrganization?.(signup.orgId);
  const now = new Date().toISOString();
  const gracePeriodEndsAt = ["past_due", "grace_period", "unpaid"].includes(billingStatus)
    ? currentOrganization?.billing?.gracePeriodEndsAt || addDaysIso(now, config?.gracePeriodDays || 7)
    : null;

  const organization = await updateOrganizationBillingAndAccess({
    store,
    orgId: signup.orgId,
    billingPatch: {
      status: billingStatus,
      stripeCustomerId: object.customer || null,
      stripeSubscriptionId: object.id || null,
      stripePriceId: object.items?.data?.[0]?.price?.id || null,
      currentPeriodEnd: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null,
      trialEndsAt: object.trial_end ? new Date(object.trial_end * 1000).toISOString() : null,
      gracePeriodEndsAt,
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
      lastStripeEventId: event.id
    },
    accessPatch: buildAccessPatchForBillingStatus(currentOrganization, billingStatus, { now }),
    billingAuditType: "billing.subscription.updated",
    accessAuditType: "billing.access.updated"
  });

  return {
    handled: true,
    organization
  };
}

async function handleInvoicePaid({ store, event }) {
  const object = event.data?.object || {};
  const subscriptionId = object.subscription || null;
  const customerId = object.customer || null;

  const signup = await findSignupForStripeEvent({
    store,
    subscriptionId,
    customerId
  });

  if (!signup?.orgId) {
    return { handled: true, deferred: true };
  }

  const currentOrganization = await store.getOrganization?.(signup.orgId);
  const now = new Date().toISOString();
  const organization = await updateOrganizationBillingAndAccess({
    store,
    orgId: signup.orgId,
    billingPatch: {
      status: "active",
      currentPeriodEnd: object.lines?.data?.[0]?.period?.end ? new Date(object.lines.data[0].period.end * 1000).toISOString() : null,
      gracePeriodEndsAt: null,
      lastStripeEventId: event.id
    },
    accessPatch: buildAccessPatchForBillingStatus(currentOrganization, "active", { now }),
    billingAuditType: "billing.invoice.paid",
    accessAuditType: "billing.access.restored"
  });

  return {
    handled: true,
    organization
  };
}

async function handleInvoicePaymentFailed({ store, event, config }) {
  const object = event.data?.object || {};
  const subscriptionId = object.subscription || null;
  const customerId = object.customer || null;

  const signup = await findSignupForStripeEvent({
    store,
    subscriptionId,
    customerId
  });

  if (!signup?.orgId) {
    return { handled: true, deferred: true };
  }

  const currentOrganization = await store.getOrganization?.(signup.orgId);
  const now = new Date().toISOString();
  const gracePeriodEndsAt = addDaysIso(now, config?.gracePeriodDays || 7);
  const organization = await updateOrganizationBillingAndAccess({
    store,
    orgId: signup.orgId,
    billingPatch: {
      status: "past_due",
      gracePeriodEndsAt,
      lastStripeEventId: event.id
    },
    accessPatch: buildAccessPatchForBillingStatus(currentOrganization, "past_due", { now }),
    billingAuditType: "billing.invoice.payment_failed",
    accessAuditType: "billing.access.action_required"
  });

  return {
    handled: true,
    organization
  };
}

async function handleSubscriptionDeleted({ store, event }) {
  const object = event.data?.object || {};
  const signupId = object.metadata?.signupId || null;
  const orgId = object.metadata?.orgId || null;

  const signup = await findSignupForStripeEvent({
    store,
    signupId,
    orgId,
    subscriptionId: object.id || null,
    customerId: object.customer || null
  });
  if (!signup?.orgId) {
    return { handled: true, deferred: true };
  }

  const currentOrganization = await store.getOrganization?.(signup.orgId);
  const now = new Date().toISOString();
  const organization = await updateOrganizationBillingAndAccess({
    store,
    orgId: signup.orgId,
    billingPatch: {
      status: "canceled",
      gracePeriodEndsAt: null,
      cancelAtPeriodEnd: false,
      lastStripeEventId: event.id
    },
    accessPatch: buildAccessPatchForBillingStatus(currentOrganization, "canceled", { now }),
    billingAuditType: "billing.subscription.deleted",
    accessAuditType: "billing.access.canceled"
  });

  return {
    handled: true,
    organization
  };
}

const EVENT_HANDLERS = {
  "checkout.session.completed": handleCheckoutCompleted,
  "customer.subscription.created": handleSubscriptionUpdated,
  "customer.subscription.updated": handleSubscriptionUpdated,
  "customer.subscription.deleted": handleSubscriptionDeleted,
  "invoice.paid": handleInvoicePaid,
  "invoice.payment_failed": handleInvoicePaymentFailed
};

export async function processStripeEventHandler({ store, event, config = null }) {
  const existing = await store.getStripeEventReceipt?.(event.id);
  if (existing?.status === "processed" || existing?.status === "ignored") {
    return {
      receipt: existing,
      outcome: {
        handled: existing.status === "processed",
        replay: true
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
      payload: event,
      status: "received"
    });
  }

  const handler = EVENT_HANDLERS[event.type];
  if (!handler) {
    const updated = await store.updateStripeEventReceipt?.(event.id, {
      status: "ignored"
    });
    return {
      receipt: updated,
      outcome: {
        handled: false,
        ignored: true
      }
    };
  }

  try {
    const outcome = await handler({ store, event, config });
    const updated = await store.updateStripeEventReceipt?.(event.id, {
      status: "processed",
      processedAt: new Date().toISOString(),
      payload: event,
      errorMessageSafe: null
    });

    return {
      receipt: updated,
      outcome
    };
  } catch (error) {
    await store.updateStripeEventReceipt?.(event.id, {
      status: "failed",
      errorMessageSafe: error?.message || "failed"
    });
    throw error;
  }
}
