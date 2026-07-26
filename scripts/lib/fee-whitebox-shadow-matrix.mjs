import crypto from "node:crypto";

export const WHITEBOX_SPECIALTY_LABELS = Object.freeze({
  internal_medicine: "内科",
  pediatrics: "小児科",
  dermatology: "皮膚科",
  orthopedics: "整形外科",
  psychiatry: "精神科",
  ophthalmology: "眼科",
  otolaryngology: "耳鼻咽喉科",
  surgery: "外科"
});

const SUPPORTED_SETTINGS = new Set([
  "outpatient",
  "home_visit",
  "house_call",
  "telephone"
]);

const CURRENT_ACTION_STATUSES = new Set([
  "performed",
  "prescribed",
  "administered",
  "instruction_only"
]);

const EXCLUDED_SOURCE_ORIGINS = new Set([
  "patient_reported",
  "external_document",
  "carried_in_result",
  "other_provider_record"
]);

const EXCLUDED_PROVIDER_OWNERSHIPS = new Set([
  "same_institution_other_department",
  "other_provider"
]);

export function requiredWhiteboxCells(policy = {}) {
  const specialties = nonemptyUniqueStrings(
    policy.requiredSpecialties,
    "requiredSpecialties"
  );
  const settings = nonemptyUniqueStrings(
    policy.requiredEncounterSettings,
    "requiredEncounterSettings"
  );
  for (const specialty of specialties) {
    if (!WHITEBOX_SPECIALTY_LABELS[specialty]) {
      throw new Error(`unsupported whitebox specialty: ${specialty}`);
    }
  }
  for (const setting of settings) {
    if (!SUPPORTED_SETTINGS.has(setting)) {
      throw new Error(`unsupported whitebox encounter setting: ${setting}`);
    }
  }
  return specialties.flatMap((specialty) => (
    settings.map((encounterSetting) => ({
      specialty,
      encounterSetting,
      cell: `${specialty}|${encounterSetting}`
    }))
  ));
}

export function selectWhiteboxShadowCases(dataset = {}, policy = {}) {
  if (dataset.schemaVersion !== "fee-specialty-matrix-cases-v1") {
    throw new Error("whitebox shadow dataset must use fee-specialty-matrix-cases-v1");
  }
  const minimumRuns = positiveInteger(
    policy.telemetry?.minimumRunsPerCell,
    "telemetry.minimumRunsPerCell"
  );
  const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
  const selected = [];
  for (const cell of requiredWhiteboxCells(policy)) {
    const eligible = cases
      .filter((item) => (
        item?.specialty === cell.specialty
        && item?.encounterSetting === cell.encounterSetting
        && item?.split !== "holdout"
        && item?.synthetic === true
        && item?.annotationStatus === "reviewed"
        && String(item?.clinicalText || "").trim()
      ))
      .sort(compareMatrixCases);
    if (eligible.length < minimumRuns) {
      throw new Error(
        `${cell.cell} requires ${minimumRuns} reviewed non-holdout cases; found ${eligible.length}`
      );
    }
    selected.push(...eligible.slice(0, minimumRuns).map((item) => ({
      ...item,
      measurementCell: cell.cell
    })));
  }
  return selected;
}

export function buildWhiteboxShadowSessionInput(item = {}, {
  facilityId = "",
  departmentId = "",
  runId = "",
  serviceDate = "2026-07-25"
} = {}) {
  const specialty = String(item.specialty || "").trim();
  const encounterSetting = String(item.encounterSetting || "").trim();
  if (!WHITEBOX_SPECIALTY_LABELS[specialty]) {
    throw new Error(`unsupported specialty: ${specialty || "missing"}`);
  }
  if (!SUPPORTED_SETTINGS.has(encounterSetting)) {
    throw new Error(`unsupported encounter setting: ${encounterSetting || "missing"}`);
  }
  if (!facilityId || !departmentId || !runId) {
    throw new Error("facilityId, departmentId, and runId are required");
  }
  const telephone = encounterSetting === "telephone";
  return {
    facilityId,
    departmentId,
    serviceDate,
    claimMonth: serviceDate.slice(0, 7),
    setting: telephone ? "outpatient" : encounterSetting,
    ...(telephone ? {
      encounterDetails: {
        visitKind: "telephone_revisit",
        visitKindSource: "user"
      }
    } : {}),
    clinicalText: String(item.clinicalText),
    patient: {
      displayName: `Whitebox E2E ${item.caseId}`,
      sex: "unknown",
      externalPatientIds: [`${runId}:${item.caseId}`]
    },
    sourceSystem: `fee_whitebox_shadow_stg:${runId}`
  };
}

export function resolveWhiteboxDepartments(departments = [], {
  facilityId = "",
  specialties = Object.keys(WHITEBOX_SPECIALTY_LABELS)
} = {}) {
  const bySpecialty = {};
  const missing = [];
  for (const specialty of specialties) {
    const candidates = (Array.isArray(departments) ? departments : [])
      .filter((department) => (
        department?.status !== "inactive"
        && String(department?.specialty || "").trim() === specialty
        && (
          !facilityId
          || !department?.facilityId
          || department.facilityId === facilityId
        )
      ))
      .sort((left, right) => {
        const leftDedicated = String(left?.code || "").startsWith("WX") ? 0 : 1;
        const rightDedicated = String(right?.code || "").startsWith("WX") ? 0 : 1;
        return leftDedicated - rightDedicated
          || String(left?.departmentId || "").localeCompare(String(right?.departmentId || ""));
      });
    if (!candidates.length) {
      missing.push(specialty);
      continue;
    }
    bySpecialty[specialty] = candidates[0].departmentId;
  }
  return { bySpecialty, missing };
}

export function whiteboxDepartmentInput(specialty, facilityId) {
  const label = WHITEBOX_SPECIALTY_LABELS[specialty];
  if (!label) {
    throw new Error(`unsupported specialty: ${specialty}`);
  }
  return {
    facilityId,
    displayName: `WX Shadow ${label}`,
    code: `WX${String(Object.keys(WHITEBOX_SPECIALTY_LABELS).indexOf(specialty) + 1).padStart(2, "0")}`,
    specialty,
    status: "active"
  };
}

export function whiteboxShadowCaseAudit(item = {}, detail = {}) {
  const calculation = detail?.feeSession?.calculationResult || {};
  const trace = Array.isArray(calculation?.clinicalExtraction?.trace)
    ? calculation.clinicalExtraction.trace
    : [];
  const comparison = trace.find((entry) => entry?.stage === "whitebox_shadow_comparison") || {};
  const encoderCodes = uniqueStrings([
    ...(comparison.matchedCodes || []),
    ...(comparison.encoderOnlyCodes || [])
  ]);
  const llmCodes = uniqueStrings([
    ...(comparison.matchedCodes || []),
    ...(comparison.llmOnlyCodes || [])
  ]);
  const truthCodes = uniqueStrings(
    (Array.isArray(item.expectedSpans) ? item.expectedSpans : [])
      .filter(isCurrentOwnPerformedSpan)
      .map((span) => span.code)
  );
  return {
    caseId: item.caseId,
    specialty: item.specialty,
    encounterSetting: item.encounterSetting,
    clinicalTextSha256: sha256(String(item.clinicalText || "")),
    reviewedLineCount: clinicalLineCount(item.clinicalText),
    reviewedSpanCount: Array.isArray(item.expectedSpans) ? item.expectedSpans.length : 0,
    expectedCurrentOwnCodes: truthCodes,
    encoderCodes,
    llmCodes,
    encoderTruePositiveCodes: encoderCodes.filter((code) => truthCodes.includes(code)),
    encoderFalsePositiveCodes: encoderCodes.filter((code) => !truthCodes.includes(code)),
    encoderFalseNegativeCodes: truthCodes.filter((code) => !encoderCodes.includes(code)),
    shadowComparisonObserved: comparison.observed === true
      || encoderCodes.length > 0
      || llmCodes.length > 0,
    reviewStatus: "machine_precheck_only"
  };
}

export function summarizeWhiteboxCaseAudits(audits = []) {
  const byCell = {};
  for (const audit of Array.isArray(audits) ? audits : []) {
    const cell = `${audit.specialty}|${audit.encounterSetting}`;
    const current = byCell[cell] || {
      runCount: 0,
      reviewedLineCount: 0,
      reviewedSpanCount: 0,
      encoderTruePositiveCodeCount: 0,
      encoderFalsePositiveCodeCount: 0,
      encoderFalseNegativeCodeCount: 0,
      shadowComparisonObservedCount: 0
    };
    current.runCount += 1;
    current.reviewedLineCount += Number(audit.reviewedLineCount || 0);
    current.reviewedSpanCount += Number(audit.reviewedSpanCount || 0);
    current.encoderTruePositiveCodeCount += audit.encoderTruePositiveCodes?.length || 0;
    current.encoderFalsePositiveCodeCount += audit.encoderFalsePositiveCodes?.length || 0;
    current.encoderFalseNegativeCodeCount += audit.encoderFalseNegativeCodes?.length || 0;
    current.shadowComparisonObservedCount += audit.shadowComparisonObserved ? 1 : 0;
    byCell[cell] = current;
  }
  return Object.fromEntries(Object.entries(byCell).sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

function compareMatrixCases(left, right) {
  const splitRank = { development: 0, train: 1 };
  return (splitRank[left.split] ?? 9) - (splitRank[right.split] ?? 9)
    || String(left.caseId || "").localeCompare(String(right.caseId || ""));
}

function isCurrentOwnPerformedSpan(span = {}) {
  return CURRENT_ACTION_STATUSES.has(String(span.actionStatus || ""))
    && String(span.temporalRelation || "") === "current_visit"
    && !EXCLUDED_SOURCE_ORIGINS.has(String(span.sourceOrigin || ""))
    && !EXCLUDED_PROVIDER_OWNERSHIPS.has(String(span.providerOwnership || ""))
    && String(span.code || "").trim();
}

function clinicalLineCount(value) {
  return String(value || "").split(/\r?\n/u).filter((line) => line.trim()).length;
}

function nonemptyUniqueStrings(value, label) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const normalized = value.map((item) => String(item || "").trim());
  if (normalized.some((item) => !item) || new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must contain unique non-empty strings`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
