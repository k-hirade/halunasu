import crypto from "node:crypto";

const AUXILIARY_SOURCE = "openai_auxiliary_recheck";
const UNSAFE_SAFETY_CLASSES = new Set(["past", "external", "negated", "planned"]);

export function buildCoverageRecheckSessionInput(item = {}, {
  facilityId = "",
  departmentId = "",
  runId = ""
} = {}) {
  const caseId = String(item.id || "").trim();
  const serviceDate = String(item.serviceDate || "").trim();
  const setting = String(item.setting || "").trim();
  if (!caseId || !serviceDate || !setting || !facilityId || !departmentId || !runId) {
    throw new Error(
      "case id, serviceDate, setting, facilityId, departmentId, and runId are required"
    );
  }
  const patient = item.patient && typeof item.patient === "object" ? item.patient : {};
  return {
    facilityId,
    departmentId,
    serviceDate,
    claimMonth: serviceDate.slice(0, 7),
    setting,
    clinicalText: String(item.clinicalText || ""),
    diagnoses: (Array.isArray(item.diagnoses) ? item.diagnoses : [])
      .map((name) => ({ name: String(name || "").trim() }))
      .filter((diagnosis) => diagnosis.name),
    patient: {
      displayName: `Coverage Recheck E2E ${caseId}`,
      birthDate: String(patient.birthDate || "").trim() || undefined,
      sex: String(patient.sex || "unknown").trim() || "unknown",
      externalPatientIds: [`${runId}:${caseId}`]
    },
    sourceSystem: `fee_extraction_coverage_recheck_stg:${runId}`
  };
}

export function auditCoverageRecheckCase(item = {}, detail = {}, {
  expectedRevision = ""
} = {}) {
  const feeSession = detail?.feeSession || {};
  const calculation = feeSession?.calculationResult || {};
  const performance = calculationPerformance(detail);
  const clinicalMetrics = feeSession?.calculationProgress?.metrics?.clinicalStructuring || {};
  const coverage = performance?.auxiliaryExtractionCoverage
    || clinicalMetrics?.auxiliaryCoverage
    || {};
  const clinicalEvents = arrayValue(calculation.clinicalEvents);
  const candidates = arrayValue(calculation.candidateProposals);
  const lineItems = arrayValue(calculation.lineItems);
  const auxiliaryEvents = clinicalEvents.filter(isAuxiliaryValue);
  const auxiliaryCandidates = candidates.filter(isAuxiliaryValue);
  const auxiliaryLineItems = lineItems.filter(isAuxiliaryValue);
  const directWhiteboxCandidates = candidates.filter(isDirectWhiteboxValue);
  const directWhiteboxLineItems = lineItems.filter(isDirectWhiteboxValue);
  const additionalOpenAiCallCount = finiteNumber(
    coverage.additionalOpenAiCallCount,
    0
  );
  const unsafeSafetyClass = UNSAFE_SAFETY_CLASSES.has(String(item.safetyClass || ""));
  const actualRevision = String(performance?.runtime?.cloudRunRevision || "").trim();
  const auxiliaryCandidatePolicyViolationCount = auxiliaryCandidates.filter(
    (candidate) => candidate?.candidateOnly !== true || candidate?.reviewRequired !== true
  ).length;
  const allowedConfirmedLineSources = new Set(
    uniqueStrings(item?.allowedConfirmedLineSources)
  );
  const unsafeConfirmedLineContractPresent = !unsafeSafetyClass
    || allowedConfirmedLineSources.size > 0;
  const unexpectedUnsafeConfirmedLineItems = unsafeSafetyClass
    ? lineItems.filter((line) => (
      !allowedConfirmedLineSources.has(extractionSource(line))
    ))
    : [];
  const confirmedCodes = new Set(lineItems
    .map(candidateCode)
    .filter(Boolean));
  const nonAuxiliaryCandidateCodes = new Set(candidates
    .filter((candidate) => !isAuxiliaryValue(candidate))
    .map(candidateCode)
    .filter(Boolean));
  const duplicateAuxiliaryCandidates = auxiliaryCandidates.filter((candidate) => {
    const code = candidateCode(candidate);
    return Boolean(code)
      && (confirmedCodes.has(code) || nonAuxiliaryCandidateCodes.has(code));
  });
  const netNewAuxiliaryCandidates = auxiliaryCandidates.filter((candidate) => (
    !duplicateAuxiliaryCandidates.includes(candidate)
  ));
  const checks = {
    cloudRunRevisionMatches: Boolean(actualRevision)
      && (!expectedRevision || actualRevision === expectedRevision),
    additionalOpenAiCallLimit: additionalOpenAiCallCount <= 1,
    noDirectWhiteboxCandidates: directWhiteboxCandidates.length === 0,
    noDirectWhiteboxLineItems: directWhiteboxLineItems.length === 0,
    noAuxiliaryConfirmedLines: auxiliaryLineItems.length === 0,
    auxiliaryCandidatesRequireReview: auxiliaryCandidatePolicyViolationCount === 0,
    noDuplicateAuxiliaryCandidates: duplicateAuxiliaryCandidates.length === 0,
    unsafeConfirmedLineContractPresent,
    noUnexpectedUnsafeConfirmedLines: unexpectedUnsafeConfirmedLineItems.length === 0,
    unsafeContextNotPromoted: !unsafeSafetyClass
      || (
        auxiliaryCandidates.length === 0
        && auxiliaryLineItems.length === 0
        && unexpectedUnsafeConfirmedLineItems.length === 0
      )
  };

  return {
    caseId: String(item.id || ""),
    safetyClass: String(item.safetyClass || ""),
    serviceDate: String(item.serviceDate || ""),
    setting: String(item.setting || ""),
    clinicalTextSha256: sha256(String(item.clinicalText || "")),
    clinicalLineCount: clinicalLineCount(item.clinicalText),
    cloudRunRevision: actualRevision,
    feeSessionId: String(feeSession.feeSessionId || ""),
    status: String(feeSession.status || ""),
    totalPoints: finiteNumber(calculation.totalPoints, 0),
    calculatePerformance: {
      totalDurationMs: nullableNumber(performance.totalDurationMs),
      openAiProviderMs: nullableNumber(performance?.durations?.openAiProviderMs),
      openAiUsage: safeOpenAiUsage(performance.openAiUsage)
    },
    auxiliaryCoverage: {
      mode: nullableString(coverage.mode),
      detectorAvailable: coverage.detectorAvailable === true,
      detectorDurationMs: nullableNumber(coverage.detectorDurationMs),
      detectorReason: nullableString(coverage.detectorReason),
      spanArtifactVersion: nullableString(coverage.spanArtifactVersion),
      detectedSpanCount: nullableNumber(coverage.detectedSpanCount),
      coveredSpanCount: nullableNumber(coverage.coveredSpanCount),
      gapSpanCount: nullableNumber(coverage.gapSpanCount),
      gapLineCount: nullableNumber(coverage.gapLineCount),
      recheckPlanned: coverage.recheckPlanned === true,
      recheckAttempted: coverage.recheckAttempted === true,
      recheckSucceeded: coverage.recheckSucceeded === true,
      recheckSuppressedReason: nullableString(coverage.recheckSuppressedReason),
      recoveredClinicalEventCount: nullableNumber(coverage.recoveredClinicalEventCount),
      unresolvedGapCount: nullableNumber(coverage.unresolvedGapCount),
      conflictCount: nullableNumber(coverage.conflictCount),
      additionalOpenAiCallCount,
      additionalOpenAiInputTokens: nullableNumber(coverage.additionalOpenAiInputTokens),
      additionalOpenAiOutputTokens: nullableNumber(coverage.additionalOpenAiOutputTokens),
      additionalOpenAiDurationMs: nullableNumber(coverage.additionalOpenAiDurationMs)
    },
    initialClinicalEvents: clinicalEvents
      .filter((event) => !isAuxiliaryValue(event))
      .map(safeClinicalEvent),
    auxiliaryClinicalEvents: auxiliaryEvents.map(safeClinicalEvent),
    lineItems: lineItems.map(safeLineItem),
    candidateProposals: candidates.map(safeCandidate),
    unsafeConfirmedLineAudit: {
      contractPresent: unsafeConfirmedLineContractPresent,
      allowedSources: [...allowedConfirmedLineSources].sort(),
      unexpectedLineItems: unexpectedUnsafeConfirmedLineItems.map(safeLineItem)
    },
    auxiliaryCandidateAudit: {
      duplicateCount: duplicateAuxiliaryCandidates.length,
      duplicateCodes: uniqueStrings(duplicateAuxiliaryCandidates.map(candidateCode)),
      netNewCount: netNewAuxiliaryCandidates.length,
      netNewCodes: uniqueStrings(netNewAuxiliaryCandidates.map(candidateCode))
    },
    checks,
    hardCheckPassed: Object.values(checks).every(Boolean)
  };
}

export function compareCoverageRecheckControl(activeRun = {}, controlRun = {}) {
  if (!controlRun || typeof controlRun !== "object") {
    return null;
  }
  const activeLines = stableLineFingerprints(activeRun.lineItems);
  const controlLines = stableLineFingerprints(controlRun.lineItems);
  const activeCandidates = stableCandidateFingerprints(activeRun.candidateProposals);
  const controlCandidates = stableCandidateFingerprints(controlRun.candidateProposals);
  const unsafeSafetyClass = UNSAFE_SAFETY_CLASSES.has(
    String(activeRun.safetyClass || "")
  );
  const recoveryObserved = Number(
    activeRun?.auxiliaryCoverage?.recoveredClinicalEventCount || 0
  ) > 0;
  const candidatesEqual = arraysEqual(activeCandidates, controlCandidates);
  return {
    controlFound: true,
    totalPointsEqual: Number(activeRun.totalPoints || 0) === Number(controlRun.totalPoints || 0),
    confirmedLinesEqual: arraysEqual(activeLines, controlLines),
    candidatesEqual,
    candidateComparisonPassed: unsafeSafetyClass
      ? candidatesEqual
      : (recoveryObserved || candidatesEqual),
    unsafeCandidateSetEqual: !unsafeSafetyClass
      || candidatesEqual
  };
}

export function summarizeCoverageRecheckResult(result = {}) {
  const runs = arrayValue(result.runs);
  const comparisons = runs
    .map((run) => run.controlComparison)
    .filter((comparison) => comparison?.controlFound);
  const revisions = uniqueStrings(runs.map((run) => run.cloudRunRevision));
  const recoveredRunCount = runs.filter(
    (run) => Number(run?.auxiliaryCoverage?.recoveredClinicalEventCount || 0) > 0
  ).length;
  const recheckAttemptedRunCount = runs.filter(
    (run) => run?.auxiliaryCoverage?.recheckAttempted === true
  ).length;
  const hardCheckPassed = runs.length > 0 && runs.every((run) => run.hardCheckPassed);
  const controlComparisonPassed = comparisons.length === 0
    ? null
    : comparisons.every((comparison) => (
      comparison.totalPointsEqual
      && comparison.confirmedLinesEqual
      && comparison.candidateComparisonPassed
      && comparison.unsafeCandidateSetEqual
    ));
  const controlComparisonComplete = result?.methodology?.controlComparisonRequested === true
    && comparisons.length === runs.length;
  const netNewAuxiliaryCandidateCount = sum(
    runs.map((run) => run?.auxiliaryCandidateAudit?.netNewCount)
  );
  const duplicateAuxiliaryCandidateCount = sum(
    runs.map((run) => run?.auxiliaryCandidateAudit?.duplicateCount)
  );
  return {
    status: String(result.status || ""),
    runCount: runs.length,
    hardCheckPassed,
    allAcceptanceChecksPassed: hardCheckPassed
      && recoveredRunCount > 0
      && controlComparisonComplete
      && controlComparisonPassed === true,
    coverageRecoveryObserved: recoveredRunCount > 0,
    recoveredRunCount,
    recheckAttemptedRunCount,
    recheckSucceededRunCount: runs.filter(
      (run) => run?.auxiliaryCoverage?.recheckSucceeded === true
    ).length,
    maximumAdditionalOpenAiCallCount: maximum(
      runs.map((run) => run?.auxiliaryCoverage?.additionalOpenAiCallCount)
    ),
    auxiliaryCandidateCount: sum(
      runs.map((run) => arrayValue(run?.candidateProposals).filter(isAuxiliaryValue).length)
    ),
    netNewAuxiliaryCandidateCount,
    duplicateAuxiliaryCandidateCount,
    auxiliaryConfirmedLineCount: sum(
      runs.map((run) => arrayValue(run?.lineItems).filter(isAuxiliaryValue).length)
    ),
    unsafePromotionViolationCount: runs.filter(
      (run) => run?.checks?.unsafeContextNotPromoted === false
    ).length,
    directWhiteboxCandidateCount: sum(
      runs.map((run) => arrayValue(run?.candidateProposals).filter(isDirectWhiteboxValue).length)
    ),
    uniqueCloudRunRevisions: revisions,
    singleCloudRunRevision: revisions.length === 1,
    controlComparisonRunCount: comparisons.length,
    controlComparisonComplete,
    controlComparisonPassed
  };
}

export function safeControlRuns(result = {}) {
  if (!result || typeof result !== "object") {
    return new Map();
  }
  return new Map(
    arrayValue(result.runs)
      .map((run) => [String(run?.caseId || ""), run])
      .filter(([caseId]) => caseId)
  );
}

function calculationPerformance(detail = {}) {
  const feeSession = detail?.feeSession || {};
  const metrics = feeSession?.calculationProgress?.metrics || {};
  return metrics.performance || feeSession?.calculationProgress?.performance || {};
}

function safeClinicalEvent(event = {}) {
  const source = extractionSource(event);
  return {
    eventFingerprint: sha256(JSON.stringify({
      name: String(event?.name || event?.clinicalName || ""),
      type: String(event?.type || event?.eventType || ""),
      actionStatus: String(event?.actionStatus || event?.action_status || ""),
      temporalRelation: String(event?.temporalRelation || event?.temporal_relation || ""),
      providerOwnership: String(event?.providerOwnership || event?.provider_ownership || ""),
      sourceOrigin: String(event?.sourceOrigin || event?.source_origin || ""),
      source
    })),
    type: nullableString(event?.type || event?.eventType),
    actionStatus: nullableString(event?.actionStatus || event?.action_status),
    temporalRelation: nullableString(event?.temporalRelation || event?.temporal_relation),
    providerOwnership: nullableString(event?.providerOwnership || event?.provider_ownership),
    sourceOrigin: nullableString(event?.sourceOrigin || event?.source_origin),
    source: nullableString(source)
  };
}

function safeCandidate(candidate = {}) {
  return {
    code: nullableString(candidate.code || candidate.standardCode),
    name: nullableString(candidate.name || candidate.standardName),
    potentialPoints: nullableNumber(
      candidate.potentialPoints ?? candidate.points ?? candidate.score
    ),
    basis: nullableString(candidate.basis),
    source: nullableString(extractionSource(candidate)),
    candidateOnly: candidate.candidateOnly === true,
    reviewRequired: candidate.reviewRequired === true
  };
}

function safeLineItem(line = {}) {
  return {
    code: nullableString(line.code || line.standardCode),
    name: nullableString(line.name || line.standardName),
    points: nullableNumber(line.points),
    quantity: nullableNumber(line.quantity),
    basis: nullableString(line.basis),
    source: nullableString(extractionSource(line)),
    candidateOnly: line.candidateOnly === true,
    reviewRequired: line.reviewRequired === true
  };
}

function safeOpenAiUsage(usage = {}) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    inputTokens: nullableNumber(usage.inputTokens),
    outputTokens: nullableNumber(usage.outputTokens),
    totalTokens: nullableNumber(usage.totalTokens),
    cachedInputTokens: nullableNumber(usage.cachedInputTokens)
  };
}

function extractionSource(value = {}) {
  return String(
    value?.source
    || value?.extractionSource
    || value?.extraction_source
    || value?.extraction?.source
    || value?.provenance?.source
    || value?.sourceFact?.extraction?.source
    || ""
  ).trim();
}

function isAuxiliaryValue(value = {}) {
  return extractionSource(value) === AUXILIARY_SOURCE;
}

function isDirectWhiteboxValue(value = {}) {
  const source = extractionSource(value).toLowerCase();
  const basis = String(value?.basis || "").trim().toLowerCase();
  return source === "encoder"
    || source.startsWith("whitebox")
    || basis.startsWith("whitebox")
    || basis.startsWith("encoder");
}

function candidateCode(value = {}) {
  return String(
    value?.code
    || value?.standardCode
    || value?.candidateLine?.code
    || ""
  ).trim();
}

function stableLineFingerprints(lines = []) {
  return arrayValue(lines)
    .map((line) => [
      String(line?.code || ""),
      Number(line?.points || 0),
      Number(line?.quantity || 0)
    ].join("|"))
    .sort();
}

function stableCandidateFingerprints(candidates = []) {
  return arrayValue(candidates)
    .map((candidate) => [
      String(candidate?.code || ""),
      Number(candidate?.potentialPoints || 0),
      String(candidate?.basis || ""),
      String(candidate?.source || "")
    ].join("|"))
    .sort();
}

function clinicalLineCount(value) {
  return String(value || "").split(/\r?\n/u).filter((line) => line.trim()).length;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(arrayValue(values).map((value) => String(value || "")).filter(Boolean))]
    .sort();
}

function arraysEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nullableString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function nullableNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maximum(values) {
  const numbers = arrayValue(values).map(Number).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : 0;
}

function sum(values) {
  return arrayValue(values).map(Number).filter(Number.isFinite)
    .reduce((total, value) => total + value, 0);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}
