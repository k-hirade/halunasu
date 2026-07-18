(function registerSidecarProof(global) {
  "use strict";

  async function textFingerprint(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    if (global.crypto?.subtle) {
      const digest = await global.crypto.subtle.digest("SHA-256", bytes);
      return `sha256-${bytesToBase64Url(new Uint8Array(digest))}`;
    }

    // Content scripts can run on non-HTTPS hospital intranets where Web Crypto is unavailable.
    // This hash is only a local change detector; authentication remains server-side.
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `fnv1a64-${hash.toString(16).padStart(16, "0")}`;
  }

  async function previewFingerprint(extraction) {
    const clinicalTextHash = await textFingerprint(extraction.clinicalText);
    return [extraction.externalPatientId, extraction.sourceRecordId, clinicalTextHash].join(":");
  }

  function buildExtractionProof(extraction, input = {}) {
    return {
      patientIdBefore: input.identityBefore.patientId,
      patientIdAfter: input.identityAfter.patientId,
      sourceRecordIdBefore: input.identityBefore.sourceRecordId,
      sourceRecordIdAfter: input.identityAfter.sourceRecordId,
      selectorContractVersion: extraction.selectorContractVersion,
      extractedAt: input.extractedAt || new Date().toISOString(),
      domMutationDetected: Boolean(input.domMutationDetected),
      contractValidationPassed: true,
      previewMatched: Boolean(input.previewMatched),
      requiredElementCount: extraction.requiredElementCount,
      matchedRequiredElementCount: extraction.matchedRequiredElementCount,
      clinicalTextNodeCount: extraction.clinicalTextNodeCount
    };
  }

  function sameIdentity(left = {}, right = {}) {
    return Boolean(left.patientId && left.sourceRecordId)
      && left.patientId === right.patientId
      && left.sourceRecordId === right.sourceRecordId;
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  global.HalunasuSidecarProof = Object.freeze({
    buildExtractionProof,
    previewFingerprint,
    sameIdentity,
    textFingerprint
  });
})(globalThis);
