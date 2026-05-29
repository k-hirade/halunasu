import { jsonError } from "./http.js";

const processRateLimitBuckets = new Map();

export function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

async function runRateLimitCheck({ store, bucket, identifier, limit, windowMs }) {
  if (typeof store.checkRateLimit === "function") {
    return store.checkRateLimit({ bucket, identifier, limit, windowMs });
  }

  const key = `${bucket}:${identifier}`;
  const now = Date.now();
  const entry = processRateLimitBuckets.get(key);

  if (!entry || now >= entry.resetAt) {
    const next = {
      limited: false,
      count: 1,
      resetAt: now + windowMs
    };
    processRateLimitBuckets.set(key, next);
    return next;
  }

  entry.count += 1;
  processRateLimitBuckets.set(key, entry);
  return {
    limited: entry.count > limit,
    count: entry.count,
    resetAt: entry.resetAt
  };
}

export async function assertWithinRateLimit({
  store,
  bucket,
  identifier,
  limit,
  windowMs,
  message = "アクセスが集中しています。少し待ってからもう一度お試しください。"
}) {
  const result = await runRateLimitCheck({
    store,
    bucket,
    identifier,
    limit,
    windowMs
  });

  if (result?.limited) {
    const error = jsonError(message, 429);
    error.code = "rate_limited";
    throw error;
  }

  return result;
}
