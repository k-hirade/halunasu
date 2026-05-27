import crypto from "node:crypto";

const SCRYPT_PARAMS = Object.freeze({
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
  maxmem: 64 * 1024 * 1024
});

export function hashPassword(password, options = {}) {
  const normalized = requirePassword(password);
  const salt = options.salt || crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(normalized, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.cost,
    r: SCRYPT_PARAMS.blockSize,
    p: SCRYPT_PARAMS.parallelization,
    maxmem: SCRYPT_PARAMS.maxmem
  });

  return [
    "scrypt",
    SCRYPT_PARAMS.cost,
    SCRYPT_PARAMS.blockSize,
    SCRYPT_PARAMS.parallelization,
    SCRYPT_PARAMS.keyLength,
    salt,
    hash.toString("base64url")
  ].join("$");
}

export function verifyPassword(password, storedHash) {
  const normalized = requirePassword(password);
  if (typeof storedHash !== "string") {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") {
    return false;
  }

  const [, cost, blockSize, parallelization, keyLength, salt, expectedHash] = parts;
  const derived = crypto.scryptSync(normalized, salt, Number.parseInt(keyLength, 10), {
    N: Number.parseInt(cost, 10),
    r: Number.parseInt(blockSize, 10),
    p: Number.parseInt(parallelization, 10),
    maxmem: SCRYPT_PARAMS.maxmem
  });
  const expected = Buffer.from(expectedHash, "base64url");

  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function requirePassword(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError("password is required", "password");
  }

  if (value.length < 12) {
    throw validationError("password must be at least 12 characters", "password");
  }

  return value;
}

function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}
