import express from "express";
import crypto from "node:crypto";

import { processStripeEventHandler } from "../handlers/process-stripe-event.js";
import { sendError } from "../lib/http.js";
import { verifyStripeWebhookSignature } from "../webhook-verify.js";

function hashPayload(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function createStripeWebhookRouter({ store, config }) {
  const router = express.Router();

  router.post("/api/v1/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    try {
      const payloadBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");
      verifyStripeWebhookSignature({
        payload: payloadBuffer,
        signatureHeader: req.get("stripe-signature"),
        endpointSecret: config.stripeWebhookSecret,
        toleranceSeconds: config.stripeWebhookToleranceSeconds
      });

      const event = JSON.parse(payloadBuffer.toString("utf8"));
      await store.createStripeEventReceipt?.({
        eventId: event.id,
        type: event.type,
        livemode: Boolean(event.livemode),
        apiVersion: event.api_version || null,
        objectId: event.data?.object?.id || null,
        payloadHash: hashPayload(payloadBuffer),
        payload: event,
        status: "received"
      });

      const result = await processStripeEventHandler({
        store,
        event,
        config
      });

      res.json({
        received: true,
        eventId: event.id,
        status: result.receipt?.status || "processed"
      });
    } catch (error) {
      let payloadEventId = null;
      let payloadEventType = null;

      try {
        const parsed = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || ""));
        payloadEventId = parsed?.id || null;
        payloadEventType = parsed?.type || null;
      } catch {
        // ignore parse failures; signature or body errors are still logged below
      }

      console.warn("[billing] stripe webhook rejected", {
        message: error?.message || "unknown_error",
        statusCode: error?.statusCode || 400,
        eventId: payloadEventId,
        eventType: payloadEventType
      });
      sendError(res, error, 400);
    }
  });

  return router;
}
