import crypto from "node:crypto";

const PREFIX = "v1";

function deriveKey(keyMaterial) {
  if (!keyMaterial) {
    return null;
  }

  const value = String(keyMaterial).trim();

  if (/^[A-Za-z0-9_-]{43,44}$/.test(value)) {
    const decoded = Buffer.from(value, "base64url");

    if (decoded.length === 32) {
      return decoded;
    }
  }

  if (/^[A-Fa-f0-9]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }

  return crypto.createHash("sha256").update(value).digest();
}

function getKey(keyMaterial = process.env.APP_FIELD_ENCRYPTION_KEY) {
  const key = deriveKey(keyMaterial);

  if (!key && process.env.NODE_ENV === "production") {
    const error = new Error("APP_FIELD_ENCRYPTION_KEY is required in production.");
    error.code = "FIELD_ENCRYPTION_KEY_REQUIRED";
    throw error;
  }

  return key;
}

export function createFieldEncryptionKey() {
  return crypto.randomBytes(32).toString("base64url");
}

export function encryptField(value, { keyMaterial } = {}) {
  const key = getKey(keyMaterial);
  const plaintext = String(value || "");

  if (!key) {
    return `plain:${Buffer.from(plaintext, "utf8").toString("base64url")}`;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptField(value, { keyMaterial } = {}) {
  const storedValue = String(value || "");

  if (storedValue.startsWith("plain:")) {
    return Buffer.from(storedValue.slice("plain:".length), "base64url").toString("utf8");
  }

  const [prefix, ivText, tagText, ciphertextText] = storedValue.split(":");

  if (prefix !== PREFIX || !ivText || !tagText || !ciphertextText) {
    throw new Error("Invalid encrypted field value.");
  }

  const key = getKey(keyMaterial);

  if (!key) {
    throw new Error("Field encryption key is required to decrypt this value.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));

  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}
