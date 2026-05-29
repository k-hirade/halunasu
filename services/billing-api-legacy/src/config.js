function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isLocalOrigin(origin) {
  return origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000";
}

function parseAllowedOrigins(value, appBaseUrl, { includeLocalhost = false } = {}) {
  const origins = new Set();

  if (includeLocalhost) {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }

  if (appBaseUrl && (includeLocalhost || !isLocalOrigin(appBaseUrl))) {
    origins.add(appBaseUrl);
  }

  for (const item of (value || "").split(",")) {
    const origin = item.trim();
    if (origin) {
      origins.add(origin);
    }
  }

  return origins;
}

export function loadBillingConfig(env = process.env) {
  const isProduction = env.NODE_ENV === "production" || env.APP_ENV === "production";
  const defaultAppBaseUrl = isProduction ? "" : "http://localhost:3000";
  const publicAppBaseUrl = env.PUBLIC_APP_BASE_URL || env.APP_BASE_URL || defaultAppBaseUrl;
  const billingInternalSecret = env.BILLING_INTERNAL_SECRET || "";

  if (isProduction && !billingInternalSecret) {
    throw new Error("BILLING_INTERNAL_SECRET must be configured in production");
  }

  return {
    isProduction,
    appEnv: env.APP_ENV || env.NODE_ENV || "development",
    port: parseInteger(env.PORT || env.BILLING_PORT, 8083),
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS, publicAppBaseUrl, {
      includeLocalhost: !isProduction
    }),
    publicAppBaseUrl,
    publicManualUrl: (env.PUBLIC_MANUAL_URL || "").trim(),
    publicBillingBaseUrl: env.PUBLIC_BILLING_BASE_URL || env.BILLING_BASE_URL || (isProduction ? "" : "http://localhost:8083"),
    stripeSecretKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    stripeApiBaseUrl: env.STRIPE_API_BASE_URL || "https://api.stripe.com/v1",
    stripeApiVersion: env.STRIPE_API_VERSION || "2026-03-25.dahlia",
    stripePriceLookupKey: env.STRIPE_PRICE_LOOKUP_KEY || "medical_ai_monthly_jpy_v2",
    stripeWebhookToleranceSeconds: parseInteger(env.STRIPE_WEBHOOK_TOLERANCE_SECONDS, 300),
    trialDays: parseInteger(env.BILLING_TRIAL_DAYS, 7),
    gracePeriodDays: parseInteger(env.BILLING_GRACE_PERIOD_DAYS, 7),
    portalReturnUrl: env.BILLING_PORTAL_RETURN_URL || `${publicAppBaseUrl}/billing`,
    appSessionSigningSecret: env.APP_SESSION_SIGNING_SECRET || "",
    allowOperatorBearerAuth: parseBoolean(env.APP_ALLOW_OPERATOR_BEARER_AUTH, true),
    emailDeliveryProvider: (env.EMAIL_DELIVERY_PROVIDER || "").trim().toLowerCase(),
    emailFromAddress: (env.EMAIL_FROM_ADDRESS || "").trim(),
    emailReplyToAddress: (env.EMAIL_REPLY_TO_ADDRESS || "").trim(),
    resendApiKey: env.RESEND_API_KEY || "",
    resendApiBaseUrl: env.RESEND_API_BASE_URL || "https://api.resend.com/emails",
    slackSignupWebhookUrl: (env.SLACK_SIGNUP_WEBHOOK_URL || "").trim(),
    slackSignupEnvLabel: (env.SLACK_SIGNUP_ENV_LABEL || "").trim(),
    storeBackend: env.STORE_BACKEND,
    allowRuntimeBootstrap: parseBoolean(env.APP_ENABLE_RUNTIME_BOOTSTRAP, false) && !isProduction,
    billingInternalSecret
  };
}
