const KNOWN_VISIT_FACTS_CANDIDATE_PATTERN = /(?:処方箋|処方料|調剤料|特定疾患処方管理加算|一般名処方|薬剤情報提供)/u;
const KNOWN_VISIT_FACTS_CANDIDATE_CODES = new Set([
  "120000710",
  "120001210",
  "120002910",
  "120005610",
  "120005710"
]);

export function captureFeeEvaluationSurface(detailBody = {}) {
  const feeSession = detailBody.feeSession || {};
  const calculation = feeSession.calculationResult || {};
  const workbench = detailBody.candidateWorkbench || {};
  const metrics = feeSession.calculationProgress?.metrics || {};
  const performance = metrics.performance || feeSession.calculationProgress?.performance || {};
  const clinical = metrics.clinicalStructuring || {};
  const extractionMemo = metrics.extractionMemo || performance.extractionMemo || {};
  const performanceClinical = performance.clinical || {};
  const emptyExtractionGuard = clinical.emptyExtractionGuard || performance.emptyExtractionGuard || {};
  const patientHistory = metrics.patientHistory || performance.patientHistory || {};
  const extraction = calculation.clinicalExtraction || {};
  const trace = Array.isArray(extraction.trace) ? extraction.trace : [];
  const extractionMemoTrace = trace.find((item) => item?.stage === "extraction_memo") || null;
  const usage = normalizeOpenAiUsage(clinical.usage || performance.openAiUsage);

  return {
    totalPoints: Number(calculation.totalPoints || 0),
    confirmedLines: normalizeConfirmedLines(workbench.includedLines || []),
    candidateItems: normalizeCandidateItems(workbench),
    reviewIssues: normalizeReviewIssues(workbench.issues || []),
    warnings: uniqueStrings(calculation.warnings || []).sort(),
    visitFacts: extraction.visitFacts || null,
    extraction: {
      source: extraction.source || clinical.source || null,
      mode: clinical.extractionMode || performanceClinical.extractionMode || null,
      promptVersion: extraction.promptVersion || clinical.promptVersion || null,
      clinicalEventCount: Number(extraction.clinicalEventCount || 0),
      emptyExtractionGuard: {
        enabled: emptyExtractionGuard.enabled === true,
        triggered: emptyExtractionGuard.triggered === true,
        reasonCodes: uniqueStrings(emptyExtractionGuard.reasonCodes),
        retryAttempted: emptyExtractionGuard.retryAttempted === true,
        recovered: emptyExtractionGuard.recovered === true,
        initialEventCount: finiteNumber(emptyExtractionGuard.initialEventCount, 0),
        finalEventCount: finiteNumber(emptyExtractionGuard.finalEventCount, 0)
      },
      memo: {
        enabled: extractionMemo.enabled === true,
        used: extractionMemo.used === true,
        reason: extractionMemo.reason || extractionMemoTrace?.reason || null,
        memoHitLineRatio: finiteNumber(extractionMemo.memoHitLineRatio ?? extractionMemoTrace?.memoHitLineRatio, 0),
        continuedLineCount: finiteNumber(extractionMemo.continuedLineCount ?? extractionMemoTrace?.continuedLineCount, 0),
        newLineCount: finiteNumber(extractionMemo.newLineCount ?? extractionMemoTrace?.newLineCount, 0),
        removedLineCount: finiteNumber(extractionMemo.removedLineCount ?? extractionMemoTrace?.removedLineCount, 0),
        visitFactsSource: extractionMemo.visitFactsSource || extractionMemoTrace?.visitFactsSource || null,
        traceRecorded: Boolean(extractionMemoTrace),
        trace: extractionMemoTrace ? normalizeMemoTrace(extractionMemoTrace) : null
      }
    },
    patientHistory: {
      completeness: patientHistory.completeness || null,
      priorSessionCount: finiteNumber(patientHistory.priorSessionCount, 0),
      externalHistoryEventCount: finiteNumber(patientHistory.externalHistoryEventCount, 0),
      patientHistoryReason: patientHistory.patientHistoryReason || null,
      extractionSnapshotReason: patientHistory.extractionSnapshotReason || null
    },
    openAi: {
      providerDurationMs: finiteNumber(clinical.openAiProviderDurationMs ?? performance.durations?.openAiProviderMs, 0),
      callCount: openAiCallCount(clinical, usage),
      callObserved: openAiCallObserved({ clinical, usage }),
      usage
    },
    runtime: {
      environment: performance.runtime?.environment || null,
      cloudRunService: performance.runtime?.cloudRunService || null,
      cloudRunRevision: performance.runtime?.cloudRunRevision || null
    }
  };
}

export function validateLongitudinalPreflight(body = {}, { skipMemoPreflight = false } = {}) {
  const environment = String(body?.env || "").trim().toLowerCase();
  const runtimeFeatures = body?.runtimeFeatures || {};
  const cloudRunRevision = String(body?.runtime?.cloudRunRevision || "").trim();
  if (environment !== "stg") {
    throw new Error(`fee-api readyz preflight expected env=stg but received ${environment || "unknown"}`);
  }
  if (!cloudRunRevision) {
    throw new Error("fee-api readyz preflight did not expose a Cloud Run revision");
  }
  if (!skipMemoPreflight && runtimeFeatures.extractionMemoEnabled !== true) {
    throw new Error("FEE_EXTRACTION_MEMO is disabled on the target revision; aborting before calculation requests");
  }
  if (runtimeFeatures.emptyExtractionRetryEnabled !== true) {
    throw new Error("FEE_EMPTY_EXTRACTION_RETRY is disabled on the target revision; aborting Phase 1 closeout measurement");
  }
  return {
    environment,
    cloudRunService: String(body?.runtime?.cloudRunService || "") || null,
    cloudRunRevision,
    runtimeFeatures: {
      extractionMemoEnabled: runtimeFeatures.extractionMemoEnabled === true,
      emptyExtractionRetryEnabled: runtimeFeatures.emptyExtractionRetryEnabled === true,
      extractionSnapshotRetentionDays: Number(runtimeFeatures.extractionSnapshotRetentionDays || 0)
    },
    memoCheckSkipped: skipMemoPreflight === true
  };
}

export function evaluateLongitudinalEquivalence({
  memoRuns = {},
  controls = [],
  allowKnownVisitFactsCandidateDifferences = false,
  allowMemoUnusedLlmVariability = false
} = {}) {
  if (!Array.isArray(controls) || controls.length < 2) {
    throw new Error("longitudinal equivalence requires at least two full-extraction controls");
  }
  const controlVariability = analyzeControlVariability(controls);
  const paths = Object.fromEntries(
    Object.entries(memoRuns).map(([name, run]) => [name, evaluateMemoPath({
      run,
      controls,
      controlVariability,
      allowKnownVisitFactsCandidateDifferences,
      allowMemoUnusedLlmVariability
    })])
  );
  const verdicts = Object.values(paths).map((item) => item.overallVerdict);
  const overallVerdict = verdicts.includes("fail")
    ? "fail"
    : verdicts.includes("inconclusive_llm_variability")
      ? "inconclusive_llm_variability"
      : verdicts.includes("inconclusive_control_variability")
        ? "inconclusive_control_variability"
        : verdicts.includes("pass_with_known_limit")
          ? "pass_with_known_limit"
          : "pass";
  return { overallVerdict, controlVariability, paths };
}

export function evaluateMemoAcceptance(run = {}, expected = {}) {
  const memo = run.extraction?.memo || {};
  const checks = {
    memoUsed: expected.memoUsed === undefined || memo.used === expected.memoUsed,
    memoHitLineRatio: expected.memoHitLineRatio === undefined
      || approximatelyEqual(memo.memoHitLineRatio, expected.memoHitLineRatio),
    continuedLineCount: expected.continuedLineCount === undefined
      || memo.continuedLineCount === expected.continuedLineCount,
    newLineCount: expected.newLineCount === undefined || memo.newLineCount === expected.newLineCount,
    removedLineCount: expected.removedLineCount === undefined || memo.removedLineCount === expected.removedLineCount,
    traceRecorded: expected.traceRecorded === undefined || memo.traceRecorded === expected.traceRecorded,
    noOpenAiCall: expected.noOpenAiCall !== true || run.openAi?.callObserved === false,
    historyAvailable: expected.historyAvailable !== true || run.patientHistory?.completeness !== "unavailable"
  };
  return { pass: Object.values(checks).every(Boolean), checks, observed: memo };
}

export function normalizeConfirmedLines(lines = []) {
  return (Array.isArray(lines) ? lines : [])
    .map((entry) => entry?.lineItem || entry)
    .map((line) => ({
      code: String(line?.code || "").trim(),
      name: normalizeText(line?.name),
      quantity: finiteNumber(line?.quantity, 1),
      totalPoints: finiteNumber(line?.totalPoints, 0)
    }))
    .filter((line) => line.code || line.name)
    .sort(compareNormalizedItems);
}

export function normalizeCandidateItems(workbench = {}) {
  const pendingLines = (Array.isArray(workbench.pendingLines) ? workbench.pendingLines : [])
    .map((entry) => entry?.lineItem || entry)
    .map((line) => ({
      kind: "pending_line",
      code: String(line?.code || "").trim(),
      codeCandidates: normalizeCodes(line?.codeCandidates),
      title: normalizeText(line?.name || line?.displayTitle),
      points: finiteNumber(line?.totalPoints ?? line?.points, 0)
    }));
  const proposals = (Array.isArray(workbench.proposals) ? workbench.proposals : []).map((proposal) => ({
    kind: "proposal",
    code: String(proposal?.code || proposal?.masterCode || proposal?.candidateLine?.code || "").trim(),
    codeCandidates: normalizeCodes(proposal?.codeCandidates || proposal?.candidateLine?.codeCandidates),
    title: normalizeText(proposal?.displayTitle || proposal?.title || proposal?.name || proposal?.candidateLine?.name),
    points: finiteNumber(proposal?.potentialPoints ?? proposal?.totalPoints ?? proposal?.points, 0)
  }));
  return [...pendingLines, ...proposals]
    .filter((item) => item.code || item.codeCandidates.length || item.title)
    .sort(compareNormalizedItems);
}

function normalizeReviewIssues(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      title: normalizeText(item?.displayTitle || item?.title || item?.name),
      reason: normalizeText(item?.displayReason || item?.reason || item?.message)
    }))
    .filter((item) => item.title || item.reason)
    .sort(compareNormalizedItems);
}

function analyzeControlVariability(controls) {
  const confirmedSignatures = controls.map((run) => stableStringify(run.confirmedLines || []));
  const candidateSignatures = controls.map((run) => stableStringify(run.candidateItems || []));
  const candidateDifferenceKeys = new Set();
  const candidatePairDifferences = [];
  for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
      const difference = setDifference(controls[leftIndex].candidateItems, controls[rightIndex].candidateItems);
      difference.items.forEach((item) => candidateDifferenceKeys.add(itemKey(item)));
      candidatePairDifferences.push({
        left: leftIndex + 1,
        right: rightIndex + 1,
        differenceCount: difference.items.length,
        items: difference.items
      });
    }
  }
  return {
    controlCount: controls.length,
    confirmedStable: new Set(confirmedSignatures).size === 1,
    candidateStable: new Set(candidateSignatures).size === 1,
    confirmedSignatureCount: new Set(confirmedSignatures).size,
    candidateSignatureCount: new Set(candidateSignatures).size,
    candidateDifferenceEnvelope: [...candidateDifferenceKeys].sort(),
    candidatePairDifferences
  };
}

function evaluateMemoPath({
  run,
  controls,
  controlVariability,
  allowKnownVisitFactsCandidateDifferences,
  allowMemoUnusedLlmVariability
}) {
  const confirmedDifferences = controls.map((control, index) => ({
    control: index + 1,
    ...setDifference(run?.confirmedLines, control.confirmedLines)
  }));
  const candidateDifferences = controls.map((control, index) => ({
    control: index + 1,
    ...setDifference(run?.candidateItems, control.candidateItems)
  }));
  const confirmedVerdict = !controlVariability.confirmedStable
    ? "inconclusive_control_variability"
    : confirmedDifferences.every((item) => item.items.length === 0)
      ? "pass"
      : "fail";
  const allCandidateDifferenceItems = uniqueItems(candidateDifferences.flatMap((item) => item.items));
  const candidateDifferenceKeys = allCandidateDifferenceItems.map(itemKey);
  const withinControlEnvelope = candidateDifferenceKeys.every((key) => (
    controlVariability.candidateDifferenceEnvelope.includes(key)
  ));
  const knownLimitOnly = allCandidateDifferenceItems.length > 0
    && allCandidateDifferenceItems.every(isKnownVisitFactsCandidateItem);
  let candidateVerdict = "pass";
  if (!controlVariability.candidateStable) {
    candidateVerdict = withinControlEnvelope
      ? "inconclusive_control_variability"
      : allowKnownVisitFactsCandidateDifferences && knownLimitOnly
        ? "pass_with_known_limit"
        : "fail";
  } else if (allCandidateDifferenceItems.length) {
    candidateVerdict = allowKnownVisitFactsCandidateDifferences && knownLimitOnly
      ? "pass_with_known_limit"
      : "fail";
  }
  let overallVerdict = [confirmedVerdict, candidateVerdict].includes("fail")
    ? "fail"
    : [confirmedVerdict, candidateVerdict].includes("inconclusive_control_variability")
      ? "inconclusive_control_variability"
      : [confirmedVerdict, candidateVerdict].includes("pass_with_known_limit")
        ? "pass_with_known_limit"
        : "pass";
  const controlClinicalEventCounts = controls.map((control) => Number(control?.extraction?.clinicalEventCount || 0));
  const stableControlClinicalEventCount = new Set(controlClinicalEventCounts).size === 1
    ? controlClinicalEventCounts[0]
    : null;
  const attributableToMemoUnusedLlmVariability = (
    overallVerdict === "fail"
    && allowMemoUnusedLlmVariability === true
    && run?.extraction?.memo?.used === false
    && run?.openAi?.callObserved === true
    && controlVariability.confirmedStable
    && controlVariability.candidateStable
    && stableControlClinicalEventCount !== null
    && Number(run?.extraction?.clinicalEventCount || 0) !== stableControlClinicalEventCount
  );
  if (attributableToMemoUnusedLlmVariability) {
    overallVerdict = "inconclusive_llm_variability";
  }
  return {
    overallVerdict,
    attribution: attributableToMemoUnusedLlmVariability
      ? "memo_unused_full_extraction_llm_variability"
      : null,
    confirmed: { verdict: confirmedVerdict, differences: confirmedDifferences },
    candidates: {
      verdict: candidateVerdict,
      knownVisitFactsLimitOnly: knownLimitOnly,
      withinControlVariabilityEnvelope: withinControlEnvelope,
      differences: candidateDifferences
    }
  };
}

function setDifference(left = [], right = []) {
  const leftMap = new Map((Array.isArray(left) ? left : []).map((item) => [itemKey(item), item]));
  const rightMap = new Map((Array.isArray(right) ? right : []).map((item) => [itemKey(item), item]));
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const items = keys.filter((key) => !leftMap.has(key) || !rightMap.has(key)).map((key) => ({
    key,
    side: leftMap.has(key) ? "memo_only" : "control_only",
    item: leftMap.get(key) || rightMap.get(key)
  }));
  return { differenceCount: items.length, items };
}

function isKnownVisitFactsCandidateItem(difference = {}) {
  const item = difference.item || difference;
  if (KNOWN_VISIT_FACTS_CANDIDATE_CODES.has(String(item?.code || "").trim())) return true;
  const text = [item?.title, item?.code, ...(item?.codeCandidates || [])].join(" ");
  return KNOWN_VISIT_FACTS_CANDIDATE_PATTERN.test(text);
}

function normalizeMemoTrace(trace = {}) {
  return {
    stage: trace.stage || null,
    outcome: trace.outcome || null,
    reason: trace.reason || null,
    memoHitLineRatio: finiteNumber(trace.memoHitLineRatio, 0),
    continuedLineCount: finiteNumber(trace.continuedLineCount, 0),
    newLineCount: finiteNumber(trace.newLineCount, 0),
    removedLineCount: finiteNumber(trace.removedLineCount, 0),
    visitFactsSource: trace.visitFactsSource || null
  };
}

function normalizeOpenAiUsage(usage = null) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: finiteNumber(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens, 0),
    outputTokens: finiteNumber(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens, 0),
    totalTokens: finiteNumber(usage.totalTokens ?? usage.total_tokens, 0),
    cachedInputTokens: finiteNumber(
      usage.cachedInputTokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens,
      0
    )
  };
}

function openAiCallObserved({ clinical = {}, usage = null } = {}) {
  return openAiCallCount(clinical, usage) > 0;
}

function openAiCallCount(clinical = {}, usage = null) {
  const explicitCount = Number(clinical.openAiCallCount);
  if (Number.isFinite(explicitCount) && explicitCount >= 0) return explicitCount;
  if (clinical.extractionSampleStats && typeof clinical.extractionSampleStats === "object") {
    return Math.max(0, Number(clinical.extractionSampleStats.requested || 0))
      + Math.max(0, Number(clinical.lineReviewRetryCount || 0));
  }
  if (Number(usage?.inputTokens || 0) > 0 || Number(usage?.outputTokens || 0) > 0) return 1;
  if (String(clinical.source || "") === "memo") return 0;
  if (Number(clinical.openAiProviderDurationMs || 0) > 0) return 1;
  return !["memo", "reuse_clinical", "manual", "no_clinical_text"].includes(String(clinical.source || ""))
    && String(clinical.source || "") === "openai"
    ? 1
    : 0;
}

function itemKey(item = {}) {
  return stableStringify(item?.item || item);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueItems(items = []) {
  return [...new Map(items.map((item) => [itemKey(item), item])).values()].sort((left, right) => (
    itemKey(left).localeCompare(itemKey(right))
  ));
}

function normalizeCodes(values) {
  return uniqueStrings(Array.isArray(values) ? values : []).sort();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function approximatelyEqual(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 1e-9;
}

function compareNormalizedItems(left, right) {
  return itemKey(left).localeCompare(itemKey(right));
}
