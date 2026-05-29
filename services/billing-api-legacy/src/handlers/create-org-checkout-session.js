import { getBillingPlan } from "@medical/core";

import { jsonError } from "../lib/http.js";

function canStartCheckout(organization) {
  const billing = organization?.billing || null;

  if (!billing) {
    return false;
  }

  if (billing.stripeSubscriptionId) {
    return false;
  }

  return ["trialing", "pending_checkout", "past_due", "grace_period", "unpaid"].includes(billing.status);
}

export async function createOrganizationCheckoutSessionHandler({
  store,
  stripeClient,
  config,
  orgId
}) {
  const organization = await store.getOrganization?.(orgId);

  if (!organization) {
    throw jsonError("病院情報が見つかりません。", 404);
  }

  if (!canStartCheckout(organization)) {
    throw jsonError("この病院は新しい決済リンクを発行できない状態です。", 409);
  }

  const signup = await store.findSignupApplicationByOrgId?.(orgId);

  if (!signup) {
    throw jsonError("決済対象の申込情報が見つかりません。", 409);
  }

  const planCode = organization.billing?.planCode || signup.planCode;
  const plan = getBillingPlan(planCode);

  if (!plan) {
    throw jsonError("選択されたプランが見つかりません。", 400);
  }

  if (!config.publicAppBaseUrl) {
    throw jsonError("PUBLIC_APP_BASE_URL が未設定です。", 500);
  }

  const price = await stripeClient.lookupPriceByLookupKey(config.stripePriceLookupKey);

  if (!price?.id) {
    throw jsonError("Stripe の Price 設定が見つかりません。", 500);
  }

  const customer = organization.billing?.stripeCustomerId
    ? { id: organization.billing.stripeCustomerId }
    : await stripeClient.createCustomer({
        email: signup.adminEmail || null,
        name: organization.displayName,
        metadata: {
          signupId: signup.signupId,
          orgId,
          organizationCode: organization.organizationCode,
          planCode
        }
      });

  const successUrl = `${config.publicAppBaseUrl}/admin?section=account&billing=success`;
  const cancelUrl = `${config.publicAppBaseUrl}/admin?section=account&billing=cancel`;
  const session = await stripeClient.createCheckoutSession({
    customerId: customer.id,
    priceId: price.id,
    successUrl,
    cancelUrl,
    clientReferenceId: signup.signupId,
    metadata: {
      signupId: signup.signupId,
      orgId,
      organizationCode: organization.organizationCode,
      planCode,
      flow: "post_trial_checkout"
    },
    trialDays: null
  });

  await store.updateSignupApplication?.(signup.signupId, {
    stripeCustomerId: customer.id,
    stripeCheckoutSessionId: session.id
  });

  await store.updateOrganizationBilling?.({
    orgId,
    patch: {
      stripeCustomerId: customer.id
    },
    auditType: "billing.checkout.created"
  });

  return {
    checkout: {
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null
    }
  };
}
