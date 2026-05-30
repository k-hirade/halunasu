const DEFAULT_STRIPE_API_VERSION = "2026-03-25.dahlia";

export function createStripeBillingClientFromEnv(env = process.env) {
  return new StripeBillingClient({
    secretKey: env.STRIPE_SECRET_KEY || "",
    apiBaseUrl: env.STRIPE_API_BASE_URL || "https://api.stripe.com/v1",
    apiVersion: env.STRIPE_API_VERSION || DEFAULT_STRIPE_API_VERSION,
    priceId: env.STRIPE_PRICE_ID || "",
    priceLookupKey: env.STRIPE_PRICE_LOOKUP_KEY || "medical_ai_monthly_jpy_v2",
    trialDays: parseInteger(env.STRIPE_CHECKOUT_TRIAL_DAYS, 0)
  });
}

export class StripeBillingClient {
  constructor(options = {}) {
    this.secretKey = options.secretKey || "";
    this.apiBaseUrl = (options.apiBaseUrl || "https://api.stripe.com/v1").replace(/\/$/u, "");
    this.apiVersion = options.apiVersion || DEFAULT_STRIPE_API_VERSION;
    this.priceId = options.priceId || "";
    this.priceLookupKey = options.priceLookupKey || "medical_ai_monthly_jpy_v2";
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

  async lookupPrice() {
    if (this.priceId) {
      return { id: this.priceId };
    }

    const response = await this.request("GET", "/prices", {
      "lookup_keys[]": this.priceLookupKey,
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
    const price = await this.lookupPrice();
    return {
      price,
      session: await this.request("POST", "/checkout/sessions", compactObject({
        mode: "subscription",
        customer: input.customerId,
        "line_items[0][price]": price.id,
        "line_items[0][quantity]": String(input.quantity || 1),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.clientReferenceId,
        "metadata[orgId]": input.metadata?.orgId,
        "metadata[organizationCode]": input.metadata?.organizationCode,
        "metadata[source]": input.metadata?.source || "platform-api",
        "subscription_data[metadata][orgId]": input.metadata?.orgId,
        "subscription_data[metadata][organizationCode]": input.metadata?.organizationCode,
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
