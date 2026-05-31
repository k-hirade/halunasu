const DEFAULT_STRIPE_API_VERSION = "2026-05-27.dahlia";

export function createStripeBillingClientFromEnv(env = process.env) {
  return new StripeBillingClient({
    secretKey: env.STRIPE_SECRET_KEY || "",
    apiBaseUrl: env.STRIPE_API_BASE_URL || "https://api.stripe.com/v1",
    apiVersion: env.STRIPE_API_VERSION || DEFAULT_STRIPE_API_VERSION,
    priceId: env.STRIPE_PRICE_ID || "",
    priceLookupKey: env.STRIPE_PRICE_LOOKUP_KEY
      || env.STRIPE_CHARTING_FLAT_PRICE_LOOKUP_KEY
      || "halunasu_charting_flat_monthly_jpy_v1",
    trialDays: parseInteger(env.STRIPE_CHECKOUT_TRIAL_DAYS, 0)
  });
}

export class StripeBillingClient {
  constructor(options = {}) {
    this.secretKey = options.secretKey || "";
    this.apiBaseUrl = (options.apiBaseUrl || "https://api.stripe.com/v1").replace(/\/$/u, "");
    this.apiVersion = options.apiVersion || DEFAULT_STRIPE_API_VERSION;
    this.priceId = options.priceId || "";
    this.priceLookupKey = options.priceLookupKey || "halunasu_charting_flat_monthly_jpy_v1";
    this.trialDays = Number.isFinite(Number(options.trialDays)) ? Number(options.trialDays) : 0;
  }

  isConfigured() {
    return Boolean(this.secretKey && (this.priceId || this.priceLookupKey));
  }

  configurationView() {
    return {
      configured: this.isConfigured(),
      apiVersion: this.apiVersion,
      priceConfiguredBy: this.priceId ? "price_id" : "lookup_key",
      priceLookupKey: this.priceId ? null : this.priceLookupKey,
      trialDays: this.trialDays
    };
  }

  async lookupPrice(input = {}) {
    const priceId = input.priceId || this.priceId;
    const lookupKey = input.lookupKey || this.priceLookupKey;
    if (priceId) {
      return { id: priceId };
    }

    const response = await this.request("GET", "/prices", {
      "lookup_keys[]": lookupKey,
      active: "true",
      limit: "1"
    });
    const price = response.data?.[0] || null;
    if (!price?.id) {
      const error = new Error("Stripe Price was not found for configured lookup key");
      error.name = "StripeConfigurationError";
      error.statusCode = 503;
      throw error;
    }

    return price;
  }

  async createCustomer(input = {}) {
    return this.request("POST", "/customers", compactObject({
      email: input.email || undefined,
      name: input.name || undefined,
      "metadata[orgId]": input.metadata?.orgId,
      "metadata[organizationCode]": input.metadata?.organizationCode,
      "metadata[source]": input.metadata?.source || "platform-api"
    }));
  }

  async createSubscriptionCheckoutSession(input = {}) {
    const requestedLineItems = Array.isArray(input.lineItems) && input.lineItems.length
      ? input.lineItems
      : [{ priceId: this.priceId, priceLookupKey: this.priceLookupKey, quantity: input.quantity || 1 }];
    const lineItems = [];
    for (const item of requestedLineItems) {
      const price = await this.lookupPrice({
        priceId: item.priceId,
        lookupKey: item.priceLookupKey || item.lookupKey
      });
      const quantity = Number.parseInt(String(item.quantity || 1), 10);
      lineItems.push({
        ...item,
        price,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1
      });
    }

    const lineItemParams = {};
    lineItems.forEach((item, index) => {
      lineItemParams[`line_items[${index}][price]`] = item.price.id;
      lineItemParams[`line_items[${index}][quantity]`] = String(item.quantity);
    });

    return {
      price: lineItems[0]?.price || null,
      lineItems,
      session: await this.request("POST", "/checkout/sessions", compactObject({
        mode: "subscription",
        customer: input.customerId,
        ...lineItemParams,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.clientReferenceId,
        "metadata[orgId]": input.metadata?.orgId,
        "metadata[organizationCode]": input.metadata?.organizationCode,
        "metadata[productIds]": input.metadata?.productIds,
        "metadata[source]": input.metadata?.source || "platform-api",
        "subscription_data[metadata][orgId]": input.metadata?.orgId,
        "subscription_data[metadata][organizationCode]": input.metadata?.organizationCode,
        "subscription_data[metadata][productIds]": input.metadata?.productIds,
        "subscription_data[metadata][source]": input.metadata?.source || "platform-api",
        "subscription_data[trial_period_days]": this.trialDays > 0 ? String(this.trialDays) : undefined
      }))
    };
  }

  async createBillingPortalSession(input = {}) {
    return this.request("POST", "/billing_portal/sessions", {
      customer: input.customerId,
      return_url: input.returnUrl
    });
  }

  async createSubscriptionItem(input = {}) {
    const price = await this.lookupPrice({
      priceId: input.priceId,
      lookupKey: input.priceLookupKey || input.lookupKey
    });
    const quantity = Number.parseInt(String(input.quantity || 1), 10);
    const subscriptionItem = await this.request("POST", "/subscription_items", compactObject({
      subscription: input.subscriptionId,
      price: price.id,
      quantity: Number.isFinite(quantity) && quantity > 0 ? String(quantity) : "1",
      proration_behavior: input.prorationBehavior || "none",
      "metadata[orgId]": input.metadata?.orgId,
      "metadata[organizationCode]": input.metadata?.organizationCode,
      "metadata[productId]": input.metadata?.productId,
      "metadata[kind]": input.metadata?.kind || "flat",
      "metadata[source]": input.metadata?.source || "platform-api"
    }));

    return {
      price,
      subscriptionItem
    };
  }

  async request(method, path, params = {}) {
    if (!this.secretKey) {
      const error = new Error("STRIPE_SECRET_KEY is not configured");
      error.name = "StripeConfigurationError";
      error.statusCode = 503;
      throw error;
    }

    const url = new URL(`${this.apiBaseUrl}${path}`);
    const init = {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "stripe-version": this.apiVersion
      }
    };

    if (method === "GET") {
      for (const [key, value] of Object.entries(compactObject(params))) {
        url.searchParams.append(key, value);
      }
    } else {
      init.headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(compactObject(params)).toString();
    }

    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error?.message || `Stripe API request failed: ${response.status}`);
      error.name = "StripeApiError";
      error.statusCode = response.status >= 500 ? 502 : 400;
      error.stripeStatusCode = response.status;
      throw error;
    }

    return body;
  }
}

function compactObject(input = {}) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)])
  );
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
