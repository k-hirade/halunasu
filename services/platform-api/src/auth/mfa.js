import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;

export function generateMfaSecret(options = {}) {
  const bytes = options.bytes || crypto.randomBytes(20);
  return base32Encode(bytes);
}

export function createTotpCode(secret, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const periodSeconds = options.periodSeconds || DEFAULT_PERIOD_SECONDS;
  const counter = Math.floor(now.getTime() / 1000 / periodSeconds);

  return createHotpCode(secret, counter, options);
}

export function verifyTotpCode(secret, code, options = {}) {
  const normalizedCode = String(code || "").trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    return false;
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const periodSeconds = options.periodSeconds || DEFAULT_PERIOD_SECONDS;
  const counter = Math.floor(now.getTime() / 1000 / periodSeconds);
  const window = Number.isInteger(options.window) ? options.window : 1;

  for (let offset = -window; offset <= window; offset += 1) {
    const expected = createHotpCode(secret, counter + offset, options);
    if (crypto.timingSafeEqual(Buffer.from(normalizedCode), Buffer.from(expected))) {
      return true;
    }
  }

  return false;
}

export function createOtpAuthUrl({ issuer = "Halunasu", accountName, secret }) {
  const label = `${issuer}:${accountName}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD_SECONDS)
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function createHotpCode(secret, counter, options = {}) {
  const digits = options.digits || DEFAULT_DIGITS;
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(value) {
  const normalized = String(value || "").toUpperCase().replace(/=+$/g, "");
  let bits = 0;
  let buffer = 0;
  const bytes = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new TypeError("MFA secret must be base32");
    }

    buffer = (buffer << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}
