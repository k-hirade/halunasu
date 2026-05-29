import express from "express";
import {
  parseJsonBody,
  passwordSetupRequestSchema,
  passwordSetupTokenStateResponseSchema
} from "@medical/contracts";

import { sendError } from "../lib/http.js";
import { assertWithinRateLimit, getClientIp } from "../lib/rate-limit.js";

export function createPasswordSetupRouter({ store }) {
  const router = express.Router();

  router.get("/api/v1/password-setup/:tokenId", async (req, res) => {
    try {
      await assertWithinRateLimit({
        store,
        bucket: "billing-password-setup-inspect-ip",
        identifier: getClientIp(req),
        limit: 30,
        windowMs: 10 * 60_000
      });
      await assertWithinRateLimit({
        store,
        bucket: "billing-password-setup-inspect-token",
        identifier: req.params.tokenId,
        limit: 10,
        windowMs: 10 * 60_000,
        message: "初回設定リンクへのアクセスが集中しています。少し待ってからもう一度お試しください。"
      });

      const token = await store.getPasswordSetupToken?.(req.params.tokenId, {
        includeInactive: true
      });

      if (!token) {
        res.status(404).json({ error: "初回設定リンクが見つかりません。" });
        return;
      }

      res.json(passwordSetupTokenStateResponseSchema.parse({
        token
      }));
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post("/api/v1/password-setup/:tokenId", async (req, res) => {
    try {
      await assertWithinRateLimit({
        store,
        bucket: "billing-password-setup-submit-ip",
        identifier: getClientIp(req),
        limit: 10,
        windowMs: 10 * 60_000
      });
      await assertWithinRateLimit({
        store,
        bucket: "billing-password-setup-submit-token",
        identifier: req.params.tokenId,
        limit: 5,
        windowMs: 10 * 60_000,
        message: "初回設定の試行回数が上限に達しました。少し待ってからもう一度お試しください。"
      });

      const input = parseJsonBody(passwordSetupRequestSchema, req.body);
      const consumed = await store.consumePasswordSetupToken?.({
        tokenId: req.params.tokenId,
        password: input.password
      });

      res.json({
        ok: true,
        token: passwordSetupTokenStateResponseSchema.parse({
          token: {
            ...consumed.token
          }
        }).token
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });
  return router;
}
