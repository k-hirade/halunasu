(function registerSidecarContract(global) {
  "use strict";

  const VERSION = "homis-mock-v3";
  const REQUIRED_ELEMENT_COUNT = 5;

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
      error.contractVersion = VERSION;
      error.requiredElementCount = REQUIRED_ELEMENT_COUNT;
      error.matchedRequiredElementCount = matchedRequiredElementCount;
      throw error;
    }

    const metaText = [...container.querySelectorAll(".karte-meta .kv")]
      .map(text)
      .join(" ");
    const residence = readResidenceDetails(documentRef, container, metaText);
    return {
      externalPatientId: identity.patientId,
      sourceRecordId: identity.sourceRecordId,
      sourceRecordDisplayId: (metaText.match(/カルテID：\s*([^\s]+)/) || [])[1] || "",
      serviceDate,
      receptionTime: (dateLabel.match(/(\d{1,2}:\d{2})/) || [])[1] || "",
      clinicalText: soapNodes.map(text).join("\n"),
      ...residence,
      selectorContractVersion: VERSION,
      requiredElementCount: REQUIRED_ELEMENT_COUNT,
      matchedRequiredElementCount,
      clinicalTextNodeCount: soapNodes.length
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
    REQUIRED_ELEMENT_COUNT,
    extractContractSnapshot,
    readResidenceDetails,
    readIdentity
  });
})(globalThis);
