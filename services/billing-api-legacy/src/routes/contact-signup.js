import express from "express";
import {
  contactSignupResponseSchema,
  contactSignupStatusResponseSchema,
  contactSignupVerificationInspectResponseSchema,
  contactSignupVerificationResponseSchema,
  createContactSignupRequestSchema,
  parseJsonBody,
  resendContactSignupMailResponseSchema,
  verifyContactSignupQuerySchema,
  verifyContactSignupRequestSchema
} from "@medical/contracts";

import { createContactSignupHandler } from "../handlers/create-contact-signup.js";
import { inspectContactSignupVerificationHandler } from "../handlers/inspect-contact-signup-verification.js";
import { resendContactSignupMailHandler } from "../handlers/resend-contact-signup-mail.js";
import { verifyContactSignupHandler } from "../handlers/verify-contact-signup.js";
import { toPublicContactSignupSummary } from "../lib/contact-signup.js";
import { sendError } from "../lib/http.js";
import { assertWithinRateLimit, getClientIp } from "../lib/rate-limit.js";

function resolvePublicBaseUrl(req, config) {
  return config.publicBillingBaseUrl || `${req.protocol}://${req.get("host")}`;
}

function buildVerificationUrl(req, config, tokenId) {
  const publicAppBaseUrl = config.publicAppBaseUrl || resolvePublicBaseUrl(req, config);
  return `${publicAppBaseUrl}/contact-signup/verify?token=${encodeURIComponent(tokenId)}`;
}

export function createContactSignupRouter({ store, config, signupMailer, slackNotifier }) {
  const router = express.Router();

  router.post("/api/v1/contact-signups", async (req, res) => {
    try {
      const input = parseJsonBody(createContactSignupRequestSchema, req.body);
      const clientIp = getClientIp(req);

      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-ip",
        identifier: clientIp,
        limit: 10,
        windowMs: 10 * 60_000
      });
      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-email",
        identifier: String(input.adminEmail || "").trim().toLowerCase(),
        limit: 3,
        windowMs: 30 * 60_000,
        message: "短時間に同じメールアドレスからの送信が集中しています。少し待ってからもう一度お試しください。"
      });

      const result = await createContactSignupHandler({
        store,
        input,
        config,
        clientIp,
        userAgent: req.get("user-agent") || null
      });
      const verificationPreviewUrl = result.verificationToken
        ? buildVerificationUrl(req, config, result.verificationToken.tokenId)
        : null;

      if (verificationPreviewUrl) {
        await signupMailer?.sendVerificationMail?.({
          signup: result.signup,
          verificationUrl: verificationPreviewUrl,
          expiresAt: result.verificationToken?.record?.expiresAt || null
        });
      }

      res.status(result.reused ? 200 : 201).json(contactSignupResponseSchema.parse({
        signup: toPublicContactSignupSummary(result.signup),
        verificationRequested: Boolean(result.verificationToken),
        verificationPreviewUrl: config.isProduction ? null : verificationPreviewUrl
      }));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get("/api/v1/contact-signups/verify", async (req, res) => {
    try {
      const { token } = verifyContactSignupQuerySchema.parse(req.query || {});

      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-verify-inspect-ip",
        identifier: getClientIp(req),
        limit: 60,
        windowMs: 10 * 60_000
      });
      const inspection = await inspectContactSignupVerificationHandler({
        store,
        token
      });

      res.json(contactSignupVerificationInspectResponseSchema.parse(inspection));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post("/api/v1/contact-signups/verify", async (req, res) => {
    try {
      const { token } = parseJsonBody(verifyContactSignupRequestSchema, req.body);
      const clientIp = getClientIp(req);

      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-verify-submit-ip",
        identifier: clientIp,
        limit: 20,
        windowMs: 10 * 60_000
      });
      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-verify-submit-token",
        identifier: token,
        limit: 5,
        windowMs: 10 * 60_000
      });
      const provisioned = await verifyContactSignupHandler({
        store,
        token,
        config,
        mailer: signupMailer,
        slackNotifier
      });

      res.json(contactSignupVerificationResponseSchema.parse(provisioned));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get("/api/v1/contact-signups/:signupId/status", async (req, res) => {
    try {
      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-status-ip",
        identifier: getClientIp(req),
        limit: 120,
        windowMs: 10 * 60_000
      });

      const signup = await store.getSignupApplication?.(req.params.signupId);

      if (!signup || signup.source !== "lp_contact_form") {
        res.status(404).json({ error: "申込情報が見つかりません。" });
        return;
      }

      res.json(contactSignupStatusResponseSchema.parse({
        signup: toPublicContactSignupSummary(signup)
      }));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post("/api/v1/contact-signups/:signupId/resend", async (req, res) => {
    try {
      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-resend-ip",
        identifier: getClientIp(req),
        limit: 10,
        windowMs: 10 * 60_000
      });
      await assertWithinRateLimit({
        store,
        bucket: "billing-contact-signup-resend-signup",
        identifier: req.params.signupId,
        limit: 3,
        windowMs: 30 * 60_000,
        message: "メールの再送回数が上限に達しました。少し待ってからもう一度お試しください。"
      });

      const result = await resendContactSignupMailHandler({
        store,
        signupId: req.params.signupId,
        config,
        signupMailer,
        buildVerificationUrl: (tokenId) => buildVerificationUrl(req, config, tokenId)
      });

      res.json(resendContactSignupMailResponseSchema.parse(result));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
