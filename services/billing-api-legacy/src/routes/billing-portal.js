import express from "express";
import {
  billingCheckoutSessionResponseSchema,
  billingPortalSessionResponseSchema,
  billingStatusResponseSchema
} from "@medical/contracts";

import { createOrganizationCheckoutSessionHandler } from "../handlers/create-org-checkout-session.js";
import { sendError } from "../lib/http.js";
import { requireBillingManagement } from "../lib/operator-auth.js";

export function createBillingPortalRouter({ store, stripeClient, config, requireOperatorAuth, requireOperatorCsrf }) {
  const router = express.Router();

  router.get("/api/v1/billing/status", requireOperatorAuth, async (req, res) => {
    try {
      const organization = await store.getOrganization?.(req.operator.orgId);

      if (!organization) {
        res.status(404).json({ error: "病院情報が見つかりません。" });
        return;
      }

      res.json(billingStatusResponseSchema.parse({
        billing: organization.billing || null,
        access: organization.access || null
      }));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post(
    "/api/v1/billing/checkout-session",
    requireOperatorAuth,
    requireOperatorCsrf,
    requireBillingManagement,
    async (req, res) => {
      try {
        const result = await createOrganizationCheckoutSessionHandler({
          store,
          stripeClient,
          config,
          orgId: req.operator.orgId
        });

        res.json(billingCheckoutSessionResponseSchema.parse(result.checkout));
      } catch (error) {
        sendError(res, error, 400);
      }
    }
  );

  router.post(
    "/api/v1/billing/portal-session",
    requireOperatorAuth,
    requireOperatorCsrf,
    requireBillingManagement,
    async (req, res) => {
      try {
        const organization = await store.getOrganization?.(req.operator.orgId);

        if (!organization) {
          res.status(404).json({ error: "病院情報が見つかりません。" });
          return;
        }

        const customerId = organization.billing?.stripeCustomerId || null;

        if (!customerId) {
          res.status(409).json({ error: "Stripe の契約情報がまだ紐付いていません。" });
          return;
        }

        const portalSession = await stripeClient.createBillingPortalSession({
          customerId,
          returnUrl: config.portalReturnUrl
        });

        res.json(billingPortalSessionResponseSchema.parse({
          url: portalSession.url
        }));
      } catch (error) {
        sendError(res, error, 400);
      }
    }
  );

  return router;
}
