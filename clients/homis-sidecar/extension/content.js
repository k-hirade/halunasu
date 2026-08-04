(function registerSidecarContent(global) {
  "use strict";

  const contract = global.HalunasuSidecarContract;
  const proof = global.HalunasuSidecarProof;
  const MAX_EXTRACTION_ATTEMPTS = 3;
  const SUPPLEMENTAL_SURFACE_TIMEOUT_MS = 2500;
  const CHART_NAVIGATION_TIMEOUT_MS = 2500;
  const CHART_STABILITY_MS = 60;
  const MAX_MONTHLY_CHART_TRANSITIONS = 100;
  const AUTO_READ_DEBOUNCE_MS = 180;
  let observedContainer = null;
  let observedPanel = null;
  let chartObserver = null;
  let panelObserver = null;
  let rootObserver = null;
  let chartChangeTimer = null;
  let chartMonitoringSuppressionDepth = 0;
  let chartStateNotificationPending = false;

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
      const calendarMonth = extraction.sourceSurfaces.currentChart?.raw?.calendarMonth || "";
      const [documents, problems, visitPlan] = await Promise.all([
        fetchDocumentsSurface(identityBefore.patientId),
        fetchProblemsSurface(identityBefore.patientId),
        fetchVisitPlanSurface(identityBefore.patientId, calendarMonth)
      ]);
      extraction.sourceSurfaces = await proof.sealSourceSurfaces({
        ...extraction.sourceSurfaces,
        documents,
        problems,
        visitPlan
      }, { observedAt: new Date().toISOString() });
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
        extractedAt: new Date().toISOString(),
        identityBefore,
        identityAfter,
        previewFingerprint: await proof.previewFingerprint(extraction)
      };
    } finally {
      observer?.disconnect();
    }
  }

  async function prepareCalculation(expectedFingerprint) {
    const previewExtraction = await extractStableChart();
    if (!expectedFingerprint || previewExtraction.previewFingerprint !== expectedFingerprint) {
      const error = new Error("表示中のカルテが読み取り時から変わりました。再読み取りしてください。");
      error.code = "preview_changed";
      throw error;
    }
    const extraction = await withChartMonitoringSuppressed(async () => {
      const encounterHistory = await crawlCurrentMonthEncounterHistory(previewExtraction);
      const restored = await extractStableChart();
      if (
        !proof.sameIdentity(previewExtraction.identityBefore, restored.identityBefore)
        || restored.previewFingerprint !== expectedFingerprint
      ) {
        const error = new Error("過去カルテの確認後に元のカルテを確認できませんでした。再読み取りしてください。");
        error.code = "chart_history_restore_failed";
        throw error;
      }
      if (!encounterHistory) {
        return restored;
      }
      return {
        ...restored,
        sourceSurfaces: await proof.sealSourceSurfaces({
          ...restored.sourceSurfaces,
          visitPlan: encounterHistory
        }, { observedAt: new Date().toISOString() })
      };
    });
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
      visitKind: extraction.visitKind,
      visitKindSource: extraction.visitKindSource,
      facilityResidence: extraction.facilityResidence,
      privateResidence: extraction.privateResidence,
      singleBuildingPatientCount: extraction.singleBuildingPatientCount,
      sameBuilding: extraction.sameBuilding,
      sameBuildingSource: extraction.sameBuildingSource,
      sourceSurfaces: extraction.sourceSurfaces,
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
        characterData: true
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
    if (chartMonitoringSuppressionDepth > 0) {
      chartStateNotificationPending = true;
      return;
    }
    clearTimeout(chartChangeTimer);
    chartChangeTimer = setTimeout(notifyChartState, AUTO_READ_DEBOUNCE_MS);
  }

  function notifyChartState() {
    if (chartMonitoringSuppressionDepth > 0) {
      chartStateNotificationPending = true;
      return;
    }
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

  async function fetchDocumentsSurface(patientId) {
    return fetchSupplementalSurface({
      patientId,
      pageId: "docs_index",
      requiredSelector: ".docs-table",
      read: (parsed) => contract.readDocumentsSurface(parsed, { patientId })
    });
  }

  async function fetchProblemsSurface(patientId) {
    return fetchSupplementalSurface({
      patientId,
      pageId: "patient_problem",
      requiredSelector: ".problem-list",
      read: (parsed) => contract.readProblemsSurface(parsed, { patientId })
    });
  }

  async function fetchVisitPlanSurface(patientId, calendarMonth) {
    return fetchSupplementalSurface({
      patientId,
      pageId: "patient_plan0",
      requiredSelector: ".plan-pattern",
      read: (parsed) => contract.readVisitPlanSurface(parsed, { patientId, calendarMonth })
    });
  }

  async function fetchSupplementalSurface({ patientId, pageId, requiredSelector, read }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUPPLEMENTAL_SURFACE_TIMEOUT_MS);
    try {
      const url = new URL(location.href);
      url.search = "";
      url.searchParams.set("pid", pageId);
      url.searchParams.set("patient_id", patientId);
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        return unavailableSurface(patientId, "http_error");
      }
      const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
      if (!parsed.querySelector(requiredSelector)) {
        return unavailableSurface(patientId, "selector_mismatch");
      }
      if (!documentHeaderMatchesPatient(parsed, patientId)) {
        const error = new Error("補助画面の患者が表示中のカルテと一致しません。再読み取りします。");
        error.code = "supplemental_surface_patient_mismatch";
        error.retryable = true;
        throw error;
      }
      return read(parsed);
    } catch (error) {
      if (error?.code === "supplemental_surface_patient_mismatch") {
        throw error;
      }
      return unavailableSurface(
        patientId,
        error?.name === "AbortError" ? "timeout" : "fetch_failed"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function unavailableSurface(patientId, unavailableReason) {
    return {
      status: "unavailable",
      patientId,
      unavailableReason
    };
  }

  function documentHeaderMatchesPatient(documentRef, patientId) {
    const header = String(documentRef.querySelector(".patient-id-line")?.textContent || "");
    const escaped = String(patientId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)${escaped}\\s*\\/`, "u").test(header);
  }

  async function crawlCurrentMonthEncounterHistory(extraction) {
    const originalIdentity = extraction.identityBefore;
    const currentRaw = extraction.sourceSurfaces?.currentChart?.raw || {};
    const calendarMonth = String(currentRaw.calendarMonth || "");
    const calendarDates = uniqueSortedDates(currentRaw.calendarVisitDates);
    if (
      currentRaw.calendarVisitListCompleteness !== "complete"
      || !/^\d{4}-\d{2}$/u.test(calendarMonth)
      || extraction.serviceDate.slice(0, 7) !== calendarMonth
      || calendarDates.length === 0
      || !calendarDates.includes(extraction.serviceDate)
    ) {
      return null;
    }

    let netPosition = 0;
    let transitionCount = 0;
    let crawlError = null;
    const rowsByRecordId = new Map();
    let initialEntry;
    try {
      initialEntry = visibleEncounterEntry();
    } catch {
      return null;
    }
    if (!validEncounterEntry(initialEntry, originalIdentity.patientId)) {
      return null;
    }
    rowsByRecordId.set(initialEntry.sourceRecordId, encounterHistoryRow(initialEntry));

    const move = async (selector, offset, expectedDirection, previousEntry) => {
      if (transitionCount >= MAX_MONTHLY_CHART_TRANSITIONS) {
        throw crawlFailure("chart_history_transition_limit");
      }
      const previous = contract.readIdentity(document, { locationHref: location.href });
      const transition = await clickAndWaitForChartChange(selector, previous, {
        allowUnchangedBoundary: true
      });
      if (!transition.moved) {
        const rawBoundaryEntry = await readStableVisibleEncounter(previous);
        const boundaryEntry = normalizeEncounterEntryDate(
          rawBoundaryEntry,
          calendarMonth,
          expectedDirection
        );
        if (!validEncounterEntry(boundaryEntry, originalIdentity.patientId)) {
          throw crawlFailure("chart_history_boundary_invalid");
        }
        return { entry: boundaryEntry, boundary: true };
      }
      netPosition += offset;
      transitionCount += 1;
      const rawEntry = await readStableVisibleEncounter(transition.identity);
      const entry = normalizeEncounterEntryDate(rawEntry, calendarMonth, expectedDirection);
      if (!validEncounterEntry(entry, originalIdentity.patientId)) {
        throw crawlFailure("chart_history_entry_invalid");
      }
      if (
        (expectedDirection === "newer" && entry.serviceDate < previousEntry.serviceDate)
        || (expectedDirection === "older" && entry.serviceDate > previousEntry.serviceDate)
      ) {
        throw crawlFailure("chart_history_order_invalid");
      }
      if (entry.serviceDate === previousEntry.serviceDate) {
        throw crawlFailure("chart_history_duplicate_service_date");
      }
      if (entry.serviceDate.startsWith(`${calendarMonth}-`)) {
        const row = encounterHistoryRow(entry);
        const existing = rowsByRecordId.get(row.sourceRecordId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
          throw crawlFailure("chart_history_record_conflict");
        }
        rowsByRecordId.set(row.sourceRecordId, row);
      }
      return { entry, boundary: false };
    };

    try {
      let entry = initialEntry;
      while (true) {
        const result = await move(".flip-next", 1, "newer", entry);
        entry = result.entry;
        if (result.boundary || entry.serviceDate.slice(0, 7) > calendarMonth) {
          break;
        }
      }
      while (true) {
        const result = await move(".flip-prev", -1, "older", entry);
        entry = result.entry;
        if (result.boundary || entry.serviceDate.slice(0, 7) < calendarMonth) {
          break;
        }
      }
    } catch (error) {
      crawlError = error;
    }

    try {
      netPosition = await restoreOriginalChart(originalIdentity, netPosition);
    } catch (error) {
      const restoreError = new Error("過去カルテの確認後に元のカルテへ戻れませんでした。再読み取りしてください。");
      restoreError.code = "chart_history_restore_failed";
      restoreError.cause = error;
      throw restoreError;
    }
    if (crawlError) {
      return null;
    }

    const rows = [...rowsByRecordId.values()]
      .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
    const rowDates = rows.map((row) => row.serviceDate);
    if (
      new Set(rowDates).size !== rows.length
      || !sameStringSet(new Set(rowDates), new Set(calendarDates))
      || rows.some((row) => !row.serviceDate.startsWith(`${calendarMonth}-`))
    ) {
      return null;
    }

    const fetchedPlan = extraction.sourceSurfaces?.visitPlan;
    return {
      status: "ok",
      patientId: originalIdentity.patientId,
      raw: {
        calendarMonth,
        category: fetchedPlan?.status === "ok" ? fetchedPlan.raw?.category || "" : "",
        patternText: fetchedPlan?.status === "ok" ? fetchedPlan.raw?.patternText || "" : "",
        basis: "encounter_history",
        rows,
        listCompleteness: "complete",
        collectionMethod: "chart_navigation",
        traversalComplete: true,
        calendarReconciled: true,
        originalSourceRecordId: originalIdentity.sourceRecordId,
        restoredSourceRecordId: originalIdentity.sourceRecordId
      }
    };
  }

  async function restoreOriginalChart(originalIdentity, netPosition) {
    let position = netPosition;
    while (position !== 0) {
      const previous = contract.readIdentity(document, { locationHref: location.href });
      const selector = position > 0 ? ".flip-prev" : ".flip-next";
      const offset = position > 0 ? -1 : 1;
      const transition = await clickAndWaitForChartChange(selector, previous);
      if (!transition.moved) {
        throw crawlFailure("chart_history_restore_navigation_stalled");
      }
      position += offset;
    }
    const restored = await readStableVisibleEncounter(originalIdentity);
    if (!proof.sameIdentity(originalIdentity, restored)) {
      throw crawlFailure("chart_history_restore_identity_mismatch");
    }
    return position;
  }

  async function clickAndWaitForChartChange(selector, previousIdentity, options = {}) {
    const control = document.querySelector(selector);
    if (!control || isExplicitlyHidden(control)) {
      throw crawlFailure("chart_history_control_unavailable");
    }
    const disabled = control.disabled || control.getAttribute("aria-disabled") === "true";
    if (disabled && options.allowUnchangedBoundary) {
      return { identity: previousIdentity, moved: false };
    }
    if (disabled) {
      throw crawlFailure("chart_history_control_unavailable");
    }
    control.click();
    const deadline = Date.now() + CHART_NAVIGATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const identity = contract.readIdentity(document, { locationHref: location.href });
      if (identity.sourceRecordId && !proof.sameIdentity(previousIdentity, identity)) {
        return { identity, moved: true };
      }
      await delay(25);
    }
    if (options.allowUnchangedBoundary) {
      const identity = contract.readIdentity(document, { locationHref: location.href });
      if (proof.sameIdentity(previousIdentity, identity)) {
        return { identity, moved: false };
      }
    }
    throw crawlFailure("chart_history_navigation_stalled");
  }

  async function readStableVisibleEncounter(expectedIdentity) {
    const deadline = Date.now() + CHART_NAVIGATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const first = visibleEncounterEntry();
        if (first.sourceRecordId && proof.sameIdentity(expectedIdentity, first)) {
          await delay(CHART_STABILITY_MS);
          const second = visibleEncounterEntry();
          if (
            proof.sameIdentity(first, second)
            && JSON.stringify(first) === JSON.stringify(second)
          ) {
            return second;
          }
        }
      } catch {
        // The chart container can be between two renders; keep polling until the deadline.
      }
      await delay(25);
    }
    throw crawlFailure("chart_history_entry_unstable");
  }

  function visibleEncounterEntry() {
    if (typeof contract.readVisibleEncounterEntry === "function") {
      return contract.readVisibleEncounterEntry(document, { locationHref: location.href });
    }
    const snapshot = contract.extractContractSnapshot(document, { locationHref: location.href });
    return {
      patientId: snapshot.externalPatientId,
      sourceRecordId: snapshot.sourceRecordId,
      sourceRecordDisplayId: snapshot.sourceRecordDisplayId,
      serviceDate: snapshot.serviceDate,
      receptionTime: snapshot.receptionTime,
      encounterType: snapshot.encounterType,
      visitKind: snapshot.visitKind
    };
  }

  function validEncounterEntry(entry, expectedPatientId) {
    return entry?.patientId === expectedPatientId
      && documentHeaderMatchesPatient(document, expectedPatientId)
      && /^\d{4}-\d{2}-\d{2}$/u.test(String(entry.serviceDate || ""))
      && Boolean(entry.sourceRecordId)
      && ["home_visit", "house_call", "outpatient"].includes(entry.encounterType)
      && [null, "telephone_revisit"].includes(entry.visitKind ?? null);
  }

  function encounterHistoryRow(entry) {
    return {
      serviceDate: entry.serviceDate,
      encounterType: entry.encounterType,
      visitKind: entry.visitKind ?? null,
      status: "completed",
      sourceRecordId: entry.sourceRecordId
    };
  }

  function normalizeEncounterEntryDate(entry, calendarMonth, direction) {
    const target = String(calendarMonth || "").match(/^(\d{4})-(\d{2})$/u);
    const visible = String(entry?.serviceDate || "").match(/^\d{4}-(\d{2})-(\d{2})$/u);
    if (!target || !visible) {
      return entry;
    }
    const targetYear = Number(target[1]);
    const targetMonth = Number(target[2]);
    const visibleMonth = Number(visible[1]);
    let year = targetYear;
    if (direction === "newer" && visibleMonth < targetMonth) {
      year += 1;
    } else if (direction === "older" && visibleMonth > targetMonth) {
      year -= 1;
    }
    const serviceDate = `${year}-${visible[1]}-${visible[2]}`;
    const parsed = new Date(`${serviceDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== serviceDate) {
      return { ...entry, serviceDate: "", sourceRecordId: "" };
    }
    const sourceRecordId = contract.buildSourceRecordKey({
      sourceSystem: contract.SOURCE_SYSTEM,
      patientId: entry.patientId,
      serviceDate,
      sourceRecordDisplayId: entry.sourceRecordDisplayId,
      receptionTime: entry.receptionTime
    });
    return { ...entry, serviceDate, sourceRecordId };
  }

  function uniqueSortedDates(values) {
    const dates = Array.isArray(values)
      ? values.filter((value) => /^\d{4}-\d{2}-\d{2}$/u.test(String(value || "")))
      : [];
    return [...new Set(dates)].sort();
  }

  function sameStringSet(left, right) {
    return left.size === right.size && [...left].every((value) => right.has(value));
  }

  function crawlFailure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  async function withChartMonitoringSuppressed(operation) {
    if (chartMonitoringSuppressionDepth === 0) {
      clearTimeout(chartChangeTimer);
      chartStateNotificationPending = false;
    }
    chartMonitoringSuppressionDepth += 1;
    try {
      return await operation();
    } finally {
      chartMonitoringSuppressionDepth -= 1;
      if (chartMonitoringSuppressionDepth === 0 && chartStateNotificationPending) {
        chartStateNotificationPending = false;
        scheduleChartStateNotification();
      }
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})(globalThis);
