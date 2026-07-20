(function registerSidecarContent(global) {
  "use strict";

  const contract = global.HalunasuSidecarContract;
  const proof = global.HalunasuSidecarProof;
  const MAX_EXTRACTION_ATTEMPTS = 3;

  async function extractStableChart() {
    let lastError;
    for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
      try {
        return await extractOnce();
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === MAX_EXTRACTION_ATTEMPTS) {
          throw error;
        }
        await delay(40 * attempt);
      }
    }
    throw lastError;
  }

  async function extractOnce() {
    const identityBefore = contract.readIdentity(document, { locationHref: location.href });
    const container = document.querySelector("#pdetail_karte");
    let domMutationDetected = false;
    const observer = container ? new MutationObserver(() => { domMutationDetected = true; }) : null;
    observer?.observe(container, { subtree: true, childList: true, characterData: true, attributes: true });
    try {
      await Promise.resolve();
      const extraction = contract.extractContractSnapshot(document, { locationHref: location.href });
      await Promise.resolve();
      const identityAfter = contract.readIdentity(document, { locationHref: location.href });
      if (domMutationDetected || !proof.sameIdentity(identityBefore, identityAfter)) {
        const error = new Error("カルテ切替を検知しました。再読み取りします。");
        error.code = "chart_changed_during_extraction";
        error.retryable = true;
        throw error;
      }
      return {
        ...extraction,
        identityBefore,
        identityAfter,
        previewFingerprint: await proof.previewFingerprint(extraction)
      };
    } finally {
      observer?.disconnect();
    }
  }

  async function prepareCalculation(expectedFingerprint) {
    const extraction = await extractStableChart();
    if (!expectedFingerprint || extraction.previewFingerprint !== expectedFingerprint) {
      const error = new Error("表示中のカルテが読み取り時から変わりました。再読み取りしてください。");
      error.code = "preview_changed";
      throw error;
    }
    return {
      externalPatientId: extraction.externalPatientId,
      sourceRecordId: extraction.sourceRecordId,
      sourceRecordDisplayId: extraction.sourceRecordDisplayId,
      serviceDate: extraction.serviceDate,
      receptionTime: extraction.receptionTime,
      clinicalText: extraction.clinicalText,
      facilityResidence: extraction.facilityResidence,
      privateResidence: extraction.privateResidence,
      singleBuildingPatientCount: extraction.singleBuildingPatientCount,
      sameBuilding: extraction.sameBuilding,
      sameBuildingSource: extraction.sameBuildingSource,
      previewFingerprint: extraction.previewFingerprint,
      extractionProof: proof.buildExtractionProof(extraction, {
        identityBefore: extraction.identityBefore,
        identityAfter: extraction.identityAfter,
        domMutationDetected: false,
        previewMatched: true,
        extractedAt: new Date().toISOString()
      })
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!["halunasu:extract", "halunasu:prepare-calculation"].includes(message?.type)) {
      return false;
    }
    const operation = message.type === "halunasu:extract"
      ? extractStableChart()
      : prepareCalculation(message.previewFingerprint);
    operation
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error),
        code: error?.code || "extraction_failed",
        contractVersion: error?.contractVersion || contract.VERSION
      }));
    return true;
  });

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})(globalThis);
