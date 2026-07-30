(function registerSidecarContract(global) {
  "use strict";

  const VERSION = "homis-mock-v4";
  const LEGACY_VERSION = "homis-mock-v3";
  const SUPPORTED_VERSIONS = Object.freeze([VERSION, LEGACY_VERSION]);
  const REQUIRED_ELEMENT_COUNT = 5;
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
    const patientId = new URL(href).searchParams.get("patient_id") || "";
    const container = documentRef.querySelector("#pdetail_karte");
    return {
      patientId,
      sourceRecordId: container?.getAttribute("data-record-id")?.trim() || ""
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
    const calendarTitle = text(documentRef.querySelector(".cal-title"));
    const serviceDate = parseServiceDate(dateLabel, calendarTitle);
    const soapNodes = container
      ? [...container.querySelectorAll(".note-soap p")]
        .filter((node) => !node.classList.contains("karte-date") && text(node))
      : [];
    const checks = [
      Boolean(identity.patientId),
      Boolean(container),
      Boolean(identity.sourceRecordId),
      Boolean(dateElement && serviceDate),
      soapNodes.length >= 1
    ];
    const matchedRequiredElementCount = checks.filter(Boolean).length;
    if (matchedRequiredElementCount !== REQUIRED_ELEMENT_COUNT) {
      const error = new Error("画面の形式が想定と異なります");
      error.code = "selector_contract_mismatch";
      error.contractVersion = selectorContractVersion;
      error.requiredElementCount = REQUIRED_ELEMENT_COUNT;
      error.matchedRequiredElementCount = matchedRequiredElementCount;
      throw error;
    }

    const metaText = [...container.querySelectorAll(".karte-meta .kv")]
      .map(text)
      .join(" ");
    const residence = readResidenceDetails(documentRef, container, metaText);
    const encounter = readEncounterType(container);
    const snapshot = {
      externalPatientId: identity.patientId,
      sourceRecordId: identity.sourceRecordId,
      sourceRecordDisplayId: (metaText.match(/カルテID：\s*([^\s]+)/) || [])[1] || "",
      serviceDate,
      receptionTime: (dateLabel.match(/(\d{1,2}:\d{2})/) || [])[1] || "",
      clinicalText: soapNodes.map(text).join("\n"),
      ...encounter,
      ...residence,
      selectorContractVersion,
      requiredElementCount: REQUIRED_ELEMENT_COUNT,
      matchedRequiredElementCount,
      clinicalTextNodeCount: soapNodes.length
    };
    if (selectorContractVersion === VERSION) {
      snapshot.sourceSurfaces = {
        currentChart: readCurrentChartSurface(documentRef, container, identity.patientId)
      };
    }
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
    const attributeValue = container?.getAttribute("data-single-building-patient-count") || "";
    const visibleValue = (String(metaText || "").match(/単一建物[：:]\s*(\d+)/u) || [])[1] || "";
    const parsedCount = Number.parseInt(attributeValue || visibleValue, 10);
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

  function text(node) {
    return String(node?.textContent || "").trim();
  }

  global.HalunasuSidecarContract = Object.freeze({
    VERSION,
    LEGACY_VERSION,
    SUPPORTED_VERSIONS,
    REQUIRED_ELEMENT_COUNT,
    extractContractSnapshot,
    readCurrentChartSurface,
    readDocumentsSurface,
    readEncounterType,
    readResidenceDetails,
    readIdentity
  });
})(globalThis);
