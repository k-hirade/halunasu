import { jsonError } from "./lib/http.js";

function toStripeForm(payload = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }

    params.append(key, String(value));
  }

  return params;
}

async function parseStripeResponse(response) {
  const payload = await response.json().catch(() => null);

  if (response.ok) {
    return payload;
  }

  const error = new Error(payload?.error?.message || "Stripe request failed.");
  error.statusCode = response.status >= 500 ? 502 : 400;
  error.safeMessage = "決済サービスとの通信に失敗しました。時間を置いてもう一度お試しください。";
  throw error;
}

export function createStripeClient(config) {
  async function stripeRequest(path, { method = "GET", query = {}, form = null } = {}) {
    if (!config.stripeSecretKey) {
      throw jsonError("STRIPE_SECRET_KEY が未設定です。", 500);
    }

    const url = new URL(`${config.stripeApiBaseUrl}${path}`);

    for (const [key, value] of Object.entries(query || {})) {
      if (value == null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.stripeSecretKey}`,
        "Stripe-Version": config.stripeApiVersion,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
      },
      body: form ? toStripeForm(form) : undefined
    });

    return parseStripeResponse(response);
  }

  return {
    async createCustomer({ email, name, metadata = {} } = {}) {
      return stripeRequest("/customers", {
        method: "POST",
        form: {
          email,
          name,
          ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`metadata[${key}]`, value]))
        }
      });
    },

    async lookupPriceByLookupKey(lookupKey) {
      const payload = await stripeRequest("/prices", {
        method: "GET",
        query: {
          "lookup_keys[]": lookupKey,
          active: true,
          limit: 10
        }
      });

      return payload?.data?.[0] || null;
    },

    async createCheckoutSession({
      customerId,
      priceId,
      successUrl,
      cancelUrl,
      clientReferenceId,
      metadata = {},
      trialDays = 7
    }) {
      const form = {
        mode: "subscription",
        customer: customerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: clientReferenceId,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": 1,
        ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`metadata[${key}]`, value])),
        ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`subscription_data[metadata][${key}]`, value]))
      };

      if (Number.isFinite(Number(trialDays)) && Number(trialDays) > 0) {
        form["subscription_data[trial_period_days]"] = Number(trialDays);
      }

      return stripeRequest("/checkout/sessions", {
        method: "POST",
        form
      });
    },

    async retrieveCheckoutSession(sessionId) {
      return stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET"
      });
    },

    async retrieveSubscription(subscriptionId) {
      return stripeRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "GET"
      });
    },

    async createBillingPortalSession({ customerId, returnUrl }) {
      return stripeRequest("/billing_portal/sessions", {
        method: "POST",
        form: {
          customer: customerId,
          return_url: returnUrl
        }
      });
    }
  };
}
