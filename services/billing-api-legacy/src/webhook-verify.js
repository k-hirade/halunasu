import crypto from "node:crypto";

function timingSafeEqualHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyStripeWebhookSignature({
  payload,
  signatureHeader,
  endpointSecret,
  toleranceSeconds = 300,
  now = Date.now()
}) {
  if (!endpointSecret) {
    const error = new Error("STRIPE_WEBHOOK_SECRET must be configured.");
    error.statusCode = 500;
    throw error;
  }

  const items = String(signatureHeader || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const separator = item.indexOf("=");
      if (separator === -1) {
        return acc;
      }
      const key = item.slice(0, separator);
      const value = item.slice(separator + 1);
      acc[key] = acc[key] || [];
      acc[key].push(value);
      return acc;
    }, {});

  const timestamp = Number(items.t?.[0] || 0);
  const signatures = items.v1 || [];

  if (!timestamp || signatures.length === 0) {
    const error = new Error("Stripe-Signature header is invalid.");
    error.statusCode = 400;
    throw error;
  }

  const ageSeconds = Math.abs(now - (timestamp * 1000)) / 1000;
  if (ageSeconds > toleranceSeconds) {
    const error = new Error("Stripe webhook signature is too old.");
    error.statusCode = 400;
    throw error;
  }

  const rawPayload = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ""), "utf8");
  const expected = crypto
    .createHmac("sha256", endpointSecret)
    .update(`${timestamp}.${rawPayload.toString("utf8")}`)
    .digest("hex");

  const valid = signatures.some((signature) => timingSafeEqualHex(signature, expected));
  if (!valid) {
    const error = new Error("Stripe webhook signature verification failed.");
    error.statusCode = 400;
    throw error;
  }

  return {
    timestamp,
    signatures
  };
}
