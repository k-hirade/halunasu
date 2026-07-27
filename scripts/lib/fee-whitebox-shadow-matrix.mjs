import crypto from "node:crypto";
import {
  canonicalRangeForRawRange,
  canonicalizeClinicalText,
  normalizeClinicalTextValue
} from "../../services/fee-api/src/clinical-text-normalization.js";

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

export function selectWhiteboxDiagnosticSample(selectedCases = [], policy = {}, {
  cellLimit
} = {}) {
  const limit = positiveInteger(cellLimit, "diagnosticCellLimit");
  const requiredCells = requiredWhiteboxCells(policy);
  if (limit > requiredCells.length) {
    throw new Error(
      `diagnosticCellLimit must be at most ${requiredCells.length}`
    );
  }
  const specialties = nonemptyUniqueStrings(
    policy.requiredSpecialties,
    "requiredSpecialties"
  );
  const settings = nonemptyUniqueStrings(
    policy.requiredEncounterSettings,
    "requiredEncounterSettings"
  );
  const selectedByCell = new Map();
  for (const item of Array.isArray(selectedCases) ? selectedCases : []) {
    const cell = String(item?.measurementCell || "").trim();
    if (cell && !selectedByCell.has(cell)) {
      selectedByCell.set(cell, item);
    }
  }
  const sampled = [];
  const sampledCells = new Set();
  for (let round = 0; sampled.length < limit && round < settings.length; round += 1) {
    for (
      let specialtyIndex = 0;
      specialtyIndex < specialties.length && sampled.length < limit;
      specialtyIndex += 1
    ) {
      const setting = settings[(specialtyIndex + round) % settings.length];
      const cell = `${specialties[specialtyIndex]}|${setting}`;
      if (sampledCells.has(cell)) {
        continue;
      }
      const item = selectedByCell.get(cell);
      if (!item) {
        throw new Error(`diagnostic sample is missing selected case for ${cell}`);
      }
      sampledCells.add(cell);
      sampled.push(item);
    }
  }
  if (sampled.length !== limit) {
    throw new Error(
      `diagnostic sample selected ${sampled.length}/${limit} cells`
    );
  }
  return sampled;
}

export function selectWhiteboxPromotionCases(dataset = {}, policy = {}) {
  if (dataset.schemaVersion !== "fee-specialty-matrix-cases-v1") {
    throw new Error("whitebox promotion dataset must use fee-specialty-matrix-cases-v1");
  }
  const minimumRuns = positiveInteger(
    policy.telemetry?.minimumRunsPerCell,
    "telemetry.minimumRunsPerCell"
  );
  const minimumLines = positiveInteger(
    policy.adjudication?.minimumReviewedLinesPerCell,
    "adjudication.minimumReviewedLinesPerCell"
  );
  const minimumSpans = positiveInteger(
    policy.adjudication?.minimumReviewedSpansPerCell,
    "adjudication.minimumReviewedSpansPerCell"
  );
  const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
  const selected = [];
  for (const cell of requiredWhiteboxCells(policy)) {
    const eligible = cases
      .filter((item) => (
        item?.specialty === cell.specialty
        && item?.encounterSetting === cell.encounterSetting
        && item?.split === "holdout"
        && item?.synthetic === true
        && item?.annotationStatus === "reviewed"
        && item?.holdoutProvenance?.source === "human_reviewed"
        && item?.reviewPolicy?.expectedSpansReviewed === true
        && String(item?.reviewPolicy?.reviewedBy || "").trim()
        && /^\d{4}-\d{2}-\d{2}$/u.test(
          String(item?.reviewPolicy?.reviewedAt || "")
        )
        && String(item?.clinicalText || "").trim()
      ))
      .sort(compareMatrixCases);
    const cellSelection = [];
    let lineCount = 0;
    let spanCount = 0;
    for (const item of eligible) {
      cellSelection.push(item);
      lineCount += clinicalLineCount(item.clinicalText);
      spanCount += Array.isArray(item.expectedSpans) ? item.expectedSpans.length : 0;
      if (
        cellSelection.length >= minimumRuns
        && lineCount >= minimumLines
        && spanCount >= minimumSpans
      ) {
        break;
      }
    }
    if (
      cellSelection.length < minimumRuns
      || lineCount < minimumLines
      || spanCount < minimumSpans
    ) {
      throw new Error(
        `${cell.cell} holdout coverage is insufficient: `
        + `runs=${cellSelection.length}/${minimumRuns}, `
        + `lines=${lineCount}/${minimumLines}, spans=${spanCount}/${minimumSpans}`
      );
    }
    selected.push(...cellSelection.map((item) => ({
      ...item,
      measurementCell: cell.cell
    })));
  }
  return selected;
}

export function buildWhiteboxShadowExecutions(selectedCases = [], {
  controlRepeats = 1
} = {}) {
  const repeats = positiveInteger(controlRepeats, "controlRepeats");
  if (repeats > 3) {
    throw new Error("controlRepeats must be between 1 and 3");
  }
  const controlsByCell = new Map();
  const executions = [];
  for (const item of Array.isArray(selectedCases) ? selectedCases : []) {
    const cell = String(item?.measurementCell || "").trim();
    const caseId = String(item?.caseId || "").trim();
    if (!cell || !caseId) {
      throw new Error("selected whitebox cases require measurementCell and caseId");
    }
    const isControl = repeats > 1 && !controlsByCell.has(cell);
    const controlGroupId = isControl ? `${cell}:${caseId}` : "";
    if (isControl) {
      controlsByCell.set(cell, controlGroupId);
    }
    executions.push({
      ...item,
      runKind: "measurement",
      runInstance: "measurement-1",
      ...(controlGroupId ? { controlGroupId, controlAttempt: 1 } : {})
    });
    for (let attempt = 2; isControl && attempt <= repeats; attempt += 1) {
      executions.push({
        ...item,
        runKind: "determinism_control",
        runInstance: `determinism-${attempt}`,
        controlGroupId,
        controlAttempt: attempt
      });
    }
  }
  return {
    executions,
    controlRepeats: repeats,
    controlGroupCount: controlsByCell.size,
    expectedCalculationCount: executions.length
  };
}

export function buildWhiteboxShadowSessionInput(item = {}, {
  facilityId = "",
  departmentId = "",
  runId = "",
  serviceDate = "2026-07-25",
  runInstance = ""
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
      externalPatientIds: [
        [runId, item.caseId, String(runInstance || "").trim()]
          .filter(Boolean)
          .join(":")
      ]
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
  const router = trace.find((entry) => entry?.stage === "whitebox_router") || {};
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
  const expectedSpanDiagnostics = buildExpectedSpanGateDiagnostics(
    item,
    router.gateDiagnostics
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
    expectedSpanDiagnostics,
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
      shadowComparisonObservedCount: 0,
      expectedSpanCount: 0,
      exactBoundaryMatchCount: 0,
      overlapMatchCount: 0,
      boundaryMismatchCount: 0,
      canonicalTextMatchCount: 0,
      expectedCurrentOwnSpanCount: 0,
      detectedCurrentOwnSpanCount: 0,
      expectedSemanticTop1Count: 0,
      expectedSemanticTop5Count: 0,
      expectedShadowTop1Count: 0,
      expectedShadowTop5Count: 0,
      strictJointEligibleCount: 0,
      shadowJointEligibleCount: 0,
      expectedBillableInclusionSpanCount: 0,
      strictBillableInclusionEligibleCount: 0,
      shadowBillableInclusionEligibleCount: 0,
      expectedStandingSpanCount: 0,
      strictStandingEligibleCount: 0,
      shadowStandingEligibleCount: 0,
      expectedSafeExclusionSpanCount: 0,
      strictSafeExclusionEligibleCount: 0,
      shadowSafeExclusionEligibleCount: 0,
      expectedAbstainSpanCount: 0,
      strictBlockerCounts: {},
      shadowBlockerCounts: {}
    };
    current.runCount += 1;
    current.reviewedLineCount += Number(audit.reviewedLineCount || 0);
    current.reviewedSpanCount += Number(audit.reviewedSpanCount || 0);
    current.encoderTruePositiveCodeCount += audit.encoderTruePositiveCodes?.length || 0;
    current.encoderFalsePositiveCodeCount += audit.encoderFalsePositiveCodes?.length || 0;
    current.encoderFalseNegativeCodeCount += audit.encoderFalseNegativeCodes?.length || 0;
    current.shadowComparisonObservedCount += audit.shadowComparisonObserved ? 1 : 0;
    for (const diagnostic of Array.isArray(audit.expectedSpanDiagnostics)
      ? audit.expectedSpanDiagnostics
      : []) {
      current.expectedSpanCount += 1;
      current.exactBoundaryMatchCount += diagnostic.exactBoundaryMatch ? 1 : 0;
      current.overlapMatchCount += diagnostic.overlapMatch ? 1 : 0;
      current.boundaryMismatchCount += (
        diagnostic.overlapMatch && !diagnostic.exactBoundaryMatch ? 1 : 0
      );
      current.canonicalTextMatchCount += diagnostic.canonicalTextMatch ? 1 : 0;
      if (diagnostic.expectedRole === "performed") {
        current.expectedBillableInclusionSpanCount += 1;
        current.strictBillableInclusionEligibleCount += (
          diagnostic.strictBillableInclusionEligible ? 1 : 0
        );
        current.shadowBillableInclusionEligibleCount += (
          diagnostic.shadowBillableInclusionEligible ? 1 : 0
        );
      } else if (diagnostic.expectedRole === "standing") {
        current.expectedStandingSpanCount += 1;
        current.strictStandingEligibleCount += diagnostic.strictStandingEligible ? 1 : 0;
        current.shadowStandingEligibleCount += diagnostic.shadowStandingEligible ? 1 : 0;
      } else if (diagnostic.expectedRole === "safe_exclusion") {
        current.expectedSafeExclusionSpanCount += 1;
        current.strictSafeExclusionEligibleCount += (
          diagnostic.strictSafeExclusionEligible ? 1 : 0
        );
        current.shadowSafeExclusionEligibleCount += (
          diagnostic.shadowSafeExclusionEligible ? 1 : 0
        );
      } else {
        current.expectedAbstainSpanCount += 1;
      }
      if (!diagnostic.currentOwnPerformed) {
        continue;
      }
      current.expectedCurrentOwnSpanCount += 1;
      current.detectedCurrentOwnSpanCount += diagnostic.runtimeSpanObserved ? 1 : 0;
      current.expectedSemanticTop1Count += diagnostic.expectedSemanticRank === 1 ? 1 : 0;
      current.expectedSemanticTop5Count += (
        Number(diagnostic.expectedSemanticRank || 0) >= 1
        && Number(diagnostic.expectedSemanticRank || 0) <= 5
      ) ? 1 : 0;
      current.expectedShadowTop1Count += diagnostic.expectedShadowRank === 1 ? 1 : 0;
      current.expectedShadowTop5Count += (
        Number(diagnostic.expectedShadowRank || 0) >= 1
        && Number(diagnostic.expectedShadowRank || 0) <= 5
      ) ? 1 : 0;
      current.strictJointEligibleCount += diagnostic.strictJointEligible ? 1 : 0;
      current.shadowJointEligibleCount += diagnostic.shadowJointEligible ? 1 : 0;
      addReasonCounts(
        current.strictBlockerCounts,
        diagnostic.strictBlockerReasonCodes
      );
      addReasonCounts(
        current.shadowBlockerCounts,
        diagnostic.shadowBlockerReasonCodes
      );
    }
    byCell[cell] = current;
  }
  return Object.fromEntries(Object.entries(byCell).sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

export function whiteboxDeterminismSnapshot(detail = {}) {
  const performance = calculationPerformance(detail);
  const whitebox = performance?.whiteboxExtraction || {};
  const calculation = detail?.feeSession?.calculationResult || {};
  const trace = Array.isArray(calculation?.clinicalExtraction?.trace)
    ? calculation.clinicalExtraction.trace
    : [];
  const router = trace.find((entry) => entry?.stage === "whitebox_router") || {};
  const comparison = trace.find(
    (entry) => entry?.stage === "whitebox_shadow_comparison"
  ) || {};
  return {
    extractorVersion: String(whitebox.extractorVersion || ""),
    degraded: whitebox.degraded === true,
    lineCount: Number(whitebox.lineCount || 0),
    spanCount: Number(whitebox.spanCount || 0),
    shadowEncoderLineIds: uniqueStrings(router.shadowEncoderLineIds),
    gateDiagnosticsSha256: sha256(JSON.stringify(router.gateDiagnostics || [])),
    gateFunnel: sortedGateFunnel(whitebox.gateFunnel),
    routeReasonCounts: sortedNumberMapping(whitebox.routeReasonCounts),
    contextUncertainAxisCounts: sortedNumberMapping(
      whitebox.contextClassifier?.uncertainAxisCounts
    ),
    encoderCodes: uniqueStrings([
      ...(comparison.matchedCodes || []),
      ...(comparison.encoderOnlyCodes || [])
    ])
  };
}

export function whiteboxDeterminismFingerprint(detail = {}) {
  return sha256(JSON.stringify(whiteboxDeterminismSnapshot(detail)));
}

export function summarizeWhiteboxDeterminism(runs = []) {
  const grouped = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const groupId = String(run?.controlGroupId || "").trim();
    if (!groupId) {
      continue;
    }
    const current = grouped.get(groupId) || {
      controlGroupId: groupId,
      caseId: String(run?.caseId || ""),
      measurementCell: String(run?.measurementCell || ""),
      fingerprints: []
    };
    current.fingerprints.push(String(run?.whiteboxFingerprint || ""));
    grouped.set(groupId, current);
  }
  const groups = [...grouped.values()]
    .map((group) => {
      const fingerprints = group.fingerprints.filter(Boolean);
      const uniqueFingerprints = uniqueStrings(fingerprints);
      return {
        controlGroupId: group.controlGroupId,
        caseId: group.caseId,
        measurementCell: group.measurementCell,
        observedRepeats: fingerprints.length,
        exactMatch: fingerprints.length > 1 && uniqueFingerprints.length === 1,
        uniqueFingerprintCount: uniqueFingerprints.length
      };
    })
    .sort((left, right) => left.controlGroupId.localeCompare(right.controlGroupId));
  const eligible = groups.filter((group) => group.observedRepeats > 1);
  const exact = eligible.filter((group) => group.exactMatch);
  return {
    groupCount: eligible.length,
    exactGroupCount: exact.length,
    exactMatchRate: eligible.length ? exact.length / eligible.length : null,
    minimumObservedRepeats: eligible.length
      ? Math.min(...eligible.map((group) => group.observedRepeats))
      : 0,
    groups
  };
}

export function assessWhiteboxEvaluationEligibility({
  status = "",
  purpose = "diagnostic",
  holdoutUsed = false,
  requiredCellCount = 0,
  observedCellCount = 0,
  expectedCalculationCount = 0,
  runCount = 0,
  degradedRunCount = 0,
  cloudRunRevisions = [],
  determinism = {}
} = {}) {
  const requiredCells = Number(requiredCellCount || 0);
  const observedCells = Number(observedCellCount || 0);
  const expectedCalculations = Number(expectedCalculationCount || 0);
  const observedRuns = Number(runCount || 0);
  const revisions = [...new Set(
    (Array.isArray(cloudRunRevisions) ? cloudRunRevisions : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )].sort();
  const checks = {
    completed: status === "complete"
      && expectedCalculations > 0
      && observedRuns === expectedCalculations,
    promotionPurpose: purpose === "promotion",
    holdoutUsed: holdoutUsed === true,
    completeMatrix: requiredCells > 0 && observedCells === requiredCells,
    noDegradedRuns: Number(degradedRunCount || 0) === 0,
    singleCloudRunRevision: revisions.length === 1,
    determinismCoverage: requiredCells > 0
      && Number(determinism?.groupCount || 0) === requiredCells
      && Number(determinism?.minimumObservedRepeats || 0) >= 2,
    deterministicOutputs: Number(determinism?.groupCount || 0) > 0
      && Number(determinism?.exactGroupCount || 0)
        === Number(determinism?.groupCount || 0)
  };
  const reasonByCheck = {
    completed: "run_incomplete",
    promotionPurpose: "diagnostic_measurement_only",
    holdoutUsed: "holdout_not_used",
    completeMatrix: "matrix_incomplete",
    noDegradedRuns: "degraded_run_observed",
    singleCloudRunRevision: "revision_not_fixed",
    determinismCoverage: "determinism_controls_incomplete",
    deterministicOutputs: "determinism_mismatch"
  };
  const ineligibleReasonCodes = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => reasonByCheck[key]);
  return {
    checks,
    ineligibleReasonCodes,
    promotionReviewEligible: ineligibleReasonCodes.length === 0,
    independentHumanAdjudicationRequired: true
  };
}

function buildExpectedSpanGateDiagnostics(item = {}, runtimeDiagnostics = []) {
  const expected = Array.isArray(item.expectedSpans) ? item.expectedSpans : [];
  const runtime = (Array.isArray(runtimeDiagnostics) ? runtimeDiagnostics : [])
    .map((diagnostic) => ({ diagnostic, used: false }));
  return expected.map((span) => {
    const location = expectedSpanLocation(item.clinicalText, span);
    const spanTextSha256 = sha256(location.canonicalText);
    const rawSpanTextSha256 = sha256(String(span?.text || ""));
    const match = matchExpectedRuntimeSpan({
      runtime,
      location,
      category: String(span?.category || ""),
      spanTextSha256
    });
    const matched = match.entry;
    if (matched) {
      matched.used = true;
    }
    const diagnostic = matched?.diagnostic || null;
    const expectedCode = String(span?.code || "").trim();
    const semanticRank = candidateCodeRank(
      diagnostic?.semanticCandidates,
      expectedCode
    );
    const shadowRank = candidateCodeRank(
      diagnostic?.shadowCandidates,
      expectedCode
    );
    const strictBlockers = diagnostic
      ? [...(diagnostic.strict?.blockerReasonCodes || [])]
      : ["span_not_detected"];
    const shadowBlockers = diagnostic
      ? [...(diagnostic.shadow?.blockerReasonCodes || [])]
      : ["span_not_detected"];
    if (diagnostic && semanticRank !== 1) {
      strictBlockers.push(
        semanticRank === null
          ? "linker_expected_code_not_in_top5"
          : "linker_expected_code_not_top1"
      );
    }
    if (diagnostic && shadowRank !== 1) {
      shadowBlockers.push(
        shadowRank === null
          ? "linker_expected_code_not_in_top5"
          : "linker_expected_code_not_top1"
      );
    }
    const expectedRole = expectedLaneRole(span);
    const strictExpectedCodeTop1 = diagnostic && semanticRank === 1;
    const shadowExpectedCodeTop1 = diagnostic && shadowRank === 1;
    return {
      expectedCode,
      category: String(span?.category || ""),
      expectedRole,
      currentOwnPerformed: Boolean(isCurrentOwnPerformedSpan(span)),
      expectedLineIndex: location.lineIndex,
      expectedCharStart: location.charStart,
      expectedCharEnd: location.charEnd,
      spanTextSha256,
      rawSpanTextSha256,
      canonicalText: location.canonicalText,
      runtimeSpanObserved: Boolean(diagnostic),
      runtimeSpanId: String(diagnostic?.spanId || ""),
      matchType: match.matchType,
      intervalIou: match.intervalIou,
      exactBoundaryMatch: match.matchType === "exact",
      overlapMatch: match.intervalIou > 0,
      canonicalTextMatch: Boolean(
        diagnostic
        && String(diagnostic?.spanTextSha256 || "") === spanTextSha256
      ),
      expectedSemanticRank: semanticRank,
      expectedShadowRank: shadowRank,
      strictJointEligible: diagnostic?.strict?.jointEligible === true
        && strictExpectedCodeTop1,
      shadowJointEligible: diagnostic?.shadow?.jointEligible === true
        && shadowExpectedCodeTop1,
      strictBillableInclusionEligible: laneEligibility(
        diagnostic?.strict,
        "billableInclusionEligible",
        expectedRole
      ) && strictExpectedCodeTop1,
      shadowBillableInclusionEligible: laneEligibility(
        diagnostic?.shadow,
        "billableInclusionEligible",
        expectedRole
      ) && shadowExpectedCodeTop1,
      strictStandingEligible: laneEligibility(
        diagnostic?.strict,
        "standingEligible",
        expectedRole
      ) && strictExpectedCodeTop1,
      shadowStandingEligible: laneEligibility(
        diagnostic?.shadow,
        "standingEligible",
        expectedRole
      ) && shadowExpectedCodeTop1,
      strictSafeExclusionEligible: laneEligibility(
        diagnostic?.strict,
        "safeExclusionEligible",
        expectedRole
      ) && strictExpectedCodeTop1,
      shadowSafeExclusionEligible: laneEligibility(
        diagnostic?.shadow,
        "safeExclusionEligible",
        expectedRole
      ) && shadowExpectedCodeTop1,
      strictBlockerReasonCodes: uniqueStrings(strictBlockers),
      shadowBlockerReasonCodes: uniqueStrings(shadowBlockers)
    };
  });
}

function expectedSpanLocation(clinicalText = "", span = {}) {
  const canonicalized = canonicalizeClinicalText(clinicalText);
  const mappedRange = canonicalRangeForRawRange(
    canonicalized,
    span?.charStart,
    span?.charEnd
  );
  const fallbackText = normalizeClinicalTextValue(span?.text);
  const globalStart = mappedRange?.charStart ?? 0;
  const globalEnd = mappedRange?.charEnd ?? globalStart + fallbackText.length;
  const before = canonicalized.text.slice(0, globalStart);
  const lineStart = before.lastIndexOf("\n") + 1;
  return {
    lineIndex: before.split("\n").length,
    charStart: globalStart - lineStart,
    charEnd: globalEnd - lineStart,
    canonicalText: mappedRange
      ? canonicalized.text.slice(globalStart, globalEnd)
      : fallbackText
  };
}

function matchExpectedRuntimeSpan({
  runtime,
  location,
  category,
  spanTextSha256
}) {
  const candidates = runtime.filter((entry) => (
    !entry.used
    && String(entry.diagnostic?.category || "") === category
  ));
  const exact = candidates.find((entry) => (
    Number(entry.diagnostic?.lineIndex || 0) === location.lineIndex
    && Number(entry.diagnostic?.charStart ?? -1) === location.charStart
    && Number(entry.diagnostic?.charEnd ?? -1) === location.charEnd
    && String(entry.diagnostic?.spanTextSha256 || "") === spanTextSha256
  ));
  if (exact) {
    return { entry: exact, matchType: "exact", intervalIou: 1 };
  }
  const canonicalText = candidates.find((entry) => (
    Number(entry.diagnostic?.lineIndex || 0) === location.lineIndex
    && String(entry.diagnostic?.spanTextSha256 || "") === spanTextSha256
  ));
  if (canonicalText) {
    return {
      entry: canonicalText,
      matchType: "canonical_text",
      intervalIou: intervalIou(location, canonicalText.diagnostic)
    };
  }
  const overlap = candidates
    .filter((entry) => (
      Number(entry.diagnostic?.lineIndex || 0) === location.lineIndex
    ))
    .map((entry) => ({
      entry,
      intervalIou: intervalIou(location, entry.diagnostic)
    }))
    .filter((entry) => entry.intervalIou > 0)
    .sort((left, right) => right.intervalIou - left.intervalIou)[0];
  return overlap
    ? { ...overlap, matchType: "overlap" }
    : { entry: null, matchType: "none", intervalIou: 0 };
}

function intervalIou(left = {}, right = {}) {
  const leftStart = Number(left.charStart ?? -1);
  const leftEnd = Number(left.charEnd ?? -1);
  const rightStart = Number(right.charStart ?? -1);
  const rightEnd = Number(right.charEnd ?? -1);
  if (
    leftStart < 0
    || rightStart < 0
    || leftEnd <= leftStart
    || rightEnd <= rightStart
  ) {
    return 0;
  }
  const intersection = Math.max(
    0,
    Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart)
  );
  const union = Math.max(leftEnd, rightEnd) - Math.min(leftStart, rightStart);
  return union > 0 ? intersection / union : 0;
}

function laneEligibility(lane = {}, field, expectedRole) {
  if (typeof lane?.[field] === "boolean") {
    return lane[field];
  }
  const fallbackRole = {
    billableInclusionEligible: "performed",
    standingEligible: "standing",
    safeExclusionEligible: "safe_exclusion"
  }[field];
  return lane?.jointEligible === true && expectedRole === fallbackRole;
}

function expectedLaneRole(span = {}) {
  if (isCurrentOwnPerformedSpan(span)) {
    return "performed";
  }
  const action = String(span?.actionStatus || "");
  const temporal = String(span?.temporalRelation || "");
  const source = String(span?.sourceOrigin || "");
  const ownership = String(span?.providerOwnership || "");
  const standing = String(span?.standingStatus || "");
  if (
    temporal === "current_visit"
    && source === "own_clinic_record"
    && ownership === "own_clinic"
    && ["continued", "changed", "stopped"].includes(standing)
    && !["ordered", "planned", "considered"].includes(action)
  ) {
    return "standing";
  }
  if (
    action === "not_performed"
    || ["ordered", "planned", "considered"].includes(action)
    || temporal === "past"
    || EXCLUDED_SOURCE_ORIGINS.has(source)
    || EXCLUDED_PROVIDER_OWNERSHIPS.has(ownership)
  ) {
    return "safe_exclusion";
  }
  return "llm";
}

function candidateCodeRank(candidates = [], expectedCode = "") {
  const index = (Array.isArray(candidates) ? candidates : [])
    .findIndex((candidate) => String(candidate?.code || "") === expectedCode);
  return index >= 0 ? Number(candidates[index]?.rank || index + 1) : null;
}

function addReasonCounts(target, reasons = []) {
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    const key = String(reason || "").trim();
    if (key) {
      target[key] = Number(target[key] || 0) + 1;
    }
  }
}

function sortedGateFunnel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([lane, funnel]) => [
        lane,
        {
          ...funnel,
          rejectionCounts: sortedNumberMapping(funnel?.rejectionCounts)
        }
      ])
  );
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

function calculationPerformance(detail = {}) {
  const feeSession = detail?.feeSession || {};
  const metrics = feeSession.calculationProgress?.metrics || {};
  return metrics.performance || feeSession.calculationProgress?.performance || {};
}

function sortedNumberMapping(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [String(key), Number(count || 0)])
      .filter(([key, count]) => key && Number.isFinite(count))
      .sort(([left], [right]) => left.localeCompare(right))
  );
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
