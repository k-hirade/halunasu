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
    const determinantHash = await textFingerprint(JSON.stringify({
      encounterType: extraction.encounterType || null,
      visitKind: extraction.visitKind || null,
      facilityResidence: extraction.facilityResidence === true,
      privateResidence: extraction.privateResidence === true,
      singleBuildingPatientCount: extraction.singleBuildingPatientCount ?? null,
      sameBuilding: extraction.sameBuilding ?? null
    }));
    const sourceSurfaceHash = await textFingerprint(JSON.stringify(
      sourceSurfaceRevisionPayload(extraction.sourceSurfaces)
    ));
    return [
      extraction.externalPatientId,
      extraction.sourceRecordId,
      clinicalTextHash,
      determinantHash,
      sourceSurfaceHash
    ].join(":");
  }

  async function sealSourceSurfaces(sourceSurfaces = {}, input = {}) {
    const observedAt = input.observedAt || new Date().toISOString();
    const result = {};
    for (const name of ["currentChart", "documents"]) {
      const surface = sourceSurfaces?.[name];
      if (!surface) {
        continue;
      }
      const revisionPayload = sourceSurfacePayload(surface);
      result[name] = {
        ...revisionPayload,
        observedAt,
        surfaceHash: await textFingerprint(JSON.stringify(revisionPayload))
      };
    }
    return result;
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
      clinicalTextNodeCount: extraction.clinicalTextNodeCount,
      surfaceProofs: Object.fromEntries(
        Object.entries(extraction.sourceSurfaces || {}).map(([name, surface]) => [name, {
          status: surface.status,
          patientId: surface.patientId,
          observedAt: surface.observedAt,
          surfaceHash: surface.surfaceHash
        }])
      )
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

  function sourceSurfacePayload(surface = {}) {
    return {
      status: surface.status || "unavailable",
      patientId: surface.patientId || "",
      ...(surface.status === "ok" ? { raw: surface.raw || {} } : {}),
      ...(surface.status === "unavailable"
        ? { unavailableReason: surface.unavailableReason || "fetch_failed" }
        : {})
    };
  }

  function sourceSurfaceRevisionPayload(sourceSurfaces = {}) {
    return Object.fromEntries(
      Object.entries(sourceSurfaces || {}).map(([name, surface]) => [
        name,
        {
          status: surface.status,
          patientId: surface.patientId,
          surfaceHash: surface.surfaceHash
        }
      ])
    );
  }

  global.HalunasuSidecarProof = Object.freeze({
    buildExtractionProof,
    previewFingerprint,
    sealSourceSurfaces,
    sameIdentity,
    textFingerprint
  });
})(globalThis);
