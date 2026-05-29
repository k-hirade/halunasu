import express from "express";
import crypto from "node:crypto";

import {
  enforceTrialExpirationRequestSchema,
  enforceGracePeriodsRequestSchema,
  parseJsonBody,
  processStripeEventRequestSchema,
  reconcileSubscriptionRequestSchema
} from "@medical/contracts";

import { enforceTrialExpirationHandler } from "../handlers/enforce-trial-expiration.js";
import { processStripeEventHandler } from "../handlers/process-stripe-event.js";
import { sendError } from "../lib/http.js";

function timingSafeStringEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));

  if (!left.length || !right.length || left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function internalRequestAllowed(req, config) {
  if (!config.billingInternalSecret && !config.isProduction) {
    return true;
  }

  return timingSafeStringEqual(req.get("x-billing-internal-secret") || "", config.billingInternalSecret);
}

function buildSyntheticSubscriptionEvent(subscription, config) {
  const eventId = [
    "reconcile",
    "customer.subscription.updated",
    subscription.id,
    subscription.updated || Date.now()
  ].join(":");

  return {
    id: eventId,
    type: "customer.subscription.updated",
    livemode: Boolean(subscription.livemode),
    api_version: config.stripeApiVersion,
    data: {
      object: subscription
    }
  };
}

async function enforceGracePeriods({ store, now }) {
  const organizations = (await store.listOrganizations?.()) || [];
  const suspended = [];

  for (const organization of organizations) {
    const billingStatus = organization.billing?.status || null;
    const gracePeriodEndsAt = organization.billing?.gracePeriodEndsAt || null;

    if (!["past_due", "grace_period", "unpaid"].includes(billingStatus) || !gracePeriodEndsAt) {
      continue;
    }

    if (Date.parse(gracePeriodEndsAt) > Date.parse(now)) {
      continue;
    }

    const orgId = organization.orgId || organization.clinicId;
    const updatedBilling = await store.updateOrganizationBilling?.({
      orgId,
      patch: {
        status: "suspended",
        lastStripeEventId: organization.billing?.lastStripeEventId || null
      },
      auditType: "billing.grace_period.enforced"
    });
    const updatedOrganization = await store.updateOrganizationAccess?.({
      orgId,
      patch: {
        status: "suspended",
        reason: "billing.grace_period_expired",
        restrictedAt: organization.access?.restrictedAt || now
      },
      auditType: "billing.access.suspended"
    }) || updatedBilling;

    suspended.push({
      orgId,
      billingStatusBefore: billingStatus,
      gracePeriodEndsAt,
      accessStatus: updatedOrganization?.access?.status || null
    });
  }

  return {
    checkedCount: organizations.length,
    suspendedCount: suspended.length,
    suspended
  };
}

export function createInternalBillingRouter({ store, stripeClient, config }) {
  const router = express.Router();

  router.post("/internal/billing/process-stripe-event", async (req, res) => {
    try {
      if (!internalRequestAllowed(req, config)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      const input = parseJsonBody(processStripeEventRequestSchema, req.body);
      const receipt = await store.getStripeEventReceipt?.(input.eventId);

      if (!receipt?.payload) {
        res.status(404).json({ error: "Stripe event receipt が見つかりません。" });
        return;
      }

      const result = await processStripeEventHandler({
        store,
        event: receipt.payload,
        config
      });

      res.json({
        ok: true,
        receipt: result.receipt,
        outcome: result.outcome
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post("/internal/billing/reconcile-subscription", async (req, res) => {
    try {
      if (!internalRequestAllowed(req, config)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      const input = parseJsonBody(reconcileSubscriptionRequestSchema, req.body);
      const subscription = await stripeClient.retrieveSubscription(input.subscriptionId);
      const event = buildSyntheticSubscriptionEvent(subscription, config);
      const result = await processStripeEventHandler({
        store,
        event,
        config
      });

      res.json({
        ok: true,
        subscriptionId: subscription.id,
        receipt: result.receipt,
        outcome: result.outcome
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post("/internal/billing/enforce-grace-periods", async (req, res) => {
    try {
      if (!internalRequestAllowed(req, config)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      const input = parseJsonBody(enforceGracePeriodsRequestSchema, req.body);
      const result = await enforceGracePeriods({
        store,
        now: input.now || new Date().toISOString()
      });

      res.json({
        ok: true,
        now: input.now || new Date().toISOString(),
        ...result
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post("/internal/billing/enforce-trial-expiration", async (req, res) => {
    try {
      if (!internalRequestAllowed(req, config)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      const input = parseJsonBody(enforceTrialExpirationRequestSchema, req.body);
      const currentNow = input.now || new Date().toISOString();
      const result = await enforceTrialExpirationHandler({
        store,
        now: currentNow
      });

      res.json({
        ok: true,
        now: currentNow,
        ...result
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
