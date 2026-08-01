(function registerSidecarContract(global) {
  "use strict";

  const VERSION = "homis-mock-v5";
  const SUPPORTED_VERSIONS = Object.freeze([VERSION]);
  const SOURCE_SYSTEM = "homis";
  const RECORD_KEY_VERSION = "homis-visible-record-v1";
  const RECORD_KEY_SEPARATOR = "\u001f";
  const MAX_SOURCE_RECORD_ID_BYTES = 256;
  const REQUIRED_ELEMENT_COUNT = 7;
  const ENCOUNTER_TYPES = Object.freeze({
    "定期": "home_visit",
    "定期訪問": "home_visit",
    "訪問診療": "home_visit",
    "往診": "house_call",
    "臨時往診": "house_call",
    "外来": "outpatient",
    "外来診療": "outpatient",
    "電話": "outpatient",
    "電話再診": "outpatient"
  });
  const TELEPHONE_REVISIT_LABELS = new Set(["電話", "電話再診"]);

  function readIdentity(documentRef, options = {}) {
    const href = options.locationHref || global.location?.href || "";
    const patientId = readPatientId(href);
    const container = documentRef.querySelector("#pdetail_karte");
    const dateLabel = text(container?.querySelector(".note-soap .karte-date"));
    const calendarTitle = text(documentRef.querySelector(".cal-title"));
    const metaText = readChartMetaText(container);
    const sourceRecordDisplayId = readDisplayedChartId(metaText);
    const serviceDate = parseServiceDate(dateLabel, calendarTitle);
    const receptionTime = readReceptionTime(dateLabel);
    return {
      patientId,
      sourceRecordId: buildSourceRecordKey({
        sourceSystem: SOURCE_SYSTEM,
        patientId,
        serviceDate,
        sourceRecordDisplayId,
        receptionTime
      }),
      sourceRecordDisplayId,
      serviceDate,
      receptionTime
    };
  }

  function extractContractSnapshot(documentRef, options = {}) {
    const selectorContractVersion = options.selectorContractVersion || VERSION;
    if (!SUPPORTED_VERSIONS.includes(selectorContractVersion)) {
      const error = new Error("画面の読取契約バージョンが未対応です");
      error.code = "selector_contract_version_unsupported";
      error.contractVersion = selectorContractVersion;
      throw error;
    }
    const identity = readIdentity(documentRef, options);
    const container = documentRef.querySelector("#pdetail_karte");
    const dateElement = container?.querySelector(".note-soap .karte-date") || null;
    const dateLabel = text(dateElement);
    const soapNodes = container
      ? [...container.querySelectorAll(".note-soap p")]
        .filter((node) => !node.classList.contains("karte-date") && text(node))
      : [];
    const checks = [
      Boolean(identity.patientId),
      Boolean(container),
      Boolean(identity.sourceRecordDisplayId),
      Boolean(dateElement && identity.serviceDate),
      Boolean(identity.receptionTime),
      Boolean(identity.sourceRecordId),
      soapNodes.length >= 1
    ];
    const matchedRequiredElementCount = checks.filter(Boolean).length;
    if (matchedRequiredElementCount !== REQUIRED_ELEMENT_COUNT) {
      const error = new Error("画面の形式が想定と異なります");
      error.code = "selector_contract_mismatch";
      error.retryable = true;
      error.contractVersion = selectorContractVersion;
      error.requiredElementCount = REQUIRED_ELEMENT_COUNT;
      error.matchedRequiredElementCount = matchedRequiredElementCount;
      throw error;
    }

    const metaText = readChartMetaText(container);
    const residence = readResidenceDetails(documentRef, container, metaText);
    const encounter = readEncounterType(container);
    const snapshot = {
      externalPatientId: identity.patientId,
      sourceRecordId: identity.sourceRecordId,
      sourceRecordDisplayId: identity.sourceRecordDisplayId,
      serviceDate: identity.serviceDate,
      receptionTime: identity.receptionTime,
      clinicalText: soapNodes.map(text).join("\n"),
      ...encounter,
      ...residence,
      selectorContractVersion,
      requiredElementCount: REQUIRED_ELEMENT_COUNT,
      matchedRequiredElementCount,
      clinicalTextNodeCount: soapNodes.length
    };
    snapshot.sourceSurfaces = {
      currentChart: readCurrentChartSurface(documentRef, container, identity.patientId)
    };
    return snapshot;
  }

  function readCurrentChartSurface(documentRef, container, patientId) {
    return {
      status: "ok",
      patientId,
      raw: {
        careInsuranceText: text(container?.querySelector(".kaigo-text")),
        visitingNurseText: text(container?.querySelector(".houkan-box")),
        deviceManagementText: text(container?.querySelector(".device-text")),
        prescriptionRows: readTextRows(container, ".shohou-wrap table tr"),
        patientStartDate: readPatientStartDate(documentRef),
        calendarMonth: readCalendarMonth(documentRef),
        calendarVisitDates: readCalendarVisitDates(documentRef)
      }
    };
  }

  function readDocumentsSurface(documentRef, options = {}) {
    const patientId = options.patientId || readIdentity(documentRef, options).patientId;
    const rows = [...documentRef.querySelectorAll(".docs-table tbody tr")]
      .map((row) => [...row.querySelectorAll("td")].map(text))
      .filter((cells) => cells.length >= 5)
      .map((cells) => ({
        kind: cells[1],
        period: cells[2],
        writtenDate: cells[3],
        status: cells[4]
      }))
      .filter((row) => row.kind && row.kind !== "登録書類なし");
    return {
      status: "ok",
      patientId,
      raw: { rows }
    };
  }

  function readTextRows(root, selector) {
    return root
      ? [...root.querySelectorAll(selector)].map(text).filter(Boolean)
      : [];
  }

  function readCalendarMonth(documentRef) {
    const match = text(documentRef.querySelector("#calendar3 .cal-title, .cal-title"))
      .match(/(\d{4})年\s*(\d{1,2})月/u);
    return match ? `${match[1]}-${String(match[2]).padStart(2, "0")}` : "";
  }

  function readPatientStartDate(documentRef) {
    const match = text(documentRef.querySelector(".patient-header .ph-sub"))
      .match(/診療開始[：:]\s*(\d{4}-\d{2}-\d{2})/u);
    return match ? match[1] : "";
  }

  function readCalendarVisitDates(documentRef) {
    return [...documentRef.querySelectorAll("#calendar3 td.visit .cal-day[data-iso]")]
      .map((node) => String(node.getAttribute("data-iso") || "").trim())
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  }

  function readEncounterType(container) {
    const statusText = text(container?.querySelector(".karte-head .rec-status"));
    const statusLabel = statusText
      .replace(/^診療記録\s*/u, "")
      .split("「", 1)[0]
      .trim();
    const normalizedLabel = statusLabel.replace(/\s+/gu, "");
    const encounterType = ENCOUNTER_TYPES[normalizedLabel] || null;
    const visitKind = TELEPHONE_REVISIT_LABELS.has(normalizedLabel)
      ? "telephone_revisit"
      : null;
    return {
      encounterType,
      encounterTypeLabel: statusLabel || null,
      encounterTypeSource: encounterType ? "dom" : null,
      visitKind,
      visitKindSource: visitKind ? "dom" : null
    };
  }

  function readResidenceDetails(documentRef, container, metaText = "") {
    const facilityResidence = Boolean(documentRef.querySelector(".patient-header .badge.facility"));
    const privateResidence = Boolean(documentRef.querySelector(".patient-header .badge.home"));
    const visibleValue = (String(metaText || "").match(/単一建物[：:]\s*(\d+)/u) || [])[1] || "";
    const parsedCount = Number.parseInt(visibleValue, 10);
    const singleBuildingPatientCount = Number.isInteger(parsedCount) && parsedCount > 0
      ? parsedCount
      : null;
    const sameBuilding = singleBuildingPatientCount !== null
      ? singleBuildingPatientCount >= 2
      : privateResidence
        ? false
        : null;
    return {
      facilityResidence,
      privateResidence,
      singleBuildingPatientCount,
      sameBuilding,
      sameBuildingSource: sameBuilding === null ? null : "dom"
    };
  }

  function parseServiceDate(dateLabel, calendarTitle) {
    const monthDay = String(dateLabel || "").match(/(\d{1,2})\/(\d{1,2})/);
    const year = String(calendarTitle || "").match(/(\d{4})年/);
    if (!monthDay || !year) {
      return "";
    }
    const value = `${year[1]}-${String(monthDay[1]).padStart(2, "0")}-${String(monthDay[2]).padStart(2, "0")}`;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime())
      && date.getUTCFullYear() === Number(year[1])
      && date.getUTCMonth() + 1 === Number(monthDay[1])
      && date.getUTCDate() === Number(monthDay[2])
      ? value
      : "";
  }

  function readPatientId(href) {
    try {
      return normalizeRecordComponent(new URL(href).searchParams.get("patient_id"), 64);
    } catch {
      return "";
    }
  }

  function readChartMetaText(container) {
    return container
      ? [...container.querySelectorAll(".karte-meta .kv")].map(text).join(" ")
      : "";
  }

  function readDisplayedChartId(metaText) {
    return normalizeRecordComponent(
      (String(metaText || "").match(/カルテID[：:]\s*([^\s]+)/u) || [])[1],
      96
    );
  }

  function readReceptionTime(dateLabel) {
    const match = String(dateLabel || "").match(/(?:^|\s)(\d{1,2}):(\d{2})(?=\s|[~〜～]|$)/u);
    if (!match) {
      return "";
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
      ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      : "";
  }

  function buildSourceRecordKey(input = {}) {
    const values = [
      normalizeRecordComponent(RECORD_KEY_VERSION, 32),
      normalizeRecordComponent(input.sourceSystem || SOURCE_SYSTEM, 16),
      normalizeRecordComponent(input.patientId, 64),
      normalizeRecordComponent(input.serviceDate, 10),
      normalizeRecordComponent(input.sourceRecordDisplayId, 96),
      normalizeRecordComponent(input.receptionTime, 5)
    ];
    if (values.some((value) => !value)
      || !/^\d{4}-\d{2}-\d{2}$/.test(values[3])
      || !/^\d{2}:\d{2}$/.test(values[5])) {
      return "";
    }
    const key = values.join(RECORD_KEY_SEPARATOR);
    return new TextEncoder().encode(key).byteLength <= MAX_SOURCE_RECORD_ID_BYTES ? key : "";
  }

  function normalizeRecordComponent(value, maxLength) {
    const normalized = String(value || "").normalize("NFC").trim();
    return normalized
      && normalized.length <= maxLength
      && !/[\u0000-\u001f\u007f]/u.test(normalized)
      ? normalized
      : "";
  }

  function text(node) {
    return String(node?.textContent || "").trim();
  }

  global.HalunasuSidecarContract = Object.freeze({
    VERSION,
    SUPPORTED_VERSIONS,
    SOURCE_SYSTEM,
    RECORD_KEY_VERSION,
    RECORD_KEY_SEPARATOR,
    REQUIRED_ELEMENT_COUNT,
    buildSourceRecordKey,
    extractContractSnapshot,
    readCurrentChartSurface,
    readDocumentsSurface,
    readEncounterType,
    readResidenceDetails,
    readIdentity
  });
})(globalThis);
