import {
  decryptField,
  encryptField
} from "../../../../packages/medical-core/src/lib/field-crypto.js";

export function encryptSensitiveField(value) {
  return encryptField(value, { keyMaterial: process.env.APP_FIELD_ENCRYPTION_KEY });
}

export function decryptSensitiveField(value) {
  return decryptField(value, { keyMaterial: process.env.APP_FIELD_ENCRYPTION_KEY });
}

export function resolveIdentityMfaSecret(identity = {}, { pending = false } = {}) {
  const encryptedSecret = pending
    ? identity.mfaPendingSecretEncrypted || identity.mfaSecretEncrypted
    : identity.mfaSecretEncrypted;
  if (encryptedSecret) {
    return decryptSensitiveField(encryptedSecret);
  }

  return pending
    ? identity.mfaPendingSecret || identity.mfaSecret || null
    : identity.mfaSecret || null;
}
