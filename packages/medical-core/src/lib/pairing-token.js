import crypto from "node:crypto";

export function createPlainToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token, secret) {
  if (typeof token !== "string" || token.length > 4096) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [body, signature] = parts;

  if (!body || !signature) {
    return null;
  }

  const expectedSignature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (parsed.exp && Date.now() > parsed.exp) {
    return null;
  }

  return parsed;
}

export function signStreamToken(payload, secret) {
  return signToken(
    {
      kind: "stream",
      ...payload
    },
    secret
  );
}

export function verifyStreamToken(token, secret) {
  const parsed = verifyToken(token, secret);

  if (!parsed || parsed.kind !== "stream") {
    return null;
  }

  return parsed;
}

export function signOperatorAccessToken(payload, secret) {
  return signToken(
    {
      kind: "operator",
      scope: "clinician",
      ...payload
    },
    secret
  );
}

export function verifyOperatorAccessToken(token, secret) {
  const parsed = verifyToken(token, secret);

  if (!parsed || parsed.kind !== "operator" || parsed.scope !== "clinician") {
    return null;
  }

  return parsed;
}
