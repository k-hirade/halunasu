import express from "express";

import { createStore } from "@medical/core";

import { loadBillingConfig } from "./config.js";
import { sendError } from "./lib/http.js";
import { requireOperatorAuth, requireOperatorCsrf } from "./lib/operator-auth.js";
import { createSlackSignupNotifier } from "./lib/slack-signup-notifier.js";
import { createSignupMailer } from "./lib/signup-mailer.js";
import { createBillingPortalRouter } from "./routes/billing-portal.js";
import { createContactSignupRouter } from "./routes/contact-signup.js";
import { createInternalBillingRouter } from "./routes/internal-billing.js";
import { createPasswordSetupRouter } from "./routes/password-setup.js";
import { createStripeWebhookRouter } from "./routes/stripe-webhook.js";
import { createStripeClient } from "./stripe-client.js";

const config = loadBillingConfig();
const app = express();
app.set("trust proxy", Number.parseInt(process.env.TRUST_PROXY_HOPS || "1", 10) || 1);

const store = createStore({
  backend: config.storeBackend,
  allowRuntimeBootstrap: config.allowRuntimeBootstrap
});
const stripeClient = createStripeClient(config);
const signupMailer = createSignupMailer({ config });
const slackSignupNotifier = createSlackSignupNotifier({ config });
const operatorAuth = requireOperatorAuth({ store, config });
const operatorCsrf = requireOperatorCsrf({ config });

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");

  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  const origin = req.get("origin");

  if (origin && config.allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-CSRF-Token, X-Billing-Internal-Secret");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    if (origin && !config.allowedOrigins.has(origin)) {
      res.status(403).end();
      return;
    }

    res.status(204).end();
    return;
  }

  if (origin && !config.allowedOrigins.has(origin)) {
    res.status(403).json({ error: "このアクセス元からは接続できません。" });
    return;
  }

  next();
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "medical-billing",
    env: config.appEnv
  });
});

app.use(createStripeWebhookRouter({ store, config }));
app.use(express.json({ limit: "1mb" }));
app.use(createContactSignupRouter({ store, config, signupMailer, slackNotifier: slackSignupNotifier }));
app.use(createPasswordSetupRouter({ store }));
app.use(createBillingPortalRouter({
  store,
  stripeClient,
  config,
  requireOperatorAuth: operatorAuth,
  requireOperatorCsrf: operatorCsrf
}));
app.use(createInternalBillingRouter({ store, stripeClient, config }));

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.use((error, _req, res, _next) => {
  if ((error?.statusCode || 500) >= 500) {
    console.error("[billing] unexpected error", error);
  }

  sendError(res, error, 500);
});

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => {
    console.log(`[billing] listening on :${config.port}`);
  });
}

export { app };
