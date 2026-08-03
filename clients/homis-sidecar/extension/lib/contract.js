(function registerSidecarContract(global) {
  "use strict";

  const VERSION = "homis-mock-v6";
  const SUPPORTED_VERSIONS = Object.freeze([VERSION]);
  const SOURCE_SYSTEM = "homis";
  const RECORD_KEY_VERSION = "homis-visible-record-v1";
  const RECORD_KEY_SEPARATOR = "\u001f";
  const MAX_SOURCE_RECORD_ID_BYTES = 256;
  const REQUIRED_ELEMENT_COUNT = 7;
  const COMPLETE_CONDITION_MANAGEMENT_LIST_MARKER = "疾病等状態管理一覧:全件表示";
  const COMPLETE_PROBLEM_LIST_MARKER = "病名一覧:全件表示";
  const COMPLETE_ENCOUNTER_HISTORY_MARKER = "当月受診履歴:全件表示";
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
    const deviceElement = container?.querySelector(".device-text") || null;
    const conditionManagementListMarker = text(
      container?.querySelector(".condition-management-list-status")
    ).normalize("NFKC").replace(/\s+/gu, "");
    const calendarElement = documentRef.querySelector("#calendar3") || null;
    const calendarMonth = readCalendarMonth(documentRef);
    const calendarVisitNodes = calendarElement
      ? [...calendarElement.querySelectorAll("td.visit .cal-day[data-iso]")]
      : [];
    const calendarVisitDates = readCalendarVisitDates(documentRef);
    return {
      status: "ok",
      patientId,
      raw: {
        careInsuranceText: text(container?.querySelector(".kaigo-text")),
        visitingNurseText: text(container?.querySelector(".houkan-box")),
        deviceManagementText: text(deviceElement),
        deviceManagementListCompleteness: deviceElement
          && conditionManagementListMarker === COMPLETE_CONDITION_MANAGEMENT_LIST_MARKER
          ? "complete"
          : "unknown",
        prescriptionRows: readTextRows(container, ".shohou-wrap table tr"),
        patientStartDate: readPatientStartDate(documentRef),
        calendarMonth,
        calendarVisitDates,
        calendarVisitListCompleteness: calendarElement
          && calendarMonth
          && calendarVisitDates.length === calendarVisitNodes.length
          ? "complete"
          : "unknown"
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

  function readProblemsSurface(documentRef, options = {}) {
    const patientId = options.patientId || readIdentity(documentRef, options).patientId;
    const table = documentRef.querySelector(".problem-list");
    const rows = table
      ? [...table.querySelectorAll("tbody tr")]
        .map((row) => [...row.querySelectorAll("td")].map(text))
        .filter((cells) => cells.length >= 4)
        .map((cells) => {
          const displayedName = cells[1];
          return {
            name: displayedName.replace(/\s*[（(]主病[）)]\s*$/u, "").trim(),
            main: /[（(]主病[）)]\s*$/u.test(displayedName),
            startDate: cells[2],
            outcome: cells[3],
            suspected: /(?:疑い|疑診)/u.test(displayedName)
          };
        })
        .filter((row) => row.name)
      : [];
    return {
      status: "ok",
      patientId,
      raw: {
        rows,
        listCompleteness: table
          && hasExactCompletenessMarker(documentRef, ".problem-list-status", COMPLETE_PROBLEM_LIST_MARKER)
          && !hasAdditionalPages(documentRef)
          ? "complete"
          : "incomplete"
      }
    };
  }

  function readVisitPlanSurface(documentRef, options = {}) {
    const patientId = options.patientId || readIdentity(documentRef, options).patientId;
    const calendarMonth = String(options.calendarMonth || "").trim();
    const category = text(documentRef.querySelector(".plan-\u79d1"));
    const encounterType = encounterTypeFromPlanCategory(category);
    const historyTable = documentRef.querySelector(".encounter-history");
    const historyNodes = historyTable
      ? [...historyTable.querySelectorAll("tbody tr")]
      : [];
    const historyRows = historyNodes.map((node) => {
      const cells = [...node.querySelectorAll("td")].map(text);
      const type = encounterDetailsFromHistoryLabel(cells[1]);
      return {
        serviceDate: cells[0] || "",
        encounterType: type.encounterType,
        visitKind: type.visitKind,
        status: encounterStatusFromHistoryLabel(cells[2]),
        sourceRecordId: cells[3] || null
      };
    });
    const dateNodes = [...documentRef.querySelectorAll(".plan-dates .plan-chip")];
    const scheduledRows = dateNodes.map((node) => ({
      serviceDate: parsePlanDate(text(node), calendarMonth),
      encounterType,
      visitKind: null,
      status: "planned",
      sourceRecordId: null
    })).filter((row) => row.serviceDate && row.encounterType);
    const planElement = documentRef.querySelector(".plan-pattern");
    const historyComplete = Boolean(
      historyTable
      && hasExactCompletenessMarker(
        documentRef,
        ".encounter-history-status",
        COMPLETE_ENCOUNTER_HISTORY_MARKER
      )
      && !hasAdditionalPages(documentRef)
      && historyRows.length === historyNodes.length
      && historyRows.every(validEncounterHistoryRow)
    );
    const basis = historyTable
      ? "encounter_history"
      : dateNodes.length ? "schedule_only" : "unknown";
    return {
      status: "ok",
      patientId,
      raw: {
        calendarMonth: /^\d{4}-\d{2}$/u.test(calendarMonth) ? calendarMonth : "",
        category,
        patternText: text(planElement),
        basis,
        rows: historyTable ? historyRows.filter(validEncounterHistoryRow) : scheduledRows,
        listCompleteness: historyComplete ? "complete" : "incomplete"
      }
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

  function encounterTypeFromPlanCategory(value) {
    const normalized = String(value || "").replace(/\s+/gu, "");
    return /^(?:\u5728\u5b85\u8a3a\u7642|\u8a2a\u554f\u8a3a\u7642)$/u.test(normalized) ? "home_visit" : null;
  }

  function parsePlanDate(value, calendarMonth) {
    if (!/^\d{4}-\d{2}$/u.test(calendarMonth)) {
      return "";
    }
    const normalized = String(value || "").normalize("NFKC");
    const match = normalized.match(/(\d{1,2})\s*[\/]\s*(\d{1,2})/u);
    if (!match || Number(match[1]) !== Number(calendarMonth.slice(5, 7))) {
      return "";
    }
    const result = `${calendarMonth.slice(0, 4)}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
    const parsed = new Date(`${result}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === result
      ? result
      : "";
  }

  function validEncounterHistoryRow(row) {
    return /^\d{4}-\d{2}-\d{2}$/u.test(String(row?.serviceDate || ""))
      && ["home_visit", "house_call", "outpatient"].includes(row?.encounterType)
      && [null, "telephone_revisit"].includes(row?.visitKind)
      && row?.status === "completed"
      && Boolean(row?.sourceRecordId);
  }

  function encounterDetailsFromHistoryLabel(value) {
    const label = String(value || "").replace(/\s+/gu, "");
    if (["定期", "定期訪問", "訪問診療"].includes(label)) {
      return { encounterType: "home_visit", visitKind: null };
    }
    if (["往診", "臨時往診"].includes(label)) {
      return { encounterType: "house_call", visitKind: null };
    }
    if (["電話", "電話再診"].includes(label)) {
      return { encounterType: "outpatient", visitKind: "telephone_revisit" };
    }
    if (["外来", "外来診療"].includes(label)) {
      return { encounterType: "outpatient", visitKind: null };
    }
    return { encounterType: null, visitKind: null };
  }

  function encounterStatusFromHistoryLabel(value) {
    const label = String(value || "").replace(/\s+/gu, "");
    return ["完了", "実施済", "確定"].includes(label) ? "completed" : null;
  }

  function hasAdditionalPages(documentRef) {
    return [...documentRef.querySelectorAll(".pager a")].some((node) => {
      const label = [text(node), node.getAttribute("aria-label"), node.getAttribute("title")]
        .filter(Boolean)
        .join(" ")
        .normalize("NFKC")
        .replace(/\s+/gu, "");
      return Number(label) > 1 || /(?:次へ?|next|[>›»→])/iu.test(label);
    });
  }

  function hasExactCompletenessMarker(documentRef, selector, expected) {
    return text(documentRef.querySelector(selector))
      .normalize("NFKC")
      .replace(/\s+/gu, "") === expected;
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
    readProblemsSurface,
    readVisitPlanSurface,
    readEncounterType,
    readResidenceDetails,
    readIdentity
  });
})(globalThis);
