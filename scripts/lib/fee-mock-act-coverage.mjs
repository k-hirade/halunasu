import crypto from "node:crypto";

const CLAIM_ATTRIBUTE_PATTERNS = Object.freeze([
  /^(?:訪問診療年月日|往診又は訪問診療年月日|初回算定年月日)/u,
  /^単一建物診療患者数/u
]);

const CLAIM_COMMENT_PATTERNS = Object.freeze([
  /^同一患家/u,
  /(?:必要性|理由|頻回).*(?:訪問診療|往診)/u
]);

const PATIENT_CHARGE_PATTERNS = Object.freeze([
  // 厚生労働省「診療報酬の算定方法」別表第一 第2章第2部
  // C000 往診料 注7: 往診に要した交通費は患家の負担とする。
  // https://www.mhlw.go.jp/web/t_doc?dataId=84aa9729&dataType=0&pageNo=6
  /^往診交通費/u
]);

const BILLABLE_NAME_PATTERN = /(?:診療料|管理料|指導料|交付料|評価料|再診料|加算|採血|検査|往診|カテーテル|チューブ|人工鼻|酸素ボンベ|酸素濃縮装置)/u;

export const MOCK_ACT_CLASSES = Object.freeze([
  "billable_line",
  "claim_comment",
  "claim_attribute",
  "patient_charge",
  "unknown"
]);

export function normalizeMockActionName(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/令和\s*\d+\s*年\s*\d+\s*月\s*\d+\s*日/gu, "{date}")
    .replace(/単一建物診療患者数[（(]施医総管[）)][；;]\d+/gu, "単一建物診療患者数(施医総管);{count}")
    .replace(/同一患家\s*[\d日、,・\s]+/gu, "同一患家 {dates}")
    .replace(/\s+/gu, "");
}

export function classifyMockAction(actionName = "", mapping = null) {
  const normalized = normalizeMockActionName(actionName);
  if (!normalized) {
    return "unknown";
  }
  const mappedClass = String(mapping?.action_class || mapping?.actionClass || "").trim();
  if (MOCK_ACT_CLASSES.includes(mappedClass)) {
    return mappedClass;
  }
  if (PATIENT_CHARGE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "patient_charge";
  }
  if (CLAIM_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "claim_attribute";
  }
  if (CLAIM_COMMENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "claim_comment";
  }
  const status = String(mapping?.match_status || mapping?.matchStatus || "").trim();
  if (["exact_master_name", "ambiguous_exact_master_name", "manual_required"].includes(status)) {
    return "billable_line";
  }
  if (status === "comment_or_nonclaim") {
    return "unknown";
  }
  return BILLABLE_NAME_PATTERN.test(normalized) ? "billable_line" : "unknown";
}

export function buildMockActionMappingIndex(rows = []) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const keys = [
      row?.action_key,
      row?.normalized_action_name,
      row?.sample_action_name
    ].map(normalizeMockActionName).filter(Boolean);
    for (const key of keys) {
      if (!index.has(key)) {
        index.set(key, row);
      }
    }
  }
  return index;
}

export function auditMockActCoverageCase(testCase = {}, calculation = {}, mappingRows = []) {
  const mappingIndex = buildMockActionMappingIndex(mappingRows);
  const candidates = expandCalculationCandidateUnits(
    normalizeCalculationCandidates(calculation),
    mappingRows,
    String(testCase.caseId || "")
  );
  const notices = normalizeCalculationNotices(calculation);
  const standingLane = normalizeStandingLaneDiagnostics(calculation);
  const gold = (Array.isArray(testCase.actionList) ? testCase.actionList : []).map((actionName, index) => {
    const normalizedName = normalizeMockActionName(actionName);
    const mapping = mappingIndex.get(normalizedName) || null;
    const actionClass = classifyMockAction(actionName, mapping);
    const match = actionClass === "claim_comment"
        ? matchClaimComment(actionName, notices, mapping)
        : null;
    return {
      actionIndex: index + 1,
      actionClass,
      normalizedName,
      expectedCode: String(mapping?.code || "").trim() || null,
      candidateCodes: mappingCandidateCodes(mapping),
      expectedPoints: nonNegativeNumber(mapping?.points),
      expectedUnitAmountYen: nonNegativeNumber(mapping?.unit_amount_yen),
      billingScope: mappingBillingScope(mapping),
      billingScopeSource: String(mapping?.billing_scope_source || "").trim()
        || "conservative_default:missing_scope_metadata",
      expectedQuantity: positiveInteger(mapping?.expected_quantity) || 1,
      matchStatus: match?.status || (
        actionClass === "patient_charge" ? "excluded_from_billable_denominator"
          : actionClass === "claim_attribute" ? "attribute_only"
            : actionClass === "unknown" ? "unknown"
              : actionClass === "billable_line" && mappingBillingScope(mapping) === "per_month"
                ? "pending_monthly"
                : "missing"
      ),
      matchedCode: match?.candidate?.code || null,
      matchedCommentCode: match?.commentCode || null,
      matchedCommentStatus: match?.commentStatus || null,
      matchedSourceType: match?.candidate?.sourceType || null,
      matchedCandidateKey: null,
      matchedServiceDate: null,
      matchedAdoptionBlocked: null,
      matchedRequiresSelection: null,
      matchedPoints: null,
      billableReady: false,
      pointMatchStatus: "not_evaluated"
    };
  });
  const consumedCandidateKeys = new Set();
  for (const item of gold) {
    if (item.actionClass !== "billable_line" || item.billingScope !== "per_visit") {
      continue;
    }
    const mapping = mappingIndex.get(item.normalizedName) || null;
    const candidate = candidates.find((entry) => (
      entry.billingScope === "per_visit"
      && !consumedCandidateKeys.has(entry.candidateKey)
      && candidateMatchesGold(entry, item, mapping)
    ));
    if (!candidate) {
      continue;
    }
    applyCandidateMatch(item, candidate, String(testCase.serviceDate || ""));
    consumedCandidateKeys.add(candidate.candidateKey);
  }
  const falseProposals = candidates
    .filter((candidate) => (
      candidate.billingScope === "per_visit"
      && !consumedCandidateKeys.has(candidate.candidateKey)
    ))
    .map(safeCandidate);

  return {
    caseId: String(testCase.caseId || ""),
    patientId: String(testCase.patientId || ""),
    serviceDate: String(testCase.serviceDate || ""),
    setting: String(testCase.setting || ""),
    clinicalTextSha256: sha256(String(testCase.clinicalText || "")),
    standingLane,
    gold,
    actual: {
      candidateCount: candidates.length,
      candidateProposalCount: candidates.filter((candidate) => candidate.sourceType !== "calculated_line").length,
      falseProposalCount: falseProposals.length,
      dangerousFalsePositiveCount: falseProposals
        .filter((candidate) => candidate.sourceType === "calculated_line").length,
      falseProposals,
      candidateInventory: candidates.map(safeCandidate),
      consumedCandidateKeys: [...consumedCandidateKeys],
      matchedCandidateKeyCount: consumedCandidateKeys.size,
      duplicateMonthlyCandidateCount: 0
    },
    metrics: summarizeCaseGold(gold)
  };
}

export function reconcileMockActCoverageRuns(runs = [], mappingRows = []) {
  const values = Array.isArray(runs) ? runs : [];
  const mappingIndex = buildMockActionMappingIndex(mappingRows);
  const groups = new Map();
  for (const run of values) {
    const claimMonth = String(run?.serviceDate || "").slice(0, 7);
    const key = `${String(run?.patientId || "")}:${claimMonth}`;
    if (!groups.has(key)) {
      groups.set(key, {
        patientId: String(run?.patientId || ""),
        claimMonth,
        runs: []
      });
    }
    groups.get(key).runs.push(run);
  }

  for (const group of groups.values()) {
    reconcilePatientMonthGroup(group, mappingIndex);
  }
  for (const run of values) {
    run.metrics = summarizeCaseGold(run.gold);
    run.actual.falseProposalCount = asArray(run.actual.falseProposals).length;
    run.actual.dangerousFalsePositiveCount = asArray(run.actual.falseProposals)
      .filter((candidate) => candidate.sourceType === "calculated_line").length;
    run.actual.candidateProposalCount = asArray(run.actual.candidateInventory)
      .filter((candidate) => candidate.sourceType !== "calculated_line").length;
    run.actual.matchedCandidateKeyCount = run.gold.filter((item) => item.matchedCandidateKey).length;
  }
  return values;
}

export function summarizeMockActCoverage(runs = []) {
  const totals = {
    caseCount: 0,
    rateLimitRetryCount: 0,
    billableCount: 0,
    confirmedCount: 0,
    candidateCount: 0,
    missingCount: 0,
    commentCount: 0,
    commentDetectedCount: 0,
    commentGeneratedCount: 0,
    commentInputRequiredCount: 0,
    claimAttributeCount: 0,
    patientChargeCount: 0,
    unknownCount: 0,
    falseProposalCount: 0,
    dangerousFalsePositiveCount: 0,
    billableReadyCount: 0,
    conditionalCandidateCount: 0,
    expectedMappedPointLineCount: 0,
    expectedPointTotal: 0,
    billableReadyExpectedPointLineCount: 0,
    billableReadyExpectedPointTotal: 0,
    detectedBillableReadyPointTotal: 0,
    pointMatchedLineCount: 0,
    pointMismatchCount: 0,
    candidateProposalCount: 0,
    matchedCandidateProposalCount: 0
  };
  const byScope = {
    per_visit: emptyBillableTotals(),
    per_month: emptyBillableTotals()
  };
  const byClaimMonth = {};
  for (const run of Array.isArray(runs) ? runs : []) {
    totals.caseCount += 1;
    for (const key of Object.keys(totals)) {
      if (key === "caseCount") {
        continue;
      }
      totals[key] += Number(
        run?.metrics?.[key]
        ?? run?.actual?.[key]
        ?? run?.[key]
        ?? 0
      );
    }
    for (const item of asArray(run?.gold)) {
      if (item.actionClass !== "billable_line") {
        continue;
      }
      const scope = item.billingScope === "per_month" ? "per_month" : "per_visit";
      addBillableOutcome(byScope[scope], item);
      const month = String(run?.serviceDate || "").slice(0, 7) || "unknown";
      if (!byClaimMonth[month]) {
        byClaimMonth[month] = emptyBillableTotals();
      }
      addBillableOutcome(byClaimMonth[month], item);
    }
  }
  const matchedBillableCount = totals.confirmedCount + totals.candidateCount;
  const candidatePrecision = ratio(
    totals.matchedCandidateProposalCount,
    totals.candidateProposalCount
  );
  return {
    ...totals,
    matchedBillableCount,
    actCoverageMatchedCount: matchedBillableCount,
    actCoverageRecall: ratio(matchedBillableCount, totals.billableCount),
    billableMatchRate: ratio(matchedBillableCount, totals.billableCount),
    billableReadyMatchRate: ratio(totals.billableReadyCount, totals.billableCount),
    confirmedBillableRate: ratio(totals.confirmedCount, totals.billableCount),
    commentDetectionRate: ratio(totals.commentDetectedCount, totals.commentCount),
    candidatePrecision,
    pointTotalsComparable: totals.billableReadyExpectedPointLineCount > 0,
    pointTotalsMatch: totals.billableReadyExpectedPointLineCount > 0
      && totals.pointMismatchCount === 0
      && totals.pointMatchedLineCount === totals.billableReadyExpectedPointLineCount
      && totals.detectedBillableReadyPointTotal === totals.billableReadyExpectedPointTotal,
    byScope: Object.fromEntries(
      Object.entries(byScope).map(([key, value]) => [key, finalizeBillableTotals(value)])
    ),
    byClaimMonth: Object.fromEntries(
      Object.entries(byClaimMonth).map(([key, value]) => [key, finalizeBillableTotals(value)])
    ),
    standingLane: summarizeStandingLaneDiagnostics(runs)
  };
}

export function summarizeMockActCoverageRepetitions(repetitions = []) {
  const values = Array.isArray(repetitions) ? repetitions : [];
  const completed = values.filter((entry) => entry.status === "complete" && entry.summary);
  const latest = completed.at(-1)?.summary || values.at(-1)?.summary || {};
  const rateLimitRetryCount = values.reduce(
    (total, entry) => total + Number(entry?.summary?.rateLimitRetryCount || 0),
    0
  );
  const outputHashes = completed.map((entry) => entry.outputSha256).filter(Boolean);
  const repeatCoverageComplete = values.length > 0 && completed.length === values.length;
  const deterministicOutputs = repeatCoverageComplete
    && completed.length >= 2
    && outputHashes.length === completed.length
    && new Set(outputHashes).size === 1;
  const acceptance = completed.map((entry) => ({
    repeatIndex: entry.repeatIndex,
    actCoveragePassed: entry.summary.actCoverageRecall === 1,
    dangerousFalsePositivePassed: entry.summary.dangerousFalsePositiveCount === 0,
    commentDetectionPassed: entry.summary.commentCount === 0
      || entry.summary.commentDetectionRate === 1,
    pointTotalsPassed: entry.summary.pointTotalsMatch === true
  }));
  return {
    ...latest,
    rateLimitRetryCount,
    repeatCount: values.length,
    completedRepeatCount: completed.length,
    repeatCoverageComplete,
    deterministicOutputs,
    allAcceptanceChecksPassed: deterministicOutputs
      && acceptance.length === values.length
      && acceptance.every((entry) => (
        entry.actCoveragePassed
        && entry.dangerousFalsePositivePassed
        && entry.commentDetectionPassed
        && entry.pointTotalsPassed
      )),
    repeatAcceptance: acceptance
  };
}

export function resolveRateLimitRetryDelayMs(
  retryAfter,
  {
    attempt = 0,
    baseDelayMs = 5_000,
    maxDelayMs = 60_000,
    nowMs = Date.now()
  } = {}
) {
  const normalizedAttempt = Math.max(0, Number(attempt) || 0);
  const normalizedBase = Math.max(0, Number(baseDelayMs) || 0);
  const normalizedMax = Math.max(normalizedBase, Number(maxDelayMs) || 0);
  const raw = String(retryAfter || "").trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(normalizedMax, Math.ceil(seconds * 1_000));
    }
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) {
      return Math.min(normalizedMax, Math.max(0, retryAt - nowMs));
    }
  }
  return Math.min(normalizedMax, normalizedBase * (2 ** normalizedAttempt));
}

export function parseCsv(text = "") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const value = String(text || "");
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (char === "\"" && value[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  const [headers = [], ...data] = rows.filter((entry) => entry.some((cell) => cell !== ""));
  return data.map((entry) => Object.fromEntries(headers.map((header, index) => [header, entry[index] || ""])));
}

function normalizeCalculationCandidates(calculation = {}) {
  const source = calculation?.sidecarDraft?.calculation || calculation?.calculation || calculation;
  return (Array.isArray(source?.candidates) ? source.candidates : []).map((candidate, index) => ({
    sourceIndex: index,
    sourceType: String(candidate?.sourceType || ""),
    code: String(candidate?.code || candidate?.candidateLine?.code || "").trim(),
    codeCandidates: uniqueStrings(candidate?.codeCandidates || candidate?.candidateLine?.codeCandidates),
    name: String(
      candidate?.name
      || candidate?.candidateLine?.name
      || candidate?.display?.stem
      || ""
    ).trim(),
    adoptionBlocked: candidate?.adoptionBlocked === true,
    requiresSelection: candidate?.requiresSelection === true
      || candidate?.selectionRequired === true
      || candidate?.codeSelectionRequired === true
      || (
        !String(candidate?.code || candidate?.candidateLine?.code || "").trim()
        && uniqueStrings(candidate?.codeCandidates || candidate?.candidateLine?.codeCandidates).length > 0
      ),
    points: nonNegativeNumber(
      candidate?.points
      ?? candidate?.candidateLine?.points
      ?? candidate?.potentialPoints
    ),
    totalPoints: nonNegativeNumber(
      candidate?.estimatedTotalPoints
      ?? candidate?.totalPoints
      ?? candidate?.candidateLine?.totalPoints
      ?? candidate?.potentialPoints
      ?? candidate?.points
    ),
    quantity: positiveInteger(
      candidate?.quantity
      ?? candidate?.candidateLine?.quantity
      ?? candidate?.count
    ) || 1
  }));
}

function normalizeCalculationNotices(calculation = {}) {
  const source = calculation?.sidecarDraft?.calculation || calculation?.calculation || calculation;
  const values = Array.isArray(source?.notices)
    ? source.notices
    : [
      ...(Array.isArray(source?.warnings) ? source.warnings : []),
      ...(Array.isArray(source?.reviewIssues) ? source.reviewIssues : [])
    ];
  const candidateComments = asArray(source?.candidates).flatMap((candidate) => (
    asArray(candidate?.comments).map((comment) => ({
      kind: "attached_comment",
      targetCode: candidate?.code || comment?.targetCode || null,
      comment
    }))
  ));
  const seen = new Set();
  return [...values, ...candidateComments].map((notice) => {
    if (typeof notice === "string") {
      return {
        kind: "legacy",
        targetCode: null,
        commentCode: null,
        commentStatus: null,
        normalizedTexts: [normalizeMockActionName(notice)].filter(Boolean)
      };
    }
    const comment = notice?.comment && typeof notice.comment === "object"
      ? notice.comment
      : null;
    return {
      kind: String(notice?.kind || "legacy"),
      targetCode: String(notice?.targetCode || comment?.targetCode || "").trim() || null,
      commentCode: String(comment?.commentCode || notice?.commentCode || "").trim() || null,
      commentStatus: String(comment?.status || notice?.commentStatus || "").trim() || null,
      normalizedTexts: [
        comment?.name,
        comment?.text,
        notice?.shortText,
        notice?.detailText,
        notice?.title,
        notice?.messageForStaff,
        notice?.message
      ].map(normalizeMockActionName).filter(Boolean)
    };
  }).filter((notice) => {
    const key = [
      notice.kind,
      notice.targetCode,
      notice.commentCode,
      notice.commentStatus,
      notice.normalizedTexts.join("|")
    ].join(":");
    if (!notice.normalizedTexts.length || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeStandingLaneDiagnostics(calculation = {}) {
  const source = calculation?.sidecarDraft?.calculation || calculation?.calculation || calculation;
  const standingLane = source?.metrics?.standingLane;
  if (!standingLane || typeof standingLane !== "object" || Array.isArray(standingLane)) {
    return null;
  }
  const perTrigger = asArray(standingLane?.structuredTriggers?.perTrigger).map((entry) => ({
    triggerId: String(entry?.triggerId || ""),
    ruleKind: String(entry?.ruleKind || ""),
    reason: String(entry?.reason || ""),
    missingFacts: uniqueStrings(entry?.missingFacts),
    ...(Number.isInteger(entry?.familyMatchCount)
      ? { familyMatchCount: entry.familyMatchCount }
      : {})
  })).filter((entry) => entry.triggerId && entry.reason);
  return {
    disabledReason: standingLane.disabledReason || null,
    familyCount: nonNegativeNumber(standingLane.familyCount) || 0,
    additionalSelectorResolvedCount: nonNegativeNumber(
      standingLane.additionalSelectorResolvedCount
    ) || 0,
    structuredTriggers: {
      reasonCounts: normalizeCountMap(standingLane?.structuredTriggers?.reasonCounts),
      perTrigger
    },
    factsSummary: normalizeStandingFactsSummary(standingLane.factsSummary)
  };
}

function normalizeStandingFactsSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    residenceType: String(value.residenceType || "") || null,
    plannedHomeVisit: value.plannedHomeVisit === true,
    activeDiagnosisCount: nonNegativeNumber(value.activeDiagnosisCount) || 0,
    currentManagementOrCounselingCount: nonNegativeNumber(
      value.currentManagementOrCounselingCount
    ) || 0,
    currentManagementEventCount: nonNegativeNumber(
      value.currentManagementEventCount
    ) || 0,
    currentManagementStandingMentionCount: nonNegativeNumber(
      value.currentManagementStandingMentionCount
    ) || 0,
    currentManagementTextSignalCount: nonNegativeNumber(
      value.currentManagementTextSignalCount
    ) || 0,
    currentLongitudinalPlanSignalCount: nonNegativeNumber(
      value.currentLongitudinalPlanSignalCount
    ) || 0,
    standingMentionCount: nonNegativeNumber(value.standingMentionCount) || 0,
    deviceFactCount: nonNegativeNumber(value.deviceFactCount) || 0,
    eventCount: nonNegativeNumber(value.eventCount) || 0,
    currentOwnEventCount: nonNegativeNumber(value.currentOwnEventCount) || 0,
    eventTypeCounts: normalizeCountMap(value.eventTypeCounts),
    actionStatusCounts: normalizeCountMap(value.actionStatusCounts),
    temporalRelationCounts: normalizeCountMap(value.temporalRelationCounts),
    providerOwnershipCounts: normalizeCountMap(value.providerOwnershipCounts)
  };
}

function summarizeStandingLaneDiagnostics(runs = []) {
  const values = asArray(runs).map((run) => run?.standingLane).filter(Boolean);
  const reasonCounts = {};
  const missingFactCounts = {};
  const disabledReasonCounts = {};
  for (const lane of values) {
    if (lane.disabledReason) {
      incrementCount(disabledReasonCounts, lane.disabledReason);
    }
    for (const trigger of asArray(lane?.structuredTriggers?.perTrigger)) {
      incrementCount(reasonCounts, trigger.reason);
      for (const fact of asArray(trigger.missingFacts)) {
        incrementCount(missingFactCounts, fact);
      }
    }
  }
  return {
    observedRunCount: values.length,
    missingRunCount: asArray(runs).length - values.length,
    disabledReasonCounts,
    reasonCounts,
    missingFactCounts
  };
}

function normalizeCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [String(key || ""), nonNegativeNumber(count) || 0])
      .filter(([key]) => key)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function incrementCount(target, key) {
  const normalized = String(key || "").trim();
  if (normalized) {
    target[normalized] = Number(target[normalized] || 0) + 1;
  }
}

function expandCalculationCandidateUnits(candidates, mappingRows, caseId) {
  const units = [];
  for (const candidate of asArray(candidates)) {
    const quantity = Math.min(1000, positiveInteger(candidate.quantity) || 1);
    const billingScope = candidateBillingScope(candidate, mappingRows);
    for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
      units.push({
        ...candidate,
        quantity: 1,
        originalQuantity: quantity,
        unitIndex,
        billingScope,
        candidateKey: [
          caseId,
          candidate.sourceIndex,
          unitIndex
        ].join(":")
      });
    }
  }
  return units;
}

function candidateMatchesGold(candidate, gold, mapping) {
  const expectedCodes = new Set([
    String(mapping?.code || "").trim(),
    ...mappingCandidateCodes(mapping)
  ].filter(Boolean));
  if (
    candidate.code && expectedCodes.has(candidate.code)
    || candidate.codeCandidates.some((code) => expectedCodes.has(code))
  ) {
    return true;
  }
  const candidateName = normalizeMockActionName(candidate.name);
  return Boolean(candidateName && candidateName === gold.normalizedName);
}

function candidateBillingScope(candidate, mappingRows) {
  const matching = asArray(mappingRows).filter((mapping) => (
    candidateMatchesGold(candidate, {
      normalizedName: normalizeMockActionName(
        mapping?.normalized_action_name
        || mapping?.sample_action_name
        || mapping?.action_key
      )
    }, mapping)
  ));
  if (
    matching.length
    && matching.every((mapping) => mappingBillingScope(mapping) === "per_month")
  ) {
    return "per_month";
  }
  return "per_visit";
}

function mappingBillingScope(mapping = {}) {
  return String(mapping?.billing_scope || mapping?.billingScope || "") === "per_month"
    ? "per_month"
    : "per_visit";
}

function applyCandidateMatch(gold, candidate, serviceDate) {
  gold.matchStatus = candidate.sourceType === "calculated_line" ? "confirmed" : "candidate";
  gold.matchedCode = candidate.code || null;
  gold.matchedSourceType = candidate.sourceType || null;
  gold.matchedCandidateKey = candidate.candidateKey;
  gold.matchedServiceDate = serviceDate || null;
  gold.matchedAdoptionBlocked = candidate.adoptionBlocked === true;
  gold.matchedRequiresSelection = candidate.requiresSelection === true;
  gold.matchedPoints = nonNegativeNumber(candidate.totalPoints ?? candidate.points);
  gold.billableReady = candidateIsBillableReady(candidate);
  gold.pointMatchStatus = pointMatchStatus(gold);
}

function reconcilePatientMonthGroup(group, mappingIndex) {
  const monthlyGold = [];
  const perVisitConsumed = new Set();
  for (const run of group.runs) {
    for (const key of asArray(run?.actual?.consumedCandidateKeys)) {
      perVisitConsumed.add(key);
    }
    for (const item of asArray(run?.gold)) {
      if (item.actionClass !== "billable_line" || item.billingScope !== "per_month") {
        continue;
      }
      item.matchStatus = "missing";
      item.matchedCode = null;
      item.matchedSourceType = null;
      item.matchedCandidateKey = null;
      item.matchedServiceDate = null;
      item.matchedAdoptionBlocked = null;
      item.matchedRequiresSelection = null;
      item.matchedPoints = null;
      item.billableReady = false;
      item.pointMatchStatus = "not_evaluated";
      monthlyGold.push({ run, item });
    }
  }

  const monthlyUnits = group.runs.flatMap((run) => (
    asArray(run?.actual?.candidateInventory)
      .filter((candidate) => candidate.billingScope === "per_month")
      .map((candidate) => ({ run, candidate }))
  ));
  const deduplicated = dedupeMonthlyCandidateUnits(monthlyUnits);
  const consumedMonthlyKeys = new Set();
  for (const entry of monthlyGold) {
    const mapping = mappingIndex.get(entry.item.normalizedName) || null;
    const match = deduplicated.units.find(({ candidate }) => (
      !consumedMonthlyKeys.has(candidate.monthlyCandidateKey)
      && candidateMatchesGold(candidate, entry.item, mapping)
    ));
    if (!match) {
      continue;
    }
    applyCandidateMatch(entry.item, match.candidate, match.run.serviceDate);
    entry.item.matchedCandidateKey = match.candidate.monthlyCandidateKey;
    consumedMonthlyKeys.add(match.candidate.monthlyCandidateKey);
  }

  for (const run of group.runs) {
    const perVisitFalse = asArray(run?.actual?.candidateInventory)
      .filter((candidate) => (
        candidate.billingScope === "per_visit"
        && !perVisitConsumed.has(candidate.candidateKey)
      ))
      .map(safeCandidate);
    run.actual.falseProposals = perVisitFalse;
    run.actual.duplicateMonthlyCandidateCount = 0;
  }
  for (const duplicate of deduplicated.duplicates) {
    duplicate.run.actual.duplicateMonthlyCandidateCount += 1;
  }
  for (const entry of deduplicated.units) {
    if (consumedMonthlyKeys.has(entry.candidate.monthlyCandidateKey)) {
      continue;
    }
    entry.run.actual.falseProposals.push(safeCandidate(entry.candidate));
  }
}

function dedupeMonthlyCandidateUnits(entries) {
  const byKey = new Map();
  const duplicates = [];
  for (const entry of entries) {
    const baseKey = [
      entry.candidate.code || "",
      asArray(entry.candidate.codeCandidates).slice().sort().join(","),
      normalizeMockActionName(entry.candidate.name),
      entry.candidate.unitIndex || 1
    ].join(":");
    const candidate = {
      ...entry.candidate,
      monthlyCandidateKey: baseKey
    };
    const current = byKey.get(baseKey);
    if (!current) {
      byKey.set(baseKey, { ...entry, candidate });
      continue;
    }
    if (candidateSourceRank(candidate.sourceType) > candidateSourceRank(current.candidate.sourceType)) {
      duplicates.push(current);
      byKey.set(baseKey, { ...entry, candidate });
    } else {
      duplicates.push({ ...entry, candidate });
    }
  }
  return {
    units: [...byKey.values()],
    duplicates
  };
}

function candidateSourceRank(sourceType) {
  return sourceType === "calculated_line" ? 2 : 1;
}

function matchClaimComment(actionName, notices, mapping = null) {
  const normalized = normalizeMockActionName(actionName);
  const stem = normalized.replace(/\{date\}|\{count\}|\{dates\}/gu, "");
  const expectedCommentCode = String(mapping?.comment_code || mapping?.commentCode || "").trim();
  const found = notices.find((notice) => {
    if (expectedCommentCode && notice.commentCode === expectedCommentCode) {
      return true;
    }
    return notice.normalizedTexts.some((text) => (
      text.includes(stem) || stem.includes(text)
    ));
  });
  return found
    ? {
      status: "comment_detected",
      candidate: null,
      commentCode: found.commentCode,
      commentStatus: ["generated", "input_required"].includes(found.commentStatus)
        ? found.commentStatus
        : "legacy_detected"
    }
    : null;
}

function mappingCandidateCodes(mapping = {}) {
  return uniqueStrings(
    String(mapping?.candidate_codes || mapping?.candidateCodes || "")
      .split(";")
      .map((entry) => entry.split(":")[1] || "")
  );
}

function summarizeCaseGold(gold = []) {
  const metrics = {
    billableCount: 0,
    confirmedCount: 0,
    candidateCount: 0,
    missingCount: 0,
    commentCount: 0,
    commentDetectedCount: 0,
    commentGeneratedCount: 0,
    commentInputRequiredCount: 0,
    claimAttributeCount: 0,
    patientChargeCount: 0,
    unknownCount: 0,
    billableReadyCount: 0,
    conditionalCandidateCount: 0,
    expectedMappedPointLineCount: 0,
    expectedPointTotal: 0,
    billableReadyExpectedPointLineCount: 0,
    billableReadyExpectedPointTotal: 0,
    detectedBillableReadyPointTotal: 0,
    pointMatchedLineCount: 0,
    pointMismatchCount: 0,
    matchedCandidateProposalCount: 0
  };
  for (const item of gold) {
    if (item.actionClass === "billable_line") {
      metrics.billableCount += 1;
      if (item.matchStatus === "confirmed") metrics.confirmedCount += 1;
      else if (item.matchStatus === "candidate") metrics.candidateCount += 1;
      else metrics.missingCount += 1;
      if (item.billableReady) {
        metrics.billableReadyCount += 1;
      } else if (item.matchStatus === "candidate") {
        metrics.conditionalCandidateCount += 1;
      }
      if (item.matchStatus === "candidate") {
        metrics.matchedCandidateProposalCount += 1;
      }
      if (item.expectedPoints !== null) {
        metrics.expectedMappedPointLineCount += 1;
        metrics.expectedPointTotal += item.expectedPoints;
        if (item.billableReady) {
          metrics.billableReadyExpectedPointLineCount += 1;
          metrics.billableReadyExpectedPointTotal += item.expectedPoints;
          if (item.pointMatchStatus === "match") {
            metrics.pointMatchedLineCount += 1;
            metrics.detectedBillableReadyPointTotal += item.matchedPoints;
          } else {
            metrics.pointMismatchCount += 1;
            metrics.detectedBillableReadyPointTotal += item.matchedPoints || 0;
          }
        }
      }
    } else if (item.actionClass === "claim_comment") {
      metrics.commentCount += 1;
      if (item.matchStatus === "comment_detected") {
        metrics.commentDetectedCount += 1;
        if (item.matchedCommentStatus === "generated") {
          metrics.commentGeneratedCount += 1;
        } else if (item.matchedCommentStatus === "input_required") {
          metrics.commentInputRequiredCount += 1;
        }
      }
    } else if (item.actionClass === "claim_attribute") {
      metrics.claimAttributeCount += 1;
    } else if (item.actionClass === "patient_charge") {
      metrics.patientChargeCount += 1;
    } else {
      metrics.unknownCount += 1;
    }
  }
  return metrics;
}

function safeCandidate(candidate = {}) {
  return {
    candidateKey: candidate.candidateKey || null,
    monthlyCandidateKey: candidate.monthlyCandidateKey || null,
    sourceType: candidate.sourceType,
    code: candidate.code || null,
    codeCandidates: candidate.codeCandidates,
    normalizedName: normalizeMockActionName(candidate.name || candidate.normalizedName),
    adoptionBlocked: candidate.adoptionBlocked,
    requiresSelection: candidate.requiresSelection === true,
    points: nonNegativeNumber(candidate.points),
    totalPoints: nonNegativeNumber(candidate.totalPoints),
    billingScope: candidate.billingScope === "per_month" ? "per_month" : "per_visit",
    unitIndex: positiveInteger(candidate.unitIndex) || 1,
    originalQuantity: positiveInteger(candidate.originalQuantity) || 1
  };
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function emptyBillableTotals() {
  return {
    billableCount: 0,
    confirmedCount: 0,
    candidateCount: 0,
    missingCount: 0,
    billableReadyCount: 0
  };
}

function addBillableOutcome(target, item) {
  target.billableCount += 1;
  if (item.matchStatus === "confirmed") target.confirmedCount += 1;
  else if (item.matchStatus === "candidate") target.candidateCount += 1;
  else target.missingCount += 1;
  if (item.billableReady) target.billableReadyCount += 1;
}

function finalizeBillableTotals(value) {
  const matchedBillableCount = value.confirmedCount + value.candidateCount;
  return {
    ...value,
    matchedBillableCount,
    billableMatchRate: ratio(matchedBillableCount, value.billableCount),
    actCoverageRecall: ratio(matchedBillableCount, value.billableCount),
    billableReadyMatchRate: ratio(value.billableReadyCount, value.billableCount),
    confirmedBillableRate: ratio(value.confirmedCount, value.billableCount)
  };
}

function candidateIsBillableReady(candidate = {}) {
  return Boolean(
    candidate.code
    && candidate.adoptionBlocked !== true
    && candidate.requiresSelection !== true
  );
}

function pointMatchStatus(gold = {}) {
  if (gold.expectedPoints === null) {
    return "not_mapped";
  }
  if (!gold.billableReady) {
    return gold.matchStatus === "missing" ? "missing" : "conditional";
  }
  if (gold.matchedPoints === null) {
    return "missing_actual";
  }
  return Number(gold.matchedPoints) === Number(gold.expectedPoints) ? "match" : "mismatch";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}
