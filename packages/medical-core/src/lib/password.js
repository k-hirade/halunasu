import crypto from "node:crypto";

const PASSWORD_HASH_ALGORITHM = "pbkdf2_sha256";
const DEFAULT_ITERATIONS = 210_000;
const KEY_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 12;

export function normalizeLoginIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

export function buildLoginIdentityKey(organizationCode, loginId) {
  const normalizedOrganizationCode = normalizeLoginIdentifier(organizationCode);
  const normalizedLoginId = normalizeLoginIdentifier(loginId);
  return `${normalizedOrganizationCode}_${normalizedLoginId}`.replace(/[^a-z0-9_.-]/g, "_");
}

export function hashPassword(password, { salt = crypto.randomBytes(18).toString("base64url"), iterations = DEFAULT_ITERATIONS } = {}) {
  const digest = crypto
    .pbkdf2Sync(String(password || ""), salt, iterations, KEY_LENGTH, "sha256")
    .toString("base64url");

  return `${PASSWORD_HASH_ALGORITHM}$${iterations}$${salt}$${digest}`;
}

export function validatePasswordPolicy(password) {
  const value = String(password || "");
  const errors = [];

  if (value.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  if (value.length > 128) {
    errors.push("Password must be 128 characters or fewer.");
  }

  if (!/[A-Za-z]/.test(value)) {
    errors.push("Password must include at least one letter.");
  }

  if (!/[0-9]/.test(value)) {
    errors.push("Password must include at least one number.");
  }

  if (!/[^A-Za-z0-9]/.test(value)) {
    errors.push("Password must include at least one symbol.");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function assertPasswordPolicy(password) {
  const result = validatePasswordPolicy(password);

  if (!result.valid) {
    const error = new Error("Password does not meet policy.");
    error.code = "PASSWORD_POLICY_VIOLATION";
    error.statusCode = 400;
    error.publicMessage = "パスワードは12文字以上で、英字・数字・記号をそれぞれ1文字以上含めてください。";
    error.details = result.errors;
    throw error;
  }
}

export function verifyPassword(password, storedHash) {
  const [algorithm, iterationsText, salt, expectedDigest] = String(storedHash || "").split("$");

  if (algorithm !== PASSWORD_HASH_ALGORITHM || !iterationsText || !salt || !expectedDigest) {
    return false;
  }

  const iterations = Number(iterationsText);

  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }

  const actualDigest = crypto
    .pbkdf2Sync(String(password || ""), salt, iterations, KEY_LENGTH, "sha256")
    .toString("base64url");
  const actualBuffer = Buffer.from(actualDigest);
  const expectedBuffer = Buffer.from(expectedDigest);

  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
