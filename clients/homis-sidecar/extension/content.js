(function registerSidecarContent(global) {
  "use strict";

  const contract = global.HalunasuSidecarContract;
  const proof = global.HalunasuSidecarProof;
  const MAX_EXTRACTION_ATTEMPTS = 3;
  const AUTO_READ_DEBOUNCE_MS = 180;
  let observedContainer = null;
  let observedPanel = null;
  let chartObserver = null;
  let panelObserver = null;
  let rootObserver = null;
  let chartChangeTimer = null;

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
      encounterType: extraction.encounterType,
      encounterTypeLabel: extraction.encounterTypeLabel,
      encounterTypeSource: extraction.encounterTypeSource,
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

  startChartMonitoring();

  function startChartMonitoring() {
    syncObservedElements();
    rootObserver = new MutationObserver(() => {
      if (syncObservedElements()) {
        scheduleChartStateNotification();
      }
    });
    rootObserver.observe(document.documentElement || document, { childList: true, subtree: true });
    scheduleChartStateNotification();
  }

  function syncObservedElements() {
    const nextContainer = document.querySelector("#pdetail_karte");
    const nextPanel = document.querySelector("#karte-panel");
    let changed = false;

    if (nextContainer !== observedContainer) {
      chartObserver?.disconnect();
      observedContainer = nextContainer;
      chartObserver = observedContainer
        ? new MutationObserver(scheduleChartStateNotification)
        : null;
      chartObserver?.observe(observedContainer, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-record-id", "data-single-building-patient-count"]
      });
      changed = true;
    }

    if (nextPanel !== observedPanel) {
      panelObserver?.disconnect();
      observedPanel = nextPanel;
      panelObserver = observedPanel
        ? new MutationObserver(scheduleChartStateNotification)
        : null;
      panelObserver?.observe(observedPanel, {
        attributes: true,
        attributeFilter: ["class", "hidden", "style"]
      });
      changed = true;
    }
    return changed;
  }

  function scheduleChartStateNotification() {
    clearTimeout(chartChangeTimer);
    chartChangeTimer = setTimeout(notifyChartState, AUTO_READ_DEBOUNCE_MS);
  }

  function notifyChartState() {
    const identity = contract.readIdentity(document, { locationHref: location.href });
    const available = Boolean(
      observedContainer
      && identity.patientId
      && identity.sourceRecordId
      && !isExplicitlyHidden(observedPanel || observedContainer)
    );
    sendRuntimeMessage({
      type: "halunasu:chart-state-changed",
      available,
      patientId: available ? identity.patientId : "",
      sourceRecordId: available ? identity.sourceRecordId : ""
    });
  }

  function isExplicitlyHidden(element) {
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute?.("aria-hidden") === "true" || current.style?.display === "none") {
        return true;
      }
      if (current === document.body) {
        break;
      }
    }
    const style = element && typeof global.getComputedStyle === "function"
      ? global.getComputedStyle(element)
      : null;
    return style?.display === "none" || style?.visibility === "hidden";
  }

  function sendRuntimeMessage(message) {
    try {
      const pending = chrome.runtime.sendMessage(message);
      pending?.catch?.(() => {});
    } catch {
      // The side panel can be closed; chart monitoring must remain silent in that case.
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})(globalThis);
