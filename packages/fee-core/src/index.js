import crypto from "node:crypto";
import {
  validateReviewDecisionInput
} from "../../fee-contracts/src/index.js";
import { estimateReceiptYen } from "./receipt-utils.js";

export { estimateReceiptYen } from "./receipt-utils.js";

export {
  buildMissingBillingFindings,
  buildMissingBillingReviewIssues,
  buildIndicationFindings,
  buildIndicationReviewIssues,
  claimCheckLookupCodes,
  findingToReviewIssue
} from "./claim-checks.js";

export {
  buildClinicDiagnosisReport,
  clinicDiagnosisReportToHtml,
  clinicDiagnosisReportToCsv
} from "./clinic-diagnosis.js";

export function buildFeeSession(input = {}, options = {}) {
  const now = timestamp(options.now);
  const feeSessionId = options.feeSessionId || createId("fee");
  const patientId = optionalString(input.patientId);
  const facilityId = optionalString(input.facilityId);
  const serviceDate = optionalString(input.serviceDate) || now.slice(0, 10);
  const status = input.status || (patientId && facilityId ? "ready" : "draft");

  return compactObject({
    feeSessionId,
    sessionId: feeSessionId,
    orgId: requiredString(input.orgId, "orgId"),
    patientId: patientId || null,
    patientRef: input.patientRef || patientId || null,
    patientSnapshot: input.patientSnapshot || null,
    insuranceSnapshot: input.insuranceSnapshot || null,
    facilityId: facilityId || null,
    facilitySnapshot: input.facilitySnapshot || null,
    departmentId: input.departmentId || null,
    departmentSnapshot: input.departmentSnapshot || null,
    createdByMemberId: requiredString(input.createdByMemberId, "createdByMemberId"),
    status,
    serviceDate,
    claimMonth: input.claimMonth || serviceDate.slice(0, 7),
    setting: input.setting || "outpatient",
    receptionTime: input.receptionTime || input.reception_time || null,
    admissionDate: input.admissionDate || input.admission_date || null,
    inpatientBasicDays: input.inpatientBasicDays || input.inpatient_basic_days || null,
    clinicalText: input.clinicalText || "",
    orders: Array.isArray(input.orders) ? input.orders : [],
    diagnoses: Array.isArray(input.diagnoses) ? input.diagnoses : [],
    diagnosesSource: input.diagnosesSource || null,
    diagnosesClinicalTextHash: input.diagnosesClinicalTextHash || null,
    insurance: input.insurance || null,
    claimContext: isPlainObject(input.claimContext) ? input.claimContext : null,
    calculationOptions: isPlainObject(input.calculationOptions) ? input.calculationOptions : null,
    calculationOptionsSource: input.calculationOptionsSource || null,
    calculationOptionsAutoKeys: Array.isArray(input.calculationOptionsAutoKeys) ? input.calculationOptionsAutoKeys : [],
    calculationProgress: isPlainObject(input.calculationProgress) ? input.calculationProgress : null,
    activeCalculationJobId: input.activeCalculationJobId || null,
    monthlyClaimWork: isPlainObject(input.monthlyClaimWork) ? input.monthlyClaimWork : null,
    receiptAnnotations: isPlainObject(input.receiptAnnotations) ? input.receiptAnnotations : null,
    sourceSystem: input.sourceSystem || null,
    calculationResult: input.calculationResult || null,
    calculationSummary: input.calculationSummary || null,
    latestCalculationId: null,
    reviewDecisions: {},
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });
}

export function applyFeeSessionPatch(current = {}, patch = {}, options = {}) {
  const now = timestamp(options.now);
  const next = {
    ...current,
    ...compactObject({
      patientId: hasOwn(patch, "patientId") ? patch.patientId || null : undefined,
      patientRef: hasOwn(patch, "patientRef") ? patch.patientRef || patch.patientId || null : undefined,
      patientSnapshot: hasOwn(patch, "patientSnapshot") ? patch.patientSnapshot || null : undefined,
      insuranceSnapshot: hasOwn(patch, "insuranceSnapshot") ? patch.insuranceSnapshot || null : undefined,
      facilityId: hasOwn(patch, "facilityId") ? patch.facilityId || null : undefined,
      facilitySnapshot: hasOwn(patch, "facilitySnapshot") ? patch.facilitySnapshot || null : undefined,
      departmentId: hasOwn(patch, "departmentId") ? patch.departmentId || null : undefined,
      departmentSnapshot: hasOwn(patch, "departmentSnapshot") ? patch.departmentSnapshot || null : undefined,
      status: hasOwn(patch, "status") ? patch.status || current.status : undefined,
      serviceDate: patch.serviceDate,
      claimMonth: patch.claimMonth || (patch.serviceDate ? String(patch.serviceDate).slice(0, 7) : undefined),
      setting: patch.setting,
      admissionDate: hasOwn(patch, "admissionDate") || hasOwn(patch, "admission_date")
        ? patch.admissionDate || patch.admission_date || null
        : undefined,
      inpatientBasicDays: hasOwn(patch, "inpatientBasicDays") || hasOwn(patch, "inpatient_basic_days")
        ? patch.inpatientBasicDays || patch.inpatient_basic_days || null
        : undefined,
      clinicalText: hasOwn(patch, "clinicalText") ? patch.clinicalText || "" : undefined,
      orders: hasOwn(patch, "orders") ? patch.orders : undefined,
      diagnoses: hasOwn(patch, "diagnoses") ? patch.diagnoses : undefined,
      diagnosesSource: hasOwn(patch, "diagnosesSource") ? patch.diagnosesSource || null : undefined,
      diagnosesClinicalTextHash: hasOwn(patch, "diagnosesClinicalTextHash") ? patch.diagnosesClinicalTextHash || null : undefined,
      insurance: hasOwn(patch, "insurance") ? patch.insurance || null : undefined,
      claimContext: hasOwn(patch, "claimContext") ? patch.claimContext || null : undefined,
      calculationOptions: hasOwn(patch, "calculationOptions") ? patch.calculationOptions || null : undefined,
      calculationOptionsSource: hasOwn(patch, "calculationOptionsSource") ? patch.calculationOptionsSource || null : undefined,
      calculationOptionsAutoKeys: hasOwn(patch, "calculationOptionsAutoKeys")
        ? Array.isArray(patch.calculationOptionsAutoKeys) ? patch.calculationOptionsAutoKeys : []
        : undefined,
      calculationProgress: hasOwn(patch, "calculationProgress")
        ? isPlainObject(patch.calculationProgress) ? patch.calculationProgress : null
        : undefined,
      activeCalculationJobId: hasOwn(patch, "activeCalculationJobId")
        ? patch.activeCalculationJobId || null
        : undefined,
      monthlyClaimWork: hasOwn(patch, "monthlyClaimWork")
        ? isPlainObject(patch.monthlyClaimWork) ? patch.monthlyClaimWork : null
        : undefined,
      receiptAnnotations: hasOwn(patch, "receiptAnnotations")
        ? isPlainObject(patch.receiptAnnotations) ? patch.receiptAnnotations : null
        : undefined,
      sourceSystem: patch.sourceSystem
    }),
    updatedAt: now
  };
  const changedCalculationInput = [
    "patientId",
    "facilityId",
    "departmentId",
    "serviceDate",
    "claimMonth",
    "setting",
    "admissionDate",
    "admission_date",
    "inpatientBasicDays",
    "inpatient_basic_days",
    "clinicalText",
    "orders",
    "diagnoses",
    "diagnosesSource",
    "diagnosesClinicalTextHash",
    "insurance",
    "claimContext",
    "calculationOptions",
    "calculationOptionsSource",
    "calculationOptionsAutoKeys"
  ].some((key) => hasOwn(patch, key));

  if (changedCalculationInput && (next.calculationResult || next.calculationSummary)) {
    next.calculationResult = null;
    next.calculationSummary = null;
    next.latestCalculationId = null;
    next.calculationProgress = null;
  }

  if (patch.status === "calculating") {
    next.calculationResult = null;
    next.calculationSummary = null;
    next.latestCalculationId = null;
  }

  if (changedCalculationInput && !hasOwn(patch, "status") && ["draft", "ready", "failed", "calculated", "needs_review"].includes(current.status || "")) {
    next.status = feeSessionHasRequiredCalculationContext(next) ? "ready" : "draft";
  }

  return compactObject(next);
}

export function applyCalculationResult(current = {}, calculationResult = {}, options = {}) {
  const normalizedResult = normalizeCalculationResult(current, calculationResult, options);
  const now = timestamp(options.now);
  const status = calculationNeedsReview(normalizedResult) ? "needs_review" : "calculated";

  return {
    ...current,
    status,
    calculationResult: normalizedResult,
    calculationSummary: buildCalculationSummary(normalizedResult),
    latestCalculationId: normalizedResult.calculationId,
    calculationProgress: isPlainObject(calculationResult.calculationProgress)
      ? calculationResult.calculationProgress
      : {
        phase: "complete",
        label: "完了",
        message: "算定候補の作成が完了しました。",
        percent: 100,
        updatedAt: now,
        totalPoints: normalizedResult.totalPoints,
        lineItemCount: normalizedResult.lineItems.length
      },
    activeCalculationJobId: null,
    updatedAt: now
  };
}

export function normalizeCalculationResult(session = {}, calculation = {}, options = {}) {
  const now = timestamp(options.now);
  const lineItems = normalizeLineItems(calculation.lineItems || calculation.lines || []);
  const totalPoints = Number(
    calculation.totalPoints
    ?? calculation.total_points
    ?? lineItems.reduce((sum, line) => sum + line.totalPoints, 0)
  );
  const warnings = normalizeWarnings(calculation.warnings || calculation.messages || []);
  const candidateProposals = normalizeCandidateProposals(
    calculation.candidateProposals || calculation.candidate_proposals || calculation.proposals || []
  );
  const clinicalEvents = normalizeClinicalEvents(calculation.clinicalEvents || calculation.clinical_events || []);
  const canonicalClinicalFacts = normalizeCanonicalClinicalFacts(
    calculation.canonicalClinicalFacts || calculation.canonical_clinical_facts || []
  );
  const masterCandidates = normalizeMasterCandidates(calculation.masterCandidates || calculation.master_candidates || []);
  const billingCandidates = normalizeBillingCandidates(calculation.billingCandidates || calculation.billing_candidates || []);
  const reviewIssues = normalizeReviewIssues(calculation.reviewIssues || calculation.review_issues || []);
  const coverage = normalizeCalculationCoverage(calculation.coverage, lineItems, warnings);

  return compactObject({
    calculationId: options.calculationId || createId("calc"),
    feeSessionId: requiredString(session.feeSessionId, "feeSessionId"),
    orgId: requiredString(session.orgId, "orgId"),
    patientId: session.patientId || null,
    patientRef: session.patientRef || session.patientId,
    provider: requiredString(calculation.provider || "medical_fee_calculation", "provider"),
    source: calculation.source || "medical_fee_calculation",
    status: calculation.status || "completed",
    engineStatus: calculation.engineStatus || calculation.engine_status || null,
    setting: session.setting || "outpatient",
    serviceDate: requiredString(session.serviceDate, "serviceDate"),
    claimMonth: session.claimMonth || String(session.serviceDate).slice(0, 7),
    facility: {
      facilityId: session.facilityId || null,
      displayName: session.facilitySnapshot?.displayName || null,
      medicalInstitutionCode: session.facilitySnapshot?.medicalInstitutionCode || null,
      regionalBureau: session.facilitySnapshot?.regionalBureau || null
    },
    totalPoints,
    lineItems,
    candidateProposals,
    clinicalEvents,
    canonicalClinicalFacts,
    masterCandidates,
    billingCandidates,
    reviewIssues,
    clinicalExtraction: isPlainObject(calculation.clinicalExtraction || calculation.clinical_extraction)
      ? calculation.clinicalExtraction || calculation.clinical_extraction
      : undefined,
    shadowCalculations: Array.isArray(calculation.shadowCalculations || calculation.shadow_calculations)
      ? calculation.shadowCalculations || calculation.shadow_calculations
      : undefined,
    inputSnapshot: isPlainObject(calculation.inputSnapshot || calculation.input_snapshot)
      ? calculation.inputSnapshot || calculation.input_snapshot
      : undefined,
    warnings,
    coverage,
    messages: Array.isArray(calculation.messages) ? calculation.messages : [],
    evidence: normalizeEvidence(calculation.evidence || []),
    inputCodes: Array.isArray(calculation.inputCodes) ? calculation.inputCodes : calculation.input_codes || [],
    candidateCodes: Array.isArray(calculation.candidateCodes) ? calculation.candidateCodes : calculation.candidate_codes || [],
    rawResult: options.includeRawResult === true && isPlainObject(calculation.rawResult)
      ? calculation.rawResult
      : undefined,
    generatedAt: now,
    schemaVersion: 1
  });
}

export function buildCalculationSummary(calculation = {}) {
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const coverage = isPlainObject(calculation.coverage) ? calculation.coverage : {};
  return compactObject({
    calculationId: calculation.calculationId || null,
    provider: calculation.provider || null,
    status: calculation.status || null,
    engineStatus: calculation.engineStatus || calculation.engine_status || null,
    totalPoints: Number(calculation.totalPoints || 0),
    lineCount: Number(coverage.lineCount ?? coverage.line_count ?? lineItems.length),
    reviewLineCount: Number(
      coverage.reviewLineCount
      ?? coverage.review_line_count
      ?? lineItems.filter((line) => line.reviewRequired === true).length
    ),
    supportLevel: coverage.supportLevel || coverage.support_level || null,
    reviewRequired: coverage.reviewRequired ?? coverage.review_required ?? calculationNeedsReview(calculation),
    generatedAt: calculation.generatedAt || null
  });
}

export function buildReceiptDraft(session = {}, options = {}) {
  const calculation = session.calculationResult || {};
  const decisions = isPlainObject(session.reviewDecisions) ? session.reviewDecisions : {};
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const candidateProposals = Array.isArray(calculation.candidateProposals) ? calculation.candidateProposals : [];
  const warnings = Array.isArray(calculation.warnings) ? calculation.warnings : [];
  const baseLines = lineItems.map((line, index) => receiptLineFromCalculationLine(line, index, calculation, decisions));
  const baseLineKeys = new Set(baseLines.map((line) => receiptLineSemanticKey(line)));
  const adoptedProposalLines = candidateProposals
    .filter((proposal) => proposalIncludedInTotal(proposal, decisions))
    .map((proposal, index) => receiptLineFromProposal(proposal, index, calculation, { included: true }))
    .filter((line) => {
      const key = receiptLineSemanticKey(line);
      if (baseLineKeys.has(key)) {
        return false;
      }
      baseLineKeys.add(key);
      return true;
    });
  const lines = [...baseLines, ...adoptedProposalLines];
  const includedLines = lines.filter((line) => line.includedInTotal !== false);
  const totalPoints = Number(includedLines.reduce((sum, line) => sum + line.totalPoints, 0));
  const receiptType = receiptTypeFromSession(session);

  return {
    receiptDraftId: `receipt_${requiredString(session.feeSessionId, "feeSessionId")}`,
    receiptType,
    claimKey: buildReceiptClaimKey({
      patientId: session.patientId || null,
      claimMonth: session.claimMonth || String(session.serviceDate).slice(0, 7),
      receiptType,
      insuranceSnapshot: session.insuranceSnapshot
    }),
    feeSessionId: session.feeSessionId,
    orgId: requiredString(session.orgId, "orgId"),
    patientId: session.patientId || null,
    patientRef: session.patientRef || session.patientId,
    patientSnapshot: session.patientSnapshot || null,
    insuranceSnapshot: session.insuranceSnapshot || null,
    facilitySnapshot: session.facilitySnapshot || null,
    departmentSnapshot: session.departmentSnapshot || null,
    serviceDate: requiredString(session.serviceDate, "serviceDate"),
    claimMonth: session.claimMonth || String(session.serviceDate).slice(0, 7),
    setting: session.setting || "outpatient",
    status: calculation.status ? "ready" : "not_calculated",
    exportStatus: "draft",
    totalPoints,
    billing: buildBillingSummary(session, { totalPoints }),
    lines,
    lineOccurrences: includedLines.map((line, index) => receiptLineOccurrenceFromLine(line, session, index)),
    lineGroups: groupReceiptLines(includedLines),
    validationIssues: warnings.map((message, index) => ({
      issueId: warningReviewItemId(message, index),
      legacyIssueId: legacyWarningReviewItemId(index),
      severity: "warning",
      message
    })),
    generatedAt: timestamp(options.now || calculation.generatedAt),
    schemaVersion: 1
  };
}

// 患者×請求月で、その月の全受診を1枚のレセプト案に集計する(出来高の月次レセに相当)。
// 各受診の receiptDraft を再利用して明細をマージし、診療実日数は受診日のユニーク数で数える。
export function buildMonthlyReceiptDraft(sessions = [], options = {}) {
  const patientId = options.patientId || null;
  const claimMonth = String(options.claimMonth || "").slice(0, 7);
  const monthOf = (session) => String(session.claimMonth || String(session.serviceDate || "").slice(0, 7));
  const relevant = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.calculationResult && session.calculationResult.status)
    .filter((session) => !patientId || session.patientId === patientId)
    .filter((session) => !claimMonth || monthOf(session) === claimMonth)
    .sort((a, b) => String(a.serviceDate || "").localeCompare(String(b.serviceDate || "")));

  const lineMap = new Map();
  const lineOccurrences = [];
  for (const session of relevant) {
    const draft = buildReceiptDraft(session, { now: options.now });
    for (const line of Array.isArray(draft.lines) ? draft.lines : []) {
      if (line.includedInTotal === false) {
        continue;
      }
      const key = receiptLineAggregateKey(line);
      const occurrence = receiptLineOccurrenceFromLine(line, session, lineOccurrences.length, { aggregateKey: key });
      lineOccurrences.push(occurrence);
      const existing = lineMap.get(key);
      if (existing) {
        existing.quantity = Number(existing.quantity || 0) + Number(line.quantity || 1);
        existing.totalPoints = Number(existing.totalPoints || 0) + Number(line.totalPoints || 0);
        existing.occurrenceCount = Number(existing.occurrenceCount || 0) + 1;
        existing.occurrenceIds = [...(Array.isArray(existing.occurrenceIds) ? existing.occurrenceIds : []), occurrence.occurrenceId];
        existing.serviceDates = uniqueSortedStrings([...(Array.isArray(existing.serviceDates) ? existing.serviceDates : []), occurrence.serviceDate]);
      } else {
        lineMap.set(key, {
          ...line,
          aggregateKey: key,
          quantity: Number(line.quantity || 1),
          totalPoints: Number(line.totalPoints || 0),
          occurrenceCount: 1,
          occurrenceIds: [occurrence.occurrenceId],
          serviceDates: occurrence.serviceDate ? [occurrence.serviceDate] : []
        });
      }
    }
  }
  const lines = [...lineMap.values()];
  const totalPoints = lines.reduce((sum, line) => sum + Number(line.totalPoints || 0), 0);
  const candidateAggregation = aggregateMonthlyCandidateLines(relevant, {
    confirmedLineCodes: lines.map((line) => String(line.code || "")).filter(Boolean),
    actFrequencyLimits: options.actFrequencyLimits,
    actExclusions: options.actExclusions
  });
  const serviceDates = [...new Set(relevant.map((session) => String(session.serviceDate || "")).filter(Boolean))];
  const base = relevant[relevant.length - 1] || {};
  const receiptTypes = uniqueSortedStrings(relevant.map((session) => receiptTypeFromSession(session)));
  const receiptType = receiptTypes.length > 1 ? "mixed" : receiptTypeFromSession(base);
  const effectivePatientId = patientId || base.patientId || null;
  const effectiveClaimMonth = claimMonth || (base.serviceDate ? String(base.serviceDate).slice(0, 7) : null);

  return {
    receiptDraftId: `receipt_monthly_${effectivePatientId || "unknown"}_${effectiveClaimMonth || "unknown"}`,
    scope: "monthly",
    receiptType,
    receiptTypes,
    claimKey: buildReceiptClaimKey({
      patientId: effectivePatientId,
      claimMonth: effectiveClaimMonth,
      receiptType,
      insuranceSnapshot: base.insuranceSnapshot
    }),
    feeSessionId: base.feeSessionId || null,
    patientId: effectivePatientId,
    patientRef: base.patientRef || base.patientId || null,
    patientSnapshot: base.patientSnapshot || null,
    insuranceSnapshot: base.insuranceSnapshot || null,
    facilitySnapshot: base.facilitySnapshot || null,
    departmentSnapshot: base.departmentSnapshot || null,
    serviceDate: base.serviceDate || null,
    claimMonth: effectiveClaimMonth,
    setting: base.setting || "outpatient",
    status: relevant.length ? "ready" : "not_calculated",
    actualDays: serviceDates.length,
    sessionCount: relevant.length,
    totalPoints,
    billing: buildBillingSummary(base, { totalPoints }),
    diagnoses: mergeMonthlyDiagnoses(relevant),
    receiptAnnotations: mergeMonthlyReceiptAnnotations(relevant),
    lines,
    lineOccurrences,
    lineGroups: groupReceiptLines(lines),
    // 2段表示: totalPoints(=当社算定案) とは別に、未承認の増点候補を患者×月で集計する。
    // 候補は承認されるまで totalPoints には入らない。
    candidateLines: candidateAggregation.candidateLines,
    candidateTotalPoints: candidateAggregation.candidateTotalPoints,
    generatedAt: timestamp(options.now),
    schemaVersion: 1
  };
}

// 患者×月の未承認候補(candidateProposals)を明細形式に集計する。
// - 承認済み(=lines へ採用済み)と却下済みは除外
// - 同一コードは1行に畳み、電子点数表の回数上限(月)を超える分は suppressed として数える
// - 確定明細/他候補との背反(併算定不可)を conflicts として注釈する
function aggregateMonthlyCandidateLines(sessions = [], {
  confirmedLineCodes = [],
  actFrequencyLimits = null,
  actExclusions = null
} = {}) {
  const map = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const decisions = isPlainObject(session.reviewDecisions) ? session.reviewDecisions : {};
    const proposals = Array.isArray(session.calculationResult?.candidateProposals)
      ? session.calculationResult.candidateProposals
      : [];
    for (const proposal of proposals) {
      const decision = proposalDecision(proposal, decisions)?.status || "";
      if (decision === "approved" || decision === "rejected") {
        continue;
      }
      const code = String(proposal.code || proposal.candidateLine?.code || "").trim();
      const codeCandidates = uniqueSortedStrings(
        Array.isArray(proposal.codeCandidates) ? proposal.codeCandidates : []
      );
      // コード未確定の候補に特定区分の点数を表示しない。生成元が誤って点数を
      // 渡した場合も、月次合計へ混入させない。
      const points = code
        ? Number(proposal.potentialPoints || proposal.candidateLine?.totalPoints || 0)
        : 0;
      // 完全に同じコード候補集合だけをレーン横断で統合する。部分一致する集合は
      // 意味が異なる可能性があるため、別候補のまま保持する。
      const key = code
        || (codeCandidates.length ? `choice:${codeCandidates.join("/")}` : "")
        || (proposal.ruleId ? `rule:${proposal.ruleId}` : `proposal:${proposal.proposalId || proposal.title || ""}`);
      const serviceDate = String(session.serviceDate || "");
      const existing = map.get(key);
      if (existing) {
        existing.occurrenceCount += 1;
        existing.serviceDates = uniqueSortedStrings([...existing.serviceDates, serviceDate]);
        existing.proposalIds.push(proposal.proposalId || null);
        existing.proposalMonthlyLimit ||= normalizeProposalMonthlyLimit(proposal.monthlyLimit);
        existing.codeCandidates = uniqueSortedStrings([
          ...(existing.codeCandidates || []),
          ...codeCandidates
        ]);
      } else {
        map.set(key, {
          candidateLineId: `candidate_${key.replace(/[^\w-]/gu, "_")}`,
          code: code || null,
          name: proposal.candidateLine?.name || proposal.title || "算定候補",
          orderType: proposal.orderType || proposal.candidateLine?.orderType || "procedure",
          points,
          occurrenceCount: 1,
          title: proposal.title || "",
          reason: proposal.reason || "",
          conditionText: proposal.conditionText || "",
          evidence: proposal.evidence || "",
          source: proposal.source || "candidate_proposal",
          serviceDates: serviceDate ? [serviceDate] : [],
          proposalIds: [proposal.proposalId || null],
          proposalMonthlyLimit: normalizeProposalMonthlyLimit(proposal.monthlyLimit),
          codeCandidates
        });
      }
    }
  }

  const frequencyLimits = isPlainObject(actFrequencyLimits) ? actFrequencyLimits : {};
  const exclusions = Array.isArray(actExclusions) ? actExclusions : [];
  const confirmedCodes = new Set((confirmedLineCodes || []).map((code) => String(code || "")).filter(Boolean));
  const candidateCodes = new Set([...map.values()].map((line) => String(line.code || "")).filter(Boolean));

  const candidateLines = [...map.values()].map((line) => {
    const limits = Array.isArray(frequencyLimits[line.code]) ? frequencyLimits[line.code] : [];
    // 回数上限は電子点数表(コード確定時)を優先し、コード未確定の候補は
    // 知識ルール側の monthlyLimit をフォールバックとして使う。
    const monthlyLimit = limits.find((limit) => limit && limit.unit === "月" && Number(limit.maxCount) > 0)
      || line.proposalMonthlyLimit;
    const cappedQuantity = monthlyLimit
      ? Math.min(line.occurrenceCount, Number(monthlyLimit.maxCount))
      : line.occurrenceCount;
    const suppressedOccurrenceCount = line.occurrenceCount - cappedQuantity;
    const conflicts = [];
    for (const rule of exclusions) {
      if (String(rule?.baseCode || "") !== String(line.code || "")) {
        continue;
      }
      const counterpart = String(rule?.excludedCode || "");
      if (!counterpart || (!confirmedCodes.has(counterpart) && !candidateCodes.has(counterpart))) {
        continue;
      }
      conflicts.push({
        withCode: counterpart,
        withName: rule.excludedName || "",
        ruleKind: String(rule.ruleKind || ""),
        scope: String(rule.exclusionTable || "")
      });
    }
    const { proposalMonthlyLimit, ...rest } = line;
    return {
      ...rest,
      quantity: cappedQuantity,
      totalPoints: Number(line.points || 0) * cappedQuantity,
      suppressedOccurrenceCount,
      frequencyLimits: limits.length
        ? limits
        : (proposalMonthlyLimit ? [proposalMonthlyLimit] : undefined),
      conflicts: conflicts.length ? conflicts : undefined
    };
  }).sort((a, b) => Number(b.totalPoints || 0) - Number(a.totalPoints || 0));

  return {
    candidateLines,
    candidateTotalPoints: candidateLines.reduce((sum, line) => sum + Number(line.totalPoints || 0), 0)
  };
}

function normalizeProposalMonthlyLimit(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const maxCount = Number(value.maxCount ?? value.max_count ?? 0);
  if (!Number.isFinite(maxCount) || maxCount <= 0) {
    return null;
  }
  return { unit: String(value.unit || "月"), unitCode: String(value.unitCode || value.unit_code || ""), maxCount };
}

function mergeMonthlyDiagnoses(sessions = []) {
  const map = new Map();
  for (const session of sessions) {
    for (const diagnosis of Array.isArray(session.diagnoses) ? session.diagnoses : []) {
      const key = `${diagnosis.name || ""}|${diagnosis.icd10Code || ""}`;
      if (!`${diagnosis.name || ""}${diagnosis.icd10Code || ""}`.trim()) {
        continue;
      }
      const existing = map.get(key);
      if (existing) {
        if (diagnosis.isPrimary) {
          existing.isPrimary = true;
        }
        existing.firstSeenServiceDate = earliestYmd(existing.firstSeenServiceDate, session.serviceDate);
      } else {
        map.set(key, {
          ...diagnosis,
          firstSeenServiceDate: diagnosis.firstSeenServiceDate || session.serviceDate || null
        });
      }
    }
  }
  return [...map.values()];
}

function mergeMonthlyReceiptAnnotations(sessions = []) {
  const comments = [];
  const symptomDetails = [];
  for (const session of sessions) {
    const annotations = isPlainObject(session.receiptAnnotations) ? session.receiptAnnotations : {};
    for (const comment of Array.isArray(annotations.comments) ? annotations.comments : []) {
      comments.push(comment);
    }
    for (const detail of Array.isArray(annotations.symptomDetails) ? annotations.symptomDetails : []) {
      symptomDetails.push(detail);
    }
  }
  return { comments, symptomDetails };
}

export function buildReceiptExportValidation(receiptDraft = {}, context = {}) {
  const insuranceSnapshot = isPlainObject(context.insuranceSnapshot)
    ? context.insuranceSnapshot
    : (isPlainObject(receiptDraft.insuranceSnapshot) ? receiptDraft.insuranceSnapshot : {});
  const insurance = isPlainObject(insuranceSnapshot.insurance) ? insuranceSnapshot.insurance : {};
  const publicInsurance = Array.isArray(insuranceSnapshot.publicInsurance) ? insuranceSnapshot.publicInsurance : [];
  const patient = isPlainObject(receiptDraft.patientSnapshot) ? receiptDraft.patientSnapshot : {};
  const facility = isPlainObject(receiptDraft.facilitySnapshot) ? receiptDraft.facilitySnapshot : {};
  const severityFor = receiptValidationSeverityResolver(context.receiptPolicy);
  const issues = [];

  addReceiptValidationIssue(issues, !facility.medicalInstitutionCode, "facility.medicalInstitutionCode", severityFor("facilityMedicalInstitutionCode", "error"), "医療機関コードが未設定です。");
  addReceiptValidationIssue(issues, !facility.prefectureCode, "facility.prefectureCode", severityFor("facilityPrefectureCode", "warning"), "都道府県コードが未設定です。");
  addReceiptValidationIssue(issues, !patient.displayName, "patient.displayName", severityFor("patientDisplayName", "error"), "患者氏名が未設定です。");
  addReceiptValidationIssue(issues, !patient.sex, "patient.sex", severityFor("patientSex", "warning"), "患者性別が未設定です。");
  addReceiptValidationIssue(issues, !patient.birthDate, "patient.birthDate", severityFor("patientBirthDate", "warning"), "患者生年月日が未設定です。");
  addReceiptValidationIssue(issues, !receiptDraft.serviceDate, "receiptDraft.serviceDate", severityFor("serviceDate", "error"), "診療日が未設定です。");
  addReceiptValidationIssue(issues, !receiptDraft.claimMonth, "receiptDraft.claimMonth", severityFor("claimMonth", "error"), "請求月が未設定です。");
  addReceiptValidationIssue(issues, !insurance.insurerNumber, "insurance.insurerNumber", severityFor("insuranceInsurerNumber", "error"), "保険者番号が未設定です。");
  addReceiptValidationIssue(issues, !insurance.insuredSymbol, "insurance.insuredSymbol", severityFor("insuranceInsuredSymbol", "warning"), "被保険者記号が未設定です。");
  addReceiptValidationIssue(issues, !insurance.insuredNumber, "insurance.insuredNumber", severityFor("insuranceInsuredNumber", "warning"), "被保険者番号が未設定です。");
  addReceiptValidationIssue(issues, !context.connectorSpecVerified, "connector.targetSpec", "warning", "接続先レセコンのCSV/UKE/API仕様が未設定です。実請求前に接続先仕様を確認してください。");

  for (const [index, publicEntry] of publicInsurance.entries()) {
    addReceiptValidationIssue(issues, !publicEntry.payerNumber, `publicInsurance[${index}].payerNumber`, severityFor("publicInsurancePayerNumber", "error"), "公費負担者番号が未設定です。");
    addReceiptValidationIssue(issues, !publicEntry.recipientNumber, `publicInsurance[${index}].recipientNumber`, severityFor("publicInsuranceRecipientNumber", "error"), "公費受給者番号が未設定です。");
  }

  const lines = Array.isArray(receiptDraft.lineGroups)
    ? receiptDraft.lineGroups.flatMap((group) => Array.isArray(group.lines) ? group.lines : [])
    : [];
  addReceiptValidationIssue(issues, receiptDraft.status !== "ready", "receiptDraft.status", "warning", "レセプト案が未算定状態です。");
  for (const [index, line] of lines.entries()) {
    addReceiptValidationIssue(issues, !line.code, `lines[${index}].code`, severityFor("lineCode", "warning"), "診療行為・薬剤・材料コードが未設定の明細があります。");
    addReceiptValidationIssue(issues, Number(line.points || 0) <= 0, `lines[${index}].points`, severityFor("linePoints", "warning"), "点数が0以下の明細があります。");
    addReceiptValidationIssue(issues, !ukeLineRecordId(line.orderType), `lines[${index}].orderType`, severityFor("lineOrderType", "warning"), "レセ電レコード種別を確認してください。");
  }

  for (const [index, comment] of (Array.isArray(context.comments) ? context.comments : []).entries()) {
    addReceiptValidationIssue(issues, !comment.text, `comments[${index}].text`, severityFor("commentText", "error"), "コメント本文が未設定です。");
    addReceiptValidationIssue(issues, !comment.code, `comments[${index}].code`, severityFor("commentCode", "warning"), "コメントコードが未設定です。");
    addReceiptValidationIssue(issues, !comment.shinryoIdentification, `comments[${index}].shinryoIdentification`, severityFor("commentShinryoIdentification", "warning"), "コメントの診療識別が未設定です。");
  }

  for (const [index, detail] of (Array.isArray(context.symptomDetails) ? context.symptomDetails : []).entries()) {
    addReceiptValidationIssue(issues, !detail.text, `symptomDetails[${index}].text`, severityFor("symptomDetailText", "error"), "症状詳記本文が未設定です。");
    addReceiptValidationIssue(issues, !detail.kubun, `symptomDetails[${index}].kubun`, severityFor("symptomDetailKubun", "warning"), "症状詳記区分が未設定です。");
  }

  const blockingIssueCount = issues.filter((issue) => issue.severity === "error").length;
  const warningIssueCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    exportStatus: blockingIssueCount ? "draft" : "ready_for_review",
    label: blockingIssueCount ? "レセ電下書き" : "出力前確認済み",
    blockingIssueCount,
    warningIssueCount,
    issues
  };
}

function receiptValidationSeverityResolver(receiptPolicy = {}) {
  const configured = isPlainObject(receiptPolicy?.validationSeverity) ? receiptPolicy.validationSeverity : {};
  return (key, fallback) => {
    const severity = configured[key] || fallback;
    return ["error", "warning", "off"].includes(severity) ? severity : fallback;
  };
}

function addReceiptValidationIssue(issues, condition, field, severity, message) {
  if (!condition || severity === "off") {
    return;
  }
  issues.push({ field, severity, message });
}

// 窓口一部負担金(会計)を決定論で算出する純関数。
// 入力: セッション(calculationResult.totalPoints / insuranceSnapshot / patientSnapshot.birthDate / serviceDate)
// 高額療養費の自己負担限度額は範囲外(notesに明記)。
export function buildBillingSummary(session = {}, options = {}) {
  const totalPoints = Number(
    options.totalPoints
    ?? session.calculationResult?.totalPoints
    ?? 0
  ) || 0;
  const snapshot = isPlainObject(session.insuranceSnapshot) ? session.insuranceSnapshot : {};
  const insurance = isPlainObject(snapshot.insurance)
    ? snapshot.insurance
    : (isPlainObject(session.insurance) ? session.insurance : {});
  const publicInsurance = Array.isArray(snapshot.publicInsurance) ? snapshot.publicInsurance : [];
  const birthDate = session.patientSnapshot?.birthDate || options.birthDate || null;
  const serviceDate = session.serviceDate || options.serviceDate || snapshot.serviceDate || null;

  const ratio = resolveBurdenRatio({ birthDate, serviceDate, insurance, publicInsurance });
  const totalFee = totalPoints * 10;
  // 現物給付の端数処理: 10円未満四捨五入
  const copay = Math.round((totalFee * ratio.value) / 10) * 10;
  const insurerPay = totalFee - copay;

  const notes = [...ratio.notes, "高額療養費の自己負担限度額は未適用です。"];

  return compactObject({
    totalPoints,
    totalFee,
    burdenRatio: ratio.value,
    burdenRatioSource: ratio.source,
    copay,
    insurerPay,
    publicApplied: ratio.publicApplied,
    notes,
    schemaVersion: 1
  });
}

function resolveBurdenRatio({ birthDate, serviceDate, insurance = {}, publicInsurance = [] } = {}) {
  const notes = [];

  // 1. 公費の負担割合上書きが最優先(priority昇順で最初の override)
  const publicOverride = publicInsurance
    .filter((entry) => isPlainObject(entry) && typeof entry.burdenRatioOverride === "number")
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))[0];
  if (publicOverride) {
    notes.push("公費の負担割合上書きを適用しました。");
    return { value: publicOverride.burdenRatioOverride, source: "public", publicApplied: true, notes };
  }

  // 2. 明示の負担割合
  if (typeof insurance.burdenRatio === "number") {
    return { value: insurance.burdenRatio, source: "explicit", publicApplied: false, notes };
  }

  // 3. 自費は全額自己負担
  if (insurance.insurerType === "jihi") {
    return { value: 1, source: "explicit", publicApplied: false, notes };
  }

  // 4. 年齢から既定割合
  const age = ageAt(birthDate, serviceDate);
  if (age == null) {
    notes.push("生年月日が不明なため負担割合を確定できません。確認してください。");
    return { value: 0.3, source: "default_unknown", publicApplied: false, notes };
  }
  if (isPreschool(birthDate, serviceDate)) {
    return { value: 0.2, source: "age", publicApplied: false, notes }; // 義務教育就学前
  }
  if (age < 70) {
    return { value: 0.3, source: "age", publicApplied: false, notes };
  }
  if (age < 75) {
    notes.push("70〜74歳は原則2割ですが、現役並み所得は3割です。所得区分を確認してください。");
    return { value: 0.2, source: "age", publicApplied: false, notes };
  }
  notes.push("75歳以上は原則1割ですが、一定以上所得は2割・現役並み所得は3割です。所得区分を確認してください。");
  return { value: 0.1, source: "age", publicApplied: false, notes };
}

// YYYY-MM-DD を比較しやすい整数(YYYYMMDD)へ。失敗時 null。
function ymdInt(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!matched) {
    return null;
  }
  return Number(matched[1]) * 10000 + Number(matched[2]) * 100 + Number(matched[3]);
}

function ageAt(birthDate, serviceDate) {
  const birth = ymdInt(birthDate);
  const service = ymdInt(serviceDate);
  if (!birth || !service) {
    return null;
  }
  let age = Math.floor(service / 10000) - Math.floor(birth / 10000);
  if ((service % 10000) < (birth % 10000)) {
    age -= 1;
  }
  return age;
}

// 義務教育就学前: 6歳に達する日以後の最初の3月31日まで。
function isPreschool(birthDate, serviceDate) {
  const birth = ymdInt(birthDate);
  const service = ymdInt(serviceDate);
  if (!birth || !service) {
    return false;
  }
  const birthYear = Math.floor(birth / 10000);
  const birthMonthDay = birth % 10000;
  const sixthBirthday = (birthYear + 6) * 10000 + birthMonthDay;
  const march31SameYear = (birthYear + 6) * 10000 + 331;
  const threshold = sixthBirthday <= march31SameYear
    ? march31SameYear
    : (birthYear + 7) * 10000 + 331;
  return service <= threshold;
}

// レセコン取込用CSV(段階A)。1行=1明細。UTF-8 BOM付き・CRLF。末尾にサマリ。
export function buildReceiptCsv(receiptDraft = {}, context = {}) {
  const insuranceSnapshot = isPlainObject(context.insuranceSnapshot)
    ? context.insuranceSnapshot
    : (isPlainObject(receiptDraft.insuranceSnapshot) ? receiptDraft.insuranceSnapshot : {});
  const insurance = isPlainObject(insuranceSnapshot.insurance) ? insuranceSnapshot.insurance : {};
  const billing = isPlainObject(context.billing)
    ? context.billing
    : (isPlainObject(receiptDraft.billing) ? receiptDraft.billing : {});

  const claimMonth = receiptDraft.claimMonth || "";
  const patientId = receiptDraft.patientId || "";
  const serviceDate = receiptDraft.serviceDate || "";
  const insurerNumber = insurance.insurerNumber || "";
  const insuredSymbol = insurance.insuredSymbol || "";
  const insuredNumber = insurance.insuredNumber || "";
  const burdenRatio = billing.burdenRatio ?? "";

  const header = [
    "claimMonth", "patientId", "serviceDate", "insurerNumber", "insuredSymbol",
    "insuredNumber", "burdenRatio", "receiptCategory", "code", "name", "points", "quantity", "totalPoints"
  ];
  const rows = [header];
  for (const group of Array.isArray(receiptDraft.lineGroups) ? receiptDraft.lineGroups : []) {
    for (const line of Array.isArray(group.lines) ? group.lines : []) {
      rows.push([
        claimMonth, patientId, serviceDate, insurerNumber, insuredSymbol, insuredNumber, burdenRatio,
        group.label || "", line.code || "", line.name || "",
        line.points ?? "", line.quantity ?? "", line.totalPoints ?? ""
      ]);
    }
  }

  const detail = rows.map((row) => row.map(csvField).join(",")).join("\r\n");
  const summary = [
    "",
    ["summary", "totalPoints", "totalFee", "burdenRatio", "copay", "insurerPay"].map(csvField).join(","),
    [
      "",
      billing.totalPoints ?? receiptDraft.totalPoints ?? "",
      billing.totalFee ?? "",
      burdenRatio,
      billing.copay ?? "",
      billing.insurerPay ?? ""
    ].map(csvField).join(",")
  ].join("\r\n");

  return `﻿${detail}\r\n${summary}\r\n`;
}

function csvField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/* ===========================================================================
 * レセプト電算(UKE)出力 — #1段階B
 *
 * レセ電は「カンマ区切り・可変長レコード(改行区切り)」のテキスト。レコード先頭の
 * 2文字識別でレコード種別を表す(IR/RE/HO/KO/SN/SI/IY/TO/CO/SJ ...)。
 *
 * ⚠ 重要: 本実装は「レセプト電算処理システム 記録条件仕様(医科)令和8年6月版」に
 *   準拠することを志向した構造実装。診療識別・負担区分・レセプト種別・各レコードの
 *   項目順/桁は近似を含むため、実請求前に必ず同仕様でフィールド単位の検証を行うこと。
 *   文字コード変換(Shift_JIS)は呼び出し側(fee-api)で行い、ここでは UTF-8 文字列を返す。
 * ========================================================================= */

function ukePad2(value) {
  return String(value).padStart(2, "0");
}

// 元号区分: 令和=5 / 平成=4 / 昭和=3 / 大正=2 / 明治=1
const UKE_ERA_TABLE = [
  { from: 20190501, code: 5, base: 2018 },
  { from: 19890108, code: 4, base: 1988 },
  { from: 19261225, code: 3, base: 1925 },
  { from: 19120730, code: 2, base: 1911 },
  { from: 0, code: 1, base: 1867 }
];

function ukeWarekiParts(ymd) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!matched) {
    return null;
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const numeric = year * 10000 + month * 100 + day;
  const era = UKE_ERA_TABLE.find((entry) => numeric >= entry.from) || UKE_ERA_TABLE[UKE_ERA_TABLE.length - 1];
  return { gengo: era.code, yy: ukePad2(year - era.base), mm: ukePad2(month), dd: ukePad2(day) };
}

// 請求年月/診療年月: 元号区分 + YYMM(5桁)
function ukeWarekiYearMonth(yearMonth) {
  const parts = ukeWarekiParts(`${String(yearMonth || "").slice(0, 7)}-01`);
  return parts ? `${parts.gengo}${parts.yy}${parts.mm}` : "";
}

// 生年月日: 元号区分 + YYMMDD(7桁)
function ukeWarekiDate(ymd) {
  const parts = ukeWarekiParts(ymd);
  return parts ? `${parts.gengo}${parts.yy}${parts.mm}${parts.dd}` : "";
}

function ukeSexCode(sex) {
  if (sex === "male") return "1";
  if (sex === "female") return "2";
  return "";
}

// 審査支払機関: 国保/後期高齢→2(国保連)、それ以外→1(社保基金)
function ukeReviewAgency(insurance = {}) {
  return (insurance.insurerType === "kokuho" || insurance.insurerType === "kouki") ? "2" : "1";
}

// 診療識別(2桁) — orderType ベースの近似。基本料は初診/再診をコード/名称で補正。
const UKE_SHINRYO_ID_BY_ORDER_TYPE = {
  basic: "12",
  imaging: "70",
  lab: "60",
  drug: "21",
  injection: "33",
  treatment: "40",
  procedure: "40",
  material: "80",
  other: "80",
  unknown: "80"
};

function ukeShinryoIdentification(line = {}) {
  const orderType = line.orderType || "unknown";
  if (orderType === "basic") {
    if (String(line.code || "").startsWith("1110") || /初診/.test(line.name || "")) {
      return "11";
    }
    return "12";
  }
  return UKE_SHINRYO_ID_BY_ORDER_TYPE[orderType] || "80";
}

// 負担区分(近似): 医保単独=1。公費併用時は仕様で要精緻化。
function ukeBurdenClass(publicInsurance = []) {
  return Array.isArray(publicInsurance) && publicInsurance.length ? "1" : "1";
}

// レセプト種別(4桁・近似): [点数表=1医科][単独1/2併2/3併3][本人/家族(既定1本人)][入院1/入院外2]
// ※本人/家族・高齢区分は情報不足のため既定値。要・仕様検証。
function ukeReceiptType(receiptDraft = {}, publicInsurance = []) {
  const combination = publicInsurance.length >= 2 ? "3" : publicInsurance.length === 1 ? "2" : "1";
  const receiptType = receiptDraft.receiptType || "";
  const inpatient = receiptType === "medical_inpatient" || receiptType === "medical_dpc" || receiptDraft.setting === "inpatient" ? "1" : "2";
  return `1${combination}1${inpatient}`;
}

function ukeLineRecordId(orderType) {
  if (orderType === "drug") return "IY";
  if (orderType === "material") return "TO";
  return "SI";
}

// receiptDraft + context から UKE レコード配列({ record, fields }) を生成する。
export function buildReceiptDenshin(receiptDraft = {}, context = {}) {
  const insuranceSnapshot = isPlainObject(context.insuranceSnapshot)
    ? context.insuranceSnapshot
    : (isPlainObject(receiptDraft.insuranceSnapshot) ? receiptDraft.insuranceSnapshot : {});
  const insurance = isPlainObject(insuranceSnapshot.insurance) ? insuranceSnapshot.insurance : {};
  const publicInsurance = Array.isArray(insuranceSnapshot.publicInsurance) ? insuranceSnapshot.publicInsurance : [];
  const billing = isPlainObject(context.billing)
    ? context.billing
    : (isPlainObject(receiptDraft.billing) ? receiptDraft.billing : {});
  const patient = isPlainObject(receiptDraft.patientSnapshot) ? receiptDraft.patientSnapshot : {};
  const facility = isPlainObject(receiptDraft.facilitySnapshot) ? receiptDraft.facilitySnapshot : {};

  const claimMonth = receiptDraft.claimMonth || String(receiptDraft.serviceDate || "").slice(0, 7);
  const burdenClass = ukeBurdenClass(publicInsurance);
  const records = [];

  // IR: 医療機関情報
  records.push({
    record: "IR",
    fields: [
      ukeReviewAgency(insurance),
      facility.prefectureCode || "",
      "1", // 点数表: 医科
      facility.medicalInstitutionCode || "",
      "",
      facility.displayName || "",
      ukeWarekiYearMonth(claimMonth)
    ]
  });

  // RE: レセプト共通
  records.push({
    record: "RE",
    fields: [
      "1", // レセプト番号(単票=1)
      ukeReceiptType(receiptDraft, publicInsurance),
      ukeWarekiYearMonth(receiptDraft.serviceDate || claimMonth),
      patient.displayName || "",
      ukeSexCode(patient.sex),
      ukeWarekiDate(patient.birthDate),
      typeof billing.burdenRatio === "number" ? String(Math.round((1 - billing.burdenRatio) * 100)) : ""
    ]
  });

  // HO: 保険者(医保)
  records.push({
    record: "HO",
    fields: [
      insurance.insurerNumber || "",
      insurance.insuredSymbol || "",
      insurance.insuredNumber || "",
      insurance.branchNumber || "",
      String(context.actualDays || 1),
      String(Number(receiptDraft.totalPoints || billing.totalPoints || 0) || 0),
      String(Number(billing.copay || 0) || 0)
    ]
  });

  // KO: 公費(併用分)
  for (const publicEntry of publicInsurance) {
    records.push({
      record: "KO",
      fields: [
        publicEntry.payerNumber || "",
        publicEntry.recipientNumber || "",
        String(context.actualDays || 1),
        String(Number(receiptDraft.totalPoints || 0) || 0),
        ""
      ]
    });
  }

  // SN: 資格確認(任意・context指定時)
  if (isPlainObject(context.eligibility)) {
    records.push({
      record: "SN",
      fields: [
        context.eligibility.verificationType || "",
        context.eligibility.referenceNumber || ""
      ]
    });
  }

  // SI / IY / TO: 診療行為・医薬品・特定器材
  for (const group of Array.isArray(receiptDraft.lineGroups) ? receiptDraft.lineGroups : []) {
    for (const line of Array.isArray(group.lines) ? group.lines : []) {
      records.push({
        record: ukeLineRecordId(line.orderType),
        fields: [
          ukeShinryoIdentification(line),
          burdenClass,
          line.code || "",
          "",
          String(Number(line.points || 0) || 0),
          String(Number(line.quantity || 1) || 1)
        ]
      });
    }
  }

  // CO: コメント(context.comments 指定時)
  for (const comment of Array.isArray(context.comments) ? context.comments : []) {
    records.push({
      record: "CO",
      fields: [
        comment.shinryoIdentification || "",
        burdenClass,
        comment.code || "",
        comment.text || ""
      ]
    });
  }

  // SJ: 症状詳記(context.symptomDetails 指定時)
  for (const detail of Array.isArray(context.symptomDetails) ? context.symptomDetails : []) {
    records.push({
      record: "SJ",
      fields: [
        detail.kubun || "",
        detail.text || ""
      ]
    });
  }

  return records;
}

// UKE レコード配列を UTF-8 テキスト化する。各レコードは「識別,項目...」、行区切りは CRLF。
// 末尾の空項目はレセ電の可変長仕様にあわせて省略する。
export function serializeUke(records = []) {
  const lines = [];
  for (const entry of Array.isArray(records) ? records : []) {
    const fields = Array.isArray(entry.fields) ? [...entry.fields] : [];
    while (fields.length && (fields[fields.length - 1] === "" || fields[fields.length - 1] === null || fields[fields.length - 1] === undefined)) {
      fields.pop();
    }
    const cells = [entry.record, ...fields].map(ukeField);
    lines.push(cells.join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function ukeField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function receiptLineFromCalculationLine(line = {}, index = 0, calculation = {}, decisions = {}) {
  return {
    receiptLineId: line.lineId || `line_${index + 1}`,
    sourceLineId: line.lineId || null,
    code: line.code || null,
    name: line.name || "未分類",
    orderType: line.orderType || "unknown",
    points: Number(line.points || 0),
    quantity: Number(line.quantity || 1),
    totalPoints: Number(line.totalPoints || 0),
    status: line.status || "candidate",
    source: line.source || calculation.source || "fee-core",
    coverage: line.coverage,
    supportLevel: line.supportLevel,
    reviewRequired: line.reviewRequired,
    excludedFromTotal: Boolean(line.excludedFromTotal),
    inclusionStatus: lineInclusionStatus(line, decisions),
    includedInTotal: lineIncludedInTotal(line, decisions)
  };
}

function receiptLineFromProposal(proposal = {}, index = 0, calculation = {}, options = {}) {
  const line = proposal.candidateLine || {};
  const included = options.included === true;
  return {
    receiptLineId: `proposal_${proposal.proposalId || index + 1}`,
    sourceLineId: line.lineId || null,
    sourceProposalId: proposal.proposalId || null,
    reviewItemId: proposalReviewItemId(proposal),
    code: line.code || proposal.code || null,
    name: line.name || proposal.title || "増点提案",
    orderType: line.orderType || proposal.orderType || "other",
    points: Number(line.points || proposal.potentialPoints || 0),
    quantity: Number(line.quantity || 1),
    totalPoints: Number(line.totalPoints || proposal.potentialPoints || 0),
    status: line.status || "candidate",
    source: line.source || proposal.source || calculation.source || "candidate_proposal",
    coverage: line.coverage || null,
    supportLevel: line.supportLevel || "candidate",
    reviewRequired: true,
    inclusionStatus: included ? "included" : "pending",
    includedInTotal: included
  };
}

function receiptTypeFromSession(session = {}) {
  const explicit = String(session.receiptType || session.receipt_type || "").trim();
  if (explicit) {
    return explicit;
  }
  const setting = String(session.setting || "").toLowerCase();
  if (setting.includes("dpc")) {
    return "medical_dpc";
  }
  if (setting.includes("inpatient") || setting.includes("入院")) {
    return "medical_inpatient";
  }
  return "medical_outpatient";
}

function buildReceiptClaimKey({ patientId, claimMonth, receiptType, insuranceSnapshot } = {}) {
  const insurance = isPlainObject(insuranceSnapshot?.insurance) ? insuranceSnapshot.insurance : {};
  const publicInsurance = Array.isArray(insuranceSnapshot?.publicInsurance) ? insuranceSnapshot.publicInsurance : [];
  const publicKey = publicInsurance
    .map((entry) => `${entry?.payerNumber || ""}:${entry?.recipientNumber || ""}`)
    .filter((value) => value !== ":")
    .join("+");
  return [
    patientId || "unknown_patient",
    claimMonth || "unknown_month",
    receiptType || "medical_outpatient",
    insurance.insurerNumber || "unknown_insurer",
    insurance.insuredSymbol || "",
    insurance.insuredNumber || "",
    publicKey
  ].join("|");
}

function receiptLineAggregateKey(line = {}) {
  return [
    line.code || "",
    line.orderType || "",
    line.name || ""
  ].join("|");
}

function receiptLineOccurrenceFromLine(line = {}, session = {}, index = 0, options = {}) {
  const aggregateKey = options.aggregateKey || receiptLineAggregateKey(line);
  const serviceDate = line.serviceDate || line.performedDate || session.serviceDate || null;
  const serviceTime = line.serviceTime || line.performedTime || line.time || null;
  return compactObject({
    occurrenceId: `${session.feeSessionId || "session"}_${line.receiptLineId || line.sourceLineId || line.code || "line"}_${index + 1}`,
    aggregateKey,
    receiptLineId: line.receiptLineId || null,
    sourceLineId: line.sourceLineId || null,
    sourceProposalId: line.sourceProposalId || null,
    feeSessionId: session.feeSessionId || null,
    serviceDate,
    serviceTime,
    departmentName: session.departmentSnapshot?.displayName || session.departmentSnapshot?.name || null,
    code: line.code || null,
    name: line.name || "未分類",
    orderType: line.orderType || "unknown",
    points: Number(line.points || 0),
    quantity: Number(line.quantity || 1),
    totalPoints: Number(line.totalPoints || 0),
    bodySite: line.bodySite || line.body_site || null,
    laterality: line.laterality || null,
    comment: line.comment || line.commentText || line.comment_text || null,
    comments: Array.isArray(line.comments) ? line.comments : undefined,
    supportLevel: line.supportLevel || null,
    reviewRequired: line.reviewRequired ?? null
  });
}

function uniqueSortedStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))].sort();
}

function earliestYmd(current, next) {
  if (!current) {
    return next || null;
  }
  if (!next) {
    return current || null;
  }
  return String(next).localeCompare(String(current)) < 0 ? next : current;
}

export function buildReviewItems(session = {}) {
  const calculation = session.calculationResult || {};
  const decisions = isPlainObject(session.reviewDecisions) ? session.reviewDecisions : {};
  const warnings = Array.isArray(calculation.warnings) ? calculation.warnings : [];
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const candidateProposals = Array.isArray(calculation.candidateProposals) ? calculation.candidateProposals : [];
  const reviewIssues = Array.isArray(calculation.reviewIssues) ? calculation.reviewIssues : [];
  const reviewIssueMessageSet = new Set(reviewIssues
    .map((issue) => String(issue.messageForStaff || "").trim())
    .filter(Boolean));
  const structuredIssueItems = reviewIssues.map((issue) => {
    const reviewItemId = reviewIssueReviewItemId(issue);
    const hiddenFromWorkspace = shouldHideReviewIssueFromWorkspace({ reviewIssue: issue });
    return reviewItem({
      reviewItemId,
      sourceType: "review_issue",
      severity: issue.severity || "warning",
      title: issue.topicLabel || issue.title || reviewWarningTitle(issue.messageForStaff),
      reason: issue.messageForStaff || "確認が必要です。",
      defaultStatus: hiddenFromWorkspace ? "hidden" : "needs_review",
      hiddenFromWorkspace,
      reviewIssue: issue,
      decision: decisions[reviewItemId]
    });
  });
  const warningItems = warnings.map((message, index) => {
    if (reviewIssueMessageSet.has(String(message || "").trim())) {
      return null;
    }
    const reviewItemId = warningReviewItemId(message, index);
    const legacyReviewItemId = legacyWarningReviewItemId(index);
    const hiddenFromWorkspace = shouldHideReviewIssueFromWorkspace({ message });
    return reviewItem({
      reviewItemId,
      legacyReviewItemId,
      sourceType: "warning",
      severity: "warning",
      title: reviewWarningTitle(message),
      reason: message,
      defaultStatus: hiddenFromWorkspace ? "hidden" : "needs_review",
      hiddenFromWorkspace,
      decision: decisions[reviewItemId] || decisions[legacyReviewItemId]
    });
  });
  const proposalItems = candidateProposals.map((proposal) => {
    const reviewItemId = proposalReviewItemId(proposal);
    return reviewItem({
      reviewItemId,
      sourceType: "candidate_proposal",
      severity: "proposal",
      title: proposal.title || proposal.candidateLine?.name || "増点提案",
      reason: proposal.reason || proposal.conditionText || "条件を満たす場合は算定できます。",
      defaultStatus: "needs_review",
      candidateProposal: proposal,
      decision: decisions[reviewItemId]
    });
  });
  const lineReviewItems = lineItems.map((line) => {
    const reviewItemId = lineReviewItemId(line);
    const status = line.status || "candidate";
    const needsReview = ["candidate", "needs_review"].includes(status) || line.reviewRequired === true;
    return reviewItem({
      reviewItemId,
      sourceType: "line_item",
      severity: needsReview ? "review" : "info",
      title: line.name || line.code || "算定候補",
      reason: line.reason || (needsReview ? "算定候補を確認してください。" : "算定中の明細です。必要に応じて外せます。"),
      defaultStatus: needsReview ? "needs_review" : "approved",
      lineItem: line,
      decision: decisions[reviewItemId]
    });
  });

  return [...structuredIssueItems, ...warningItems.filter(Boolean), ...proposalItems, ...lineReviewItems];
}

export function buildCandidateWorkbench(session = {}, options = {}) {
  const receiptDraft = options.receiptDraft || buildReceiptDraft(session, options);
  const reviewItems = options.reviewItems || buildReviewItems(session);
  const reviewItemById = new Map(reviewItems.map((item) => [item.reviewItemId, item]));
  const lineReviewMap = new Map(reviewItems
    .filter((item) => item?.sourceType === "line_item")
    .map((item) => [lineReviewItemId(item.lineItem || {}), item]));
  const lines = (receiptDraft.lines || []).map((line) => {
    const reviewItem = (line.reviewItemId ? reviewItemById.get(line.reviewItemId) : null)
      || lineReviewMap.get(lineReviewItemId({
      lineId: line.sourceLineId,
      code: line.code,
      name: line.name
    }))
      || null;
    const inclusionStatus = line.inclusionStatus || "included";
    const decisionStatus = reviewItem?.decision?.status
      || (inclusionStatus === "excluded" ? "rejected" : inclusionStatus === "pending" ? "edited" : "approved");
    const businessCategory = receiptGroupLabel(line.orderType);
    return {
      kind: "line",
      kindLabel: "算定中の明細",
      reviewItemId: reviewItem?.reviewItemId || lineReviewItemId({
        lineId: line.sourceLineId,
        code: line.code,
        name: line.name
      }),
      sourceReviewItemId: reviewItem?.reviewItemId || null,
      receiptLineId: line.receiptLineId,
      sourceLineId: line.sourceLineId,
      name: line.name || "未分類",
      displayTitle: line.name || "算定候補",
      displayReason: lineDisplayReason(line, reviewItem),
      conditionText: lineConditionText(line),
      decisionStatus,
      inclusionStatus,
      metaLabel: line.code ? `${line.code} / ${businessCategory}` : businessCategory,
      statusLabel: inclusionStatusLabel(inclusionStatus),
      totalPoints: Number(line.totalPoints || 0),
      pointsLabel: `${Number(line.totalPoints || 0).toLocaleString()}点`,
      code: line.code || null,
      orderType: line.orderType || "unknown",
      businessCategory,
      reviewRequired: line.reviewRequired === true,
      sourceProposalId: line.sourceProposalId || null,
      lineItem: line
    };
  });
  const proposalItems = reviewItems.filter((item) => item?.sourceType === "candidate_proposal");
  const warningItems = reviewItems.filter((item) => item?.sourceType === "warning" || item?.sourceType === "review_issue");
  const hiddenIssues = [];
  const visibleWarningItems = [];
  for (const item of warningItems) {
    const normalized = normalizeCandidateActionItem(item);
    if (shouldHideCandidateActionItem(item, normalized)) {
      hiddenIssues.push({
        ...normalized,
        kind: "hidden_issue",
        kindLabel: "非表示の除外理由",
        bucket: "hidden"
      });
    } else {
      visibleWarningItems.push(item);
    }
  }
  attachWarningsToLines(lines, visibleWarningItems);
  const lineTexts = lines.map((line) => `${line.name || ""} ${line.displayTitle || ""}`).join(" ");
  const proposals = [];
  const issues = [];
  const seen = new Set();

  for (const item of proposalItems) {
    if (item.status === "approved") {
      continue;
    }
    const normalized = normalizeCandidateActionItem(item);
    const key = candidateActionSemanticKey(item, normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const actionItem = {
      ...normalized,
      adoptionReason: normalized.canAdopt
        ? "条件を確認して算定する場合は、合計点数に追加できます。"
        : "この提案は条件確認やコード確定が必要なため、現時点では自動で点数に追加しません。"
    };
    const visibleIncreaseOpportunity = Number(normalized.potentialPoints || 0) > 0
      && (normalized.reviewOnly || normalized.actionType === "not_billable_now" || normalized.actionType === "confirm_required");
    if (normalized.canAdopt || visibleIncreaseOpportunity) {
      proposals.push({
        ...actionItem,
        kind: "proposal",
        kindLabel: "増点提案",
        bucket: "proposal",
        canAdopt: normalized.canAdopt
      });
    } else {
      issues.push({
        ...actionItem,
        kind: "issue",
        kindLabel: "確認・修正",
        bucket: "issue"
      });
    }
  }

  for (const item of visibleWarningItems) {
    if (shouldSuppressWarningForExistingLine(item, lineTexts)) {
      continue;
    }
    const normalized = normalizeCandidateActionItem(item);
    const key = candidateActionSemanticKey(item, normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (isIncreaseProposal(item, normalized)) {
      proposals.push({
        ...normalized,
        kind: "proposal",
        kindLabel: "増点提案",
        bucket: "proposal",
        canAdopt: false,
        adoptionReason: "この提案は条件確認やコード確定が必要なため、現時点では自動で点数に追加しません。"
      });
    } else {
      issues.push({
        ...normalized,
        kind: "issue",
        kindLabel: "不足情報・追記",
        bucket: "issue"
      });
    }
  }

  const includedLines = lines.filter((line) => line.inclusionStatus === "included");
  const pendingLines = lines.filter((line) => line.inclusionStatus === "pending");
  const excludedLines = lines.filter((line) => line.inclusionStatus === "excluded");
  const reviewLineCount = includedLines.filter((line) => line.reviewRequired === true).length + pendingLines.length;
  const potentialPointsTotal = proposals
    .filter((item) => item.decisionStatus !== "rejected")
    .reduce((sum, item) => sum + Number(item.potentialPoints || 0), 0);
  const coverageSummary = buildCoverageSummary({
    calculation: session.calculationResult || {},
    includedLines,
    pendingLines,
    excludedLines,
    hiddenIssues,
    proposals,
    issues
  });

  return {
    schemaVersion: 1,
    totalPoints: Number(receiptDraft.totalPoints || 0),
    includedTotalPoints: Number(receiptDraft.totalPoints || 0),
    lines,
    includedLines,
    pendingLines,
    excludedLines,
    hiddenIssues,
    proposals,
    issues,
    counts: {
      included: includedLines.length,
      pending: pendingLines.length,
      excluded: excludedLines.length,
      hidden: hiddenIssues.length,
      proposals: proposals.length,
      issues: issues.length,
      reviewLines: reviewLineCount,
      needsReview: proposals.length + issues.length + reviewLineCount
    },
    coverageSummary,
    potentialPointsTotal,
    includedCount: includedLines.length,
    pendingCount: pendingLines.length,
    excludedCount: excludedLines.length,
    hiddenIssueCount: hiddenIssues.length,
    needsReviewCount: proposals.length + issues.length + reviewLineCount,
    generatedAt: receiptDraft.generatedAt || timestamp(options.now)
  };
}

export function applyReviewDecision(current = {}, reviewItemId, input = {}, options = {}) {
  const decision = validateReviewDecisionInput(input);
  const items = buildReviewItems(current);
  const matchedItem = items.find((item) => (
    item.reviewItemId === reviewItemId || item.legacyReviewItemId === reviewItemId
  ));
  if (!matchedItem) {
    const error = new Error("review item not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }

  const now = timestamp(options.now);
  const reviewDecisions = {
    ...(current.reviewDecisions || {}),
    [matchedItem.reviewItemId]: compactObject({
      ...decision,
      decidedAt: now
    })
  };
  const updated = {
    ...current,
    reviewDecisions,
    updatedAt: now
  };
  const unresolved = buildReviewItems(updated).some((item) => item.status === "needs_review");

  return {
    ...updated,
    status: unresolved ? "needs_review" : "calculated"
  };
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function calculationNeedsReview(calculation) {
  const visibleWarnings = (calculation.warnings || []).filter((message) => !shouldHideReviewIssueFromWorkspace({ message }));
  const visibleReviewIssues = (calculation.reviewIssues || []).filter((issue) => !shouldHideReviewIssueFromWorkspace({ reviewIssue: issue }));
  return visibleWarnings.length > 0
    || (calculation.candidateProposals || []).length > 0
    || visibleReviewIssues.length > 0
    || calculation.coverage?.reviewRequired === true
    || (calculation.lineItems || []).some((line) => {
      const status = line.status || "candidate";
      return ["candidate", "needs_review"].includes(status) || line.reviewRequired === true;
    });
}

function normalizeLineItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item, index) => {
    const points = Number(item.points || 0);
    const quantity = Number(item.quantity || 1);
    const totalPoints = Number(item.totalPoints ?? item.total_points ?? points * quantity);
    const status = item.status || "candidate";
    const source = item.source || "medical_fee_calculation";
    const coverage = normalizeLineCoverage(item.coverage, { ...item, status, source });
    const supportLevel = item.supportLevel || item.support_level || coverage.supportLevel;
    const reviewRequired = coerceBoolean(
      item.reviewRequired ?? item.review_required ?? coverage.reviewRequired,
      ["candidate", "needs_review"].includes(status) || supportLevel === "review_required"
    );
    // エンジンの自動整合(背反・回数・包括・年齢)で合計から除外された行。
    // 削除せず「承認待ち」として保持し、人の承認で再算入できる。
    const excludedFromTotal = coerceBoolean(item.excludedFromTotal ?? item.excluded_from_total, false);
    return compactObject({
      lineId: item.lineId || item.line_id || `line_${index + 1}`,
      code: item.code || null,
      name: item.name || item.label || "未分類",
      orderId: item.orderId || item.order_id,
      orderType: item.orderType || item.order_type || "unknown",
      points,
      quantity,
      excludedFromTotal,
      quantityPerDay: item.quantityPerDay ?? item.quantity_per_day ?? null,
      doseQuantity: item.doseQuantity ?? item.dose_quantity ?? null,
      dosesPerDay: item.dosesPerDay ?? item.doses_per_day ?? null,
      totalQuantity: item.totalQuantity ?? item.total_quantity ?? null,
      days: item.days ?? item.days_supply ?? null,
      dispensingKind: item.dispensingKind || item.dispensing_kind || null,
      shinryoShikibetsu: item.shinryoShikibetsu || item.shinryo_shikibetsu || null,
      unit: item.unit || null,
      totalPoints,
      status,
      reason: item.reason || null,
      source,
      coverage: {
        ...coverage,
        supportLevel,
        support_level: supportLevel,
        reviewRequired,
        review_required: reviewRequired
      },
      supportLevel,
      reviewRequired
    });
  });
}

function normalizeCandidateProposals(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => normalizeCandidateProposal(item, index))
    .filter(Boolean);
}

function normalizeCandidateProposal(item = {}, index = 0) {
  if (!isPlainObject(item)) {
    return null;
  }
  const proposalId = item.proposalId || item.proposal_id || item.id || `proposal_${stableHash(JSON.stringify(item))}`;
  const rawLine = item.candidateLine || item.candidate_line || item.lineItem || item.line_item || null;
  const candidateLine = isPlainObject(rawLine)
    ? normalizeLineItems([{
      ...rawLine,
      lineId: rawLine.lineId || rawLine.line_id || `proposal_line_${proposalId}`,
      status: rawLine.status || "candidate"
    }])[0]
    : null;
  const potentialPoints = Number(
    item.potentialPoints
    ?? item.potential_points
    ?? item.points
    ?? candidateLine?.totalPoints
    ?? 0
  );
  const title = item.title || item.name || candidateLine?.name || "増点提案";
  const reason = item.reason || item.message || item.description || "";
  const conditionText = item.conditionText || item.condition_text || item.condition || "";
  const actionType = item.actionType || item.action_type || (candidateLine && potentialPoints > 0 ? "adoptable" : "confirm_required");

  return compactObject({
    proposalId: String(proposalId),
    title,
    ruleId: item.ruleId || item.rule_id || null,
    reason,
    conditionText,
    basis: item.basis || item.basisText || item.basis_text || null,
    evidence: item.evidence || null,
    actionType,
    potentialPoints,
    code: item.code || candidateLine?.code || null,
    orderType: item.orderType || item.order_type || candidateLine?.orderType || null,
    source: item.source || "candidate_proposal",
    monthlyLimit: isPlainObject(item.monthlyLimit || item.monthly_limit)
      ? item.monthlyLimit || item.monthly_limit
      : null,
    // 1/2区分等でマスタ照合が同点タイの場合の候補コード集合(単一codeは持たない)。
    codeCandidates: Array.isArray(item.codeCandidates ?? item.code_candidates)
      ? (item.codeCandidates ?? item.code_candidates).map((code) => String(code || "")).filter(Boolean)
      : [],
    policy: isPlainObject(item.policy) ? item.policy : null,
    knowledge: isPlainObject(item.knowledge) ? item.knowledge : null,
    resolutionOptions: Array.isArray(item.resolutionOptions || item.resolution_options)
      ? item.resolutionOptions || item.resolution_options
      : [],
    candidateLine,
    sortOrder: Number(item.sortOrder ?? item.sort_order ?? index + 1)
  });
}

function normalizeClinicalEvents(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => {
      if (!isPlainObject(item)) {
        return null;
      }
      return compactObject({
        clinicalEventId: item.clinicalEventId || item.clinical_event_id || `clinical_event_${index + 1}`,
        type: item.type || item.eventType || item.event_type || "other",
        name: item.name || item.eventNameNormalized || item.event_name_normalized || item.eventNameOriginal || item.event_name_original || "",
        actionStatus: item.actionStatus || item.action_status || item.status || "unknown",
        temporalRelation: item.temporalRelation || item.temporal_relation || item.dateRelation || item.date_relation || "unknown",
        sourceOrigin: item.sourceOrigin || item.source_origin || null,
        providerOwnership: item.providerOwnership || item.provider_ownership || null,
        billingDomain: item.billingDomain || item.billing_domain || item.domain || null,
        resultAssertion: item.resultAssertion || item.result_assertion || null,
        certainty: item.certainty || null,
        section: item.section || "unknown",
        evidence: item.evidence || "",
        modality: item.modality || null,
        bodySite: item.bodySite || item.body_site || null,
        specimen: item.specimen || item.sample || item.payload?.specimen || null,
        collectionMethod: item.collectionMethod || item.collection_method || item.payload?.collectionMethod || item.payload?.collection_method || null,
        areaSizeCm2: item.areaSizeCm2 || item.area_size_cm2 || null,
        quantityPerDay: item.quantityPerDay || item.quantity_per_day || null,
        days: item.days || null,
        totalQuantity: item.totalQuantity || item.total_quantity || null,
        searchTerms: Array.isArray(item.searchTerms) ? item.searchTerms.slice(0, 12) : [],
        reviewReason: item.reviewReason || item.review_reason || null,
        source: item.source || item.extractionSource || item.extraction_source || null
      });
    })
    .filter((item) => item && (item.name || item.evidence))
    .slice(0, 120);
}

function normalizeCanonicalClinicalFacts(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => {
      if (!isPlainObject(item)) {
        return null;
      }
      return compactObject({
        factId: item.factId || item.fact_id || `fact_${index + 1}`,
        clinicalEventId: item.clinicalEventId || item.clinical_event_id || null,
        conceptId: item.conceptId || item.concept_id || null,
        eventType: item.eventType || item.event_type || item.type || "other",
        billingDomain: item.billingDomain || item.billing_domain || item.domain || null,
        clinicalName: item.clinicalName || item.clinical_name || item.name || "",
        status: item.status || "unknown",
        actionStatus: item.actionStatus || item.action_status || null,
        temporalRelation: item.temporalRelation || item.temporal_relation || null,
        sourceOrigin: item.sourceOrigin || item.source_origin || null,
        providerOwnership: item.providerOwnership || item.provider_ownership || null,
        resultAssertion: item.resultAssertion || item.result_assertion || null,
        certainty: item.certainty || null,
        evidenceRefs: Array.isArray(item.evidenceRefs || item.evidence_refs)
          ? (item.evidenceRefs || item.evidence_refs).slice(0, 4)
          : [],
        normalization: isPlainObject(item.normalization) ? item.normalization : null,
        extraction: isPlainObject(item.extraction) ? item.extraction : null,
        verification: isPlainObject(item.verification) ? item.verification : null
      });
    })
    .filter((item) => item && (item.clinicalName || item.evidenceRefs.length))
    .slice(0, 160);
}

function normalizeMasterCandidates(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => {
      if (!isPlainObject(item)) {
        return null;
      }
      return compactObject({
        masterCandidateId: item.masterCandidateId || item.master_candidate_id || `master_candidate_${index + 1}`,
        clinicalEventId: item.clinicalEventId || item.clinical_event_id || null,
        sourceFactId: item.sourceFactId || item.source_fact_id || null,
        sourceBillingIntentId: item.sourceBillingIntentId || item.source_billing_intent_id || null,
        masterType: item.masterType || item.master_type || null,
        masterCode: item.masterCode || item.master_code || item.code || null,
        masterName: item.masterName || item.master_name || item.name || null,
        points: Number(item.points || 0),
        category: item.category || null,
        feeCategory: item.feeCategory || item.fee_category || null,
        itemRole: item.itemRole || item.item_role || null,
        directRetrievalAllowed: hasOwn(item, "directRetrievalAllowed")
          ? Boolean(item.directRetrievalAllowed)
          : hasOwn(item, "direct_retrieval_allowed")
            ? Boolean(item.direct_retrieval_allowed)
            : undefined,
        requiresParentCode: hasOwn(item, "requiresParentCode")
          ? Boolean(item.requiresParentCode)
          : hasOwn(item, "requires_parent_code")
            ? Boolean(item.requires_parent_code)
            : undefined,
        derivedOnly: hasOwn(item, "derivedOnly")
          ? Boolean(item.derivedOnly)
          : hasOwn(item, "derived_only")
            ? Boolean(item.derived_only)
            : undefined,
        searchQuery: item.searchQuery || item.search_query || null,
        searchScore: item.searchScore ?? item.search_score ?? null,
        rank: item.rank ?? null,
        candidateStatus: item.candidateStatus || item.candidate_status || null,
        source: item.source || null,
        sourceVersion: item.sourceVersion || item.source_version || null,
        effectiveFrom: item.effectiveFrom || item.effective_from || null,
        effectiveTo: item.effectiveTo || item.effective_to || null,
        generatedBy: item.generatedBy || item.generated_by || null
      });
    })
    .filter((item) => item && item.masterCode)
    .slice(0, 120);
}

function normalizeBillingCandidates(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => {
      if (!isPlainObject(item)) {
        return null;
      }
      return compactObject({
        billingCandidateId: item.billingCandidateId || item.billing_candidate_id || `billing_candidate_${index + 1}`,
        clinicalEventId: item.clinicalEventId || item.clinical_event_id || null,
        sourceFactId: item.sourceFactId || item.source_fact_id || null,
        sourceBillingIntentId: item.sourceBillingIntentId || item.source_billing_intent_id || null,
        masterCandidateId: item.masterCandidateId || item.master_candidate_id || null,
        candidateKind: item.candidateKind || item.candidate_kind || null,
        eligibilityStatus: item.eligibilityStatus || item.eligibility_status || null,
        safetyLevel: item.safetyLevel || item.safety_level || null,
        code: item.code || null,
        name: item.name || null,
        pointValue: Number(item.pointValue ?? item.point_value ?? item.points ?? 0),
        feeCategory: item.feeCategory || item.fee_category || null,
        itemRole: item.itemRole || item.item_role || null,
        generatedBy: item.generatedBy || item.generated_by || null,
        source: item.source || null
      });
    })
    .filter((item) => item && (item.code || item.name))
    .slice(0, 120);
}

function normalizeReviewIssues(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => {
      if (!isPlainObject(item)) {
        return null;
      }
      return compactObject({
        reviewIssueId: item.reviewIssueId || item.review_issue_id || `review_issue_${index + 1}`,
        issueCode: item.issueCode || item.issue_code || "needs_review",
        topicCode: item.topicCode || item.topic_code || null,
        topicLabel: item.topicLabel || item.topic_label || null,
        severity: item.severity || "warning",
        title: item.title || null,
        messageForStaff: item.messageForStaff || item.message_for_staff || item.message || item.reason || "",
        requiredInput: item.requiredInput || item.required_input || null,
        relatedEventId: item.relatedEventId || item.related_event_id || item.relatedClinicalEventId || item.related_clinical_event_id || null,
        relatedClinicalEventId: item.relatedClinicalEventId || item.related_clinical_event_id || item.relatedEventId || item.related_event_id || null,
        sourceFactId: item.sourceFactId || item.source_fact_id || null,
        relatedCandidateId: item.relatedCandidateId || item.related_candidate_id || null,
        evidence: item.evidence || null,
        source: item.source || null,
        assessmentRisk: isPlainObject(item.assessmentRisk || item.assessment_risk) ? item.assessmentRisk || item.assessment_risk : null,
        bodyLateralityCheck: isPlainObject(item.bodyLateralityCheck || item.body_laterality_check) ? item.bodyLateralityCheck || item.body_laterality_check : null,
        policy: isPlainObject(item.policy) ? item.policy : null,
        resolutionOptions: Array.isArray(item.resolutionOptions) ? item.resolutionOptions : []
      });
    })
    .filter((item) => item && item.messageForStaff)
    .slice(0, 120);
}

function normalizeCalculationCoverage(coverage, lineItems, warnings) {
  const input = isPlainObject(coverage) ? coverage : {};
  const reviewLineCount = lineItems.filter((line) => line.reviewRequired === true).length;
  const visibleWarnings = warnings.filter((message) => !shouldHideReviewIssueFromWorkspace({ message }));
  const reviewRequired = coerceBoolean(
    input.reviewRequired ?? input.review_required,
    visibleWarnings.length > 0 || reviewLineCount > 0
  );
  const supportLevel = input.supportLevel || input.support_level || "partial";

  return {
    scope: input.scope || "candidate_review_support",
    chapter: input.chapter || "multi",
    supportLevel,
    support_level: supportLevel,
    reviewRequired,
    review_required: reviewRequired,
    lineCount: Number(input.lineCount ?? input.line_count ?? lineItems.length),
    reviewLineCount: Number(input.reviewLineCount ?? input.review_line_count ?? reviewLineCount),
    reviewMessageCount: Number(input.reviewMessageCount ?? input.review_message_count ?? visibleWarnings.length),
    description: input.description || "This result is a billing candidate and review-support draft. It is not a finalized claim calculation."
  };
}

function normalizeLineCoverage(coverage, item) {
  const input = isPlainObject(coverage) ? coverage : {};
  const source = String(item.source || "medical_fee_calculation");
  const status = String(item.status || "candidate");
  const supportLevel = input.supportLevel || input.support_level || defaultLineSupportLevel(status, source);
  const reviewRequired = coerceBoolean(
    input.reviewRequired ?? input.review_required,
    ["candidate", "needs_review"].includes(status) || supportLevel === "review_required"
  );

  return {
    scope: input.scope || defaultLineCoverageScope(status, source),
    chapter: input.chapter || defaultLineCoverageChapter(source),
    supportLevel,
    support_level: supportLevel,
    reviewRequired,
    review_required: reviewRequired
  };
}

function defaultLineSupportLevel(status, source) {
  if (source === "medical_procedure_master") {
    return "review_required";
  }
  if (status === "confirmed") {
    return "supported";
  }
  if (status === "candidate") {
    return "candidate";
  }
  return "review_required";
}

function defaultLineCoverageScope(status, source) {
  if (source === "medical_procedure_master") {
    return "master_lookup_only";
  }
  if (status === "confirmed") {
    return "deterministic_rule";
  }
  if (status === "candidate") {
    return "candidate_rule";
  }
  return "review_required";
}

function defaultLineCoverageChapter(source) {
  return {
    outpatient_basic_fee: "A_basic_fee",
    outpatient_price_support_add_on: "A_basic_fee",
    outpatient_pediatric_add_on: "A_basic_fee",
    inpatient_basic_fee: "A_inpatient_fee",
    drug_master: "F_drug",
    medication_fee: "F_drug",
    injection_fee: "G_injection",
    treatment_fee: "J_treatment",
    imaging_fee: "E_imaging",
    specific_material_master: "specific_material",
    medical_procedure_master: "procedure_code_master"
  }[source] || "unknown";
}

function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeWarnings(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      return item?.message || item?.reason || "";
    })
    .filter(Boolean);
}

function normalizeEvidence(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item, index) => ({
    evidenceId: item.evidenceId || item.evidence_id || `ev_${index + 1}`,
    text: item.text || item.message || ""
  })).filter((item) => item.text);
}

function groupReceiptLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    const key = line.orderType || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: key,
        label: receiptGroupLabel(key),
        totalPoints: 0,
        lines: []
      });
    }
    const group = groups.get(key);
    group.totalPoints += line.totalPoints;
    group.lines.push(line);
  }

  return [...groups.values()];
}

function receiptGroupLabel(orderType) {
  return {
    basic: "基本料",
    lab: "検査",
    drug: "投薬",
    injection: "注射",
    material: "特定器材",
    treatment: "処置",
    imaging: "画像",
    procedure: "手技",
    other: "その他",
    unknown: "未分類"
  }[orderType] || orderType;
}

function reviewItem(input) {
  const decision = isPlainObject(input.decision) ? input.decision : null;
  const reviewIssue = isPlainObject(input.reviewIssue) ? input.reviewIssue : null;
  const candidateProposal = isPlainObject(input.candidateProposal) ? input.candidateProposal : null;
  return compactObject({
    reviewItemId: input.reviewItemId,
    legacyReviewItemId: input.legacyReviewItemId,
    sourceType: input.sourceType,
    severity: input.severity,
    title: input.title,
    reason: input.reason,
    status: decision?.status || input.defaultStatus || "needs_review",
    issueCode: input.issueCode || reviewIssue?.issueCode || reviewIssue?.issue_code || null,
    topicCode: input.topicCode || reviewIssue?.topicCode || reviewIssue?.topic_code || null,
    topicLabel: input.topicLabel || reviewIssue?.topicLabel || reviewIssue?.topic_label || null,
    source: input.source || reviewIssue?.source || candidateProposal?.source || null,
    policy: input.policy || reviewIssue?.policy || candidateProposal?.policy || null,
    hiddenFromWorkspace: input.hiddenFromWorkspace === true,
    requiredInput: input.requiredInput || reviewIssue?.requiredInput || reviewIssue?.required_input || candidateProposal?.policy?.requiredInput || null,
    resolutionOptions: Array.isArray(input.resolutionOptions)
      ? input.resolutionOptions
      : Array.isArray(reviewIssue?.resolutionOptions)
        ? reviewIssue.resolutionOptions
        : Array.isArray(candidateProposal?.resolutionOptions)
          ? candidateProposal.resolutionOptions
          : [],
    decision,
    lineItem: input.lineItem,
    candidateProposal: input.candidateProposal,
    reviewIssue: input.reviewIssue
  });
}

function warningReviewItemId(message = "", index = 0) {
  const normalized = String(message || "").trim() || `warning_${index + 1}`;
  return `warning_${stableHash(normalized)}`;
}

function legacyWarningReviewItemId(index = 0) {
  return `warning_${index + 1}`;
}

function lineReviewItemId(line = {}) {
  return `line_${line.lineId || line.code || line.name}`;
}

function proposalReviewItemId(proposal = {}) {
  return `proposal_${proposal.proposalId || stableHash(`${proposal.title || ""}:${proposal.code || ""}`)}`;
}

function reviewIssueReviewItemId(issue = {}) {
  return `issue_${issue.reviewIssueId || stableHash(`${issue.issueCode || ""}:${issue.messageForStaff || ""}`)}`;
}

function lineDecision(line = {}, decisions = {}) {
  return decisions[lineReviewItemId(line)] || null;
}

function lineInclusionStatus(line = {}, decisions = {}) {
  const status = lineDecision(line, decisions)?.status;
  if (status === "rejected") return "excluded";
  if (status === "edited") return "pending";
  // エンジンの自動整合(背反・回数・包括・年齢)で除外された行は、
  // 人が承認するまで合計に入れない(承認で再算入できる)。
  if (line.excludedFromTotal) {
    return status === "approved" ? "included" : "pending";
  }
  return "included";
}

function lineIncludedInTotal(line = {}, decisions = {}) {
  return lineInclusionStatus(line, decisions) === "included";
}

function proposalDecision(proposal = {}, decisions = {}) {
  return decisions[proposalReviewItemId(proposal)] || null;
}

function proposalIncludedInTotal(proposal = {}, decisions = {}) {
  return proposalDecision(proposal, decisions)?.status === "approved"
    && isPlainObject(proposal.candidateLine)
    && Number(proposal.potentialPoints || proposal.candidateLine?.totalPoints || 0) > 0;
}

function proposalIsReviewOnly(proposal = {}) {
  return proposal.policy?.riskGate === "review_only"
    || proposal.actionType === "review_only"
    || proposal.actionType === "not_billable_now";
}

function receiptLineSemanticKey(line = {}) {
  return `${line.code || ""}:${line.name || ""}:${line.orderType || ""}`;
}

function reviewWarningTitle(message = "") {
  const text = String(message || "");
  if (/同日複数処置の確認|Exclusion candidate/i.test(text)) {
    return "同日複数処置の確認";
  }
  if (/院内処方の薬剤情報確認|In-house medication fee requires drug inputs/i.test(text)) {
    return "院内処方の薬剤情報確認";
  }
  const topicLabel = text.match(/^([^\s:：]{2,20}確認)\s*[:：]/u)?.[1];
  if (topicLabel) {
    return topicLabel;
  }
  if (/施設基準|facility_standard|hospital_profile_missing/u.test(text)) {
    return "施設基準確認";
  }
  if (/レセプトコメント|Required comment|コメント/u.test(text)) {
    return "レセプトコメントの確認";
  }
  if (/外来迅速|rapid lab/u.test(text)) {
    return "外来迅速検体検査加算の確認";
  }
  if (/D026|検査判断料|judgement fee/u.test(text)) {
    return "判断料確認";
  }
  if (/静脈採血|採血|blood_venous|Collection fee/u.test(text)) {
    return "採血料確認";
  }
  if (/CT|ＣＴ|MRI|ＭＲＩ|画像|Imaging fee/u.test(text)) {
    return "画像診断料の確認";
  }
  if (/単純X線|単純x線|X線|x線|レントゲン|simple_radiography/u.test(text)) {
    return "単純X線の撮影条件確認";
  }
  if (/初診|再診|受診履歴|Outpatient basic/u.test(text)) {
    return "初再診料の確認";
  }
  if (/投薬|処方料|調剤料|Medication fee/u.test(text)) {
    return "投薬料の確認";
  }
  const drugName = text.match(/薬剤「([^」]+)」/u)?.[1];
  if (drugName) {
    return `${drugName}の確認`;
  }
  return "確認事項";
}

function normalizeCandidateActionItem(item = {}) {
  const proposal = item.candidateProposal || null;
  const reviewIssue = item.reviewIssue || null;
  const issueCode = item.issueCode || reviewIssue?.issueCode || reviewIssue?.issue_code || null;
  const policy = item.policy || reviewIssue?.policy || proposal?.policy || null;
  const source = item.source || reviewIssue?.source || proposal?.source || null;
  const displayTitle = item.title || proposal?.title || reviewWarningTitle(item.reason || "");
  const displayReason = humanizeReviewMessage(item.reason || proposal?.reason || "");
  const conditionText = proposal?.conditionText || structuredReviewConditionText({ issueCode, policy, reviewIssue }) || proposalConditionText(displayTitle, displayReason);
  const requiredInput = item.requiredInput || item.required_input || reviewIssue?.requiredInput || reviewIssue?.required_input || proposal?.policy?.requiredInput || proposal?.requiredInput || null;
  const resolutionOptions = Array.isArray(item.resolutionOptions)
    ? item.resolutionOptions
    : Array.isArray(reviewIssue?.resolutionOptions)
      ? reviewIssue.resolutionOptions
      : Array.isArray(proposal?.resolutionOptions)
        ? proposal.resolutionOptions
        : [];
  const potentialPoints = proposal?.potentialPoints || proposalPotentialPoints(item, displayTitle, displayReason);
  const hasCandidateLine = isPlainObject(proposal?.candidateLine) || isPlainObject(item.lineItem);
  const reviewOnly = isReviewOnlyPolicy({ issueCode, policy });
  const actionType = reviewOnly
    ? "not_billable_now"
    : proposal?.actionType || (hasCandidateLine && potentialPoints > 0 ? "adoptable" : "confirm_required");
  const canAdopt = actionType === "adoptable" && hasCandidateLine && Number(potentialPoints || 0) > 0;
  const issueCategory = issueCategoryForActionItem(item, { displayTitle, displayReason, conditionText, issueCode, policy });
  return {
    reviewItemId: item.reviewItemId,
    legacyReviewItemId: item.legacyReviewItemId,
    issueCode,
    displayTitle,
    displayReason,
    conditionText,
    requiredInput,
    resolutionOptions,
    reasonText: displayReason,
    pointsLabel: pointsLabelForPotential(potentialPoints),
    potentialPoints,
    actionType,
    nextActionLabel: canAdopt
      ? `算定する +${Number(potentialPoints || 0).toLocaleString()}点`
      : actionType === "select_required"
        ? "候補を選ぶ"
        : actionType === "not_billable_now"
          ? "人手で確認"
          : "条件を確認",
    canAdopt,
    reviewOnly,
    issueCategory: issueCategory.key,
    issueCategoryLabel: issueCategory.label,
    status: item.status || "needs_review",
    decisionStatus: item.decision?.status || item.status || "needs_review",
    sourceType: item.sourceType || "warning",
    hiddenFromWorkspace: item.hiddenFromWorkspace === true,
    source,
    policy,
    assessmentRisk: reviewIssue?.assessmentRisk || reviewIssue?.assessment_risk || null,
    bodyLateralityCheck: reviewIssue?.bodyLateralityCheck || reviewIssue?.body_laterality_check || null,
    candidateLine: proposal?.candidateLine || item.lineItem || null,
    candidateProposal: proposal,
    reviewIssue,
    sourceItem: item
  };
}

function shouldHideCandidateActionItem(item = {}, normalized = {}) {
  if (item.hiddenFromWorkspace === true || normalized.hiddenFromWorkspace === true) {
    return true;
  }
  const issueCode = normalized.issueCode || item.issueCode || item.reviewIssue?.issueCode || item.reviewIssue?.issue_code || "";
  if (hiddenWorkspaceIssueCodes().has(String(issueCode || "").trim())) {
    return true;
  }
  const text = [
    normalized.displayTitle,
    normalized.displayReason,
    normalized.conditionText,
    item.title,
    item.reason,
    item.reviewIssue?.messageForStaff,
    item.reviewIssue?.evidence
  ].filter(Boolean).join(" ");
  return isHiddenWorkspaceReviewText(text);
}

function shouldHideReviewIssueFromWorkspace({ reviewIssue = null, message = "" } = {}) {
  const issueCode = reviewIssue?.issueCode || reviewIssue?.issue_code || "";
  if (hiddenWorkspaceIssueCodes().has(String(issueCode || "").trim())) {
    return true;
  }
  if (reviewIssue?.policy?.riskGate === "hidden") {
    return true;
  }
  const reasons = Array.isArray(reviewIssue?.policy?.reasons) ? reviewIssue.policy.reasons : [];
  if (reasons.some((reason) => [
    "negated_service_context",
    "future_or_order_only_context",
    "past_or_external_context"
  ].includes(String(reason || "")))) {
    return true;
  }
  const text = [
    message,
    reviewIssue?.title,
    reviewIssue?.messageForStaff,
    reviewIssue?.evidence
  ].filter(Boolean).join(" ");
  if (isMissingDiagnosisReviewText(text)) {
    return true;
  }
  if (isFacilityStandardReviewText(text)) {
    return true;
  }
  return isHiddenWorkspaceReviewText(text);
}

function hiddenWorkspaceIssueCodes() {
  return new Set([
    "facility_unknown",
    "hospital_profile_missing",
    "facility_standard_not_found",
    "planned_not_performed",
    "instruction_only",
    "other_provider",
    "past_or_carried_in",
    "unsupported_event"
  ]);
}

function isFacilityStandardReviewText(text = "") {
  return /施設基準|地方厚生局|届け出|届出|facility_standard|hospital_profile/u.test(String(text || ""));
}

function isMissingDiagnosisReviewText(text = "") {
  return /病名が入力されていません|病名が未入力|病名未入力|算定根拠として使う病名が未入力/u.test(String(text || ""));
}

function isHiddenWorkspaceReviewText(text = "") {
  const value = String(text || "");
  if (!value) {
    return false;
  }
  if (/(施行せず|実施せず|未実施|未施行|行わず|行っていない|施行していない|実施していない|撮影せず|検査せず|中止|否定)/u.test(value)) {
    return true;
  }
  if (/(他科|他院|他施設|他医療機関|過去値|持参情報|既往薬|内服中|今後の予定|予定・依頼|予定|依頼|検討).{0,40}(算定候補には入れていません|自動算定には入れていません|今回算定候補には入れていません)/u.test(value)) {
    return true;
  }
  if (/(現在の自動算定では直接候補化できない|現在の算定ルールで直接候補化できない|未対応項目|算定候補には入れていません)/u.test(value)
    && !/(コメント|症状詳記|病名|適応|施設基準|数量|日数|総量|1回量|1日回数|部位|左右|機器区分|造影|受付時刻|同月|管理料|指導料|採血|検体採取)/u.test(value)) {
    return true;
  }
  return false;
}

function issueCategoryForActionItem(item = {}, normalized = {}) {
  const issueCode = normalized.issueCode || item.issueCode || item.reviewIssue?.issueCode || item.reviewIssue?.issue_code || "";
  const structuredCategory = issueCategoryForCode(issueCode);
  if (structuredCategory) {
    return structuredCategory;
  }
  const text = [
    normalized.displayTitle,
    normalized.displayReason,
    normalized.conditionText,
    item.title,
    item.reason,
    item.candidateProposal?.conditionText,
    item.lineItem?.name
  ].filter(Boolean).join(" ");
  if (/施設基準|地方厚生局|届け出|届出|facility_standard|hospital_profile/u.test(text)) {
    return { key: "facility", label: "施設設定" };
  }
  if (/病名|傷病名|コメント|適応|査定/u.test(text)) {
    return { key: "diagnosis", label: "病名・コメント" };
  }
  if (/薬剤|処方|数量|日数|総量|1回量|1日回数/u.test(text)) {
    return { key: "medication", label: "薬剤情報" };
  }
  if (/標準コード|マスター|コード確定|候補を選ぶ|検索/u.test(text)) {
    return { key: "master", label: "マスター確認" };
  }
  if (/実施|予定|依頼|オーダー|検討|指導のみ|説明のみ|当日/u.test(text)) {
    return { key: "evidence", label: "実施確認" };
  }
  if (/未入力|不足|入力|空欄/u.test(text)) {
    return { key: "input", label: "入力不足" };
  }
  return { key: "rule", label: "算定条件" };
}

function issueCategoryForCode(issueCode = "") {
  return {
    facility_unknown: { key: "facility", label: "施設設定" },
    hospital_profile_missing: { key: "facility", label: "施設設定" },
    management_fee_review_required: { key: "management", label: "管理料" },
    same_month_unknown: { key: "management", label: "同月履歴" },
    specimen_collection_fee_review_required: { key: "specimen", label: "検体採取" },
    specimen_submission_check: { key: "unsupported", label: "病理・検体提出" },
    pathology_unsupported: { key: "unsupported", label: "病理" },
    emergency_addon_review_required: { key: "time", label: "救急・時間外" },
    missing_reception_time: { key: "time", label: "受付時刻" },
    ambiguous_master: { key: "master", label: "マスター確認" },
    master_not_found: { key: "master", label: "マスター確認" },
    missing_quantity: { key: "medication", label: "数量・日数" },
    missing_body_site: { key: "input", label: "部位・範囲" },
    claim_risk_body_site_mismatch: { key: "claim-risk", label: "査定リスク" },
    claim_risk_laterality_mismatch: { key: "claim-risk", label: "査定リスク" },
    claim_risk_indication_check: { key: "claim-risk", label: "査定リスク" },
    missing_equipment_kind: { key: "input", label: "機器区分" },
    missing_inpatient_days: { key: "input", label: "入院日数" },
    missing_ward_type: { key: "input", label: "病棟区分" },
    contrast_unknown: { key: "imaging", label: "造影確認" },
    planned_not_performed: { key: "evidence", label: "実施確認" },
    instruction_only: { key: "evidence", label: "実施確認" },
    other_provider: { key: "evidence", label: "他科・他院" },
    past_or_carried_in: { key: "evidence", label: "過去値・持参" },
    unsupported_event: { key: "unsupported", label: "未対応項目" }
  }[String(issueCode || "").trim()] || null;
}

function isReviewOnlyPolicy({ issueCode = "", policy = null } = {}) {
  if (policy?.riskGate === "review_only") {
    return true;
  }
  return [
    "management_fee_review_required",
    "pathology_unsupported",
    "specimen_submission_check",
    "emergency_addon_review_required",
    "missing_reception_time"
  ].includes(String(issueCode || "").trim());
}

function structuredReviewConditionText({ issueCode = "", policy = null, reviewIssue = null } = {}) {
  if (issueCode === "management_fee_review_required" || policy?.riskGate === "review_only") {
    if (issueCode === "pathology_unsupported" || issueCode === "specimen_submission_check") {
      return "病理診断・細胞診は自動で点数に入れていません。検体提出、標本種類、診断区分を人手で確認してください。";
    }
    if (issueCode === "emergency_addon_review_required" || issueCode === "missing_reception_time") {
      return "救急・時間外・休日・深夜加算は自動で点数に入れていません。受付時刻、診療体制、休日/時間外条件を人手で確認してください。";
    }
    return "管理料は自動で点数に入れていません。対象疾患、管理主体、同月履歴、施設基準、指導・説明の記録を人手で確認してください。";
  }
  if (issueCode === "specimen_collection_fee_review_required") {
    return "検体採取料は検査本体から自動算定していません。検体、採取方法、同日算定条件を確認してください。";
  }
  if (reviewIssue?.requiredInput) {
    return `確認する情報: ${reviewIssue.requiredInput}`;
  }
  return "";
}

function lineDisplayReason(line = {}, reviewItem = null) {
  const reason = humanizeReviewMessage(reviewItem?.reason || line.reason || "");
  if (reason && reason !== "算定候補の内容を確認してください。") {
    return reason;
  }
  return `${line.name || "この明細"}を候補化しています。条件に合わない場合は「算定しない」に変更してください。`;
}

function lineConditionText(line = {}) {
  const category = receiptGroupLabel(line.orderType);
  if (category === "基本料") return "受診履歴と初診/再診の条件を確認してください。";
  if (category === "画像") return "実施済みの検査であること、撮影内容、機器区分を確認してください。";
  if (category === "投薬") return "今回処方した薬剤・日数・数量を確認してください。";
  if (category === "検査" || category === "手技" || category === "処置") return "当日に実施した内容であること、必要なコメントや病名を確認してください。";
  return "カルテ内容と算定条件を確認してください。";
}

function inclusionStatusLabel(status) {
  return {
    included: "算定中",
    excluded: "算定しない",
    pending: "確認中"
  }[status] || "算定中";
}

function isIncreaseProposal(item = {}, normalized = {}) {
  return normalized.canAdopt === true
    && !["approved", "rejected", "edited"].includes(normalized.decisionStatus)
    && item.sourceType === "candidate_proposal";
}

function proposalConditionText(title = "", reason = "") {
  const text = `${title} ${reason}`;
  if (/施設基準|届け出|届出/u.test(text)) {
    return "施設基準を地方厚生局に届け出済みなら、該当する加算を算定できます。";
  }
  if (/MRI|CT|画像|撮影/u.test(text)) {
    return "実際に当日実施した検査なら算定できます。予定や依頼だけの場合は算定しないに変更してください。";
  }
  if (/薬剤|処方|数量|日数/u.test(text)) {
    return "必要な情報: 1回量、1日回数、日数または総量。例: 60mg 1日2回 7日分。入力後に薬剤料などを再計算できます。";
  }
  if (/病名|コメント/u.test(text)) {
    return "必要な病名またはレセプトコメントを確認・追記できれば算定できます。";
  }
  return "条件を満たす場合は算定できます。満たさない場合は算定しないに変更してください。";
}

function proposalPotentialPoints(item = {}, title = "", reason = "") {
  const linePoints = Number(item.lineItem?.totalPoints || 0);
  if (linePoints > 0) return linePoints;
  const match = `${title} ${reason}`.match(/([+＋]\s*)?(\d{1,4})\s*点/u);
  return match ? Number(match[2]) : null;
}

function proposalPointsLabel(item = {}, title = "", reason = "") {
  const points = proposalPotentialPoints(item, title, reason);
  return pointsLabelForPotential(points);
}

function pointsLabelForPotential(points) {
  return points ? `+${points.toLocaleString()}点` : "";
}

function shouldSuppressWarningForExistingLine(item = {}, lineTexts = "") {
  const text = `${item.title || ""} ${item.reason || ""}`;
  if (isVisitFeeReviewText(text) && /初診料|再診料|基本料/u.test(lineTexts)) {
    return true;
  }
  const drugName = text.match(/薬剤「([^」]+)」/u)?.[1];
  if (drugName && /数量|日数|不足/u.test(text)) {
    return lineTexts.includes(drugName);
  }
  return false;
}

function attachWarningsToLines(lines = [], warningItems = []) {
  if (!Array.isArray(lines) || !Array.isArray(warningItems)) {
    return;
  }
  const basicLine = lines.find((line) => /初診料|再診料/u.test(`${line.name || ""} ${line.displayTitle || ""}`));
  if (!basicLine) {
    return;
  }
  for (const item of warningItems) {
    const text = `${item.title || ""} ${item.reason || ""}`;
    if (!shouldAttachWarningToBasicFeeLine(text)) {
      continue;
    }
    const note = humanizeReviewMessage(item.reason || "");
    basicLine.attentionNotes = uniqueCompact([...(basicLine.attentionNotes || []), note]);
    if (!basicLine.displayReason || /受診履歴と初診\/再診|候補化しています/u.test(basicLine.displayReason)) {
      basicLine.displayReason = note;
    }
  }
}

function shouldAttachWarningToBasicFeeLine(text = "") {
  const normalized = String(text || "");
  if (/施設基準|facility_standard|hospital_profile|今後の予定|予定|次回|訪問診療|往診|在宅医療/u.test(normalized)) {
    return false;
  }
  return isVisitFeeReviewText(normalized);
}

function isVisitFeeReviewText(text = "") {
  return /初診|再診|受診履歴|過去算定記録|Outpatient basic/u.test(String(text || ""));
}

function buildCoverageSummary({ calculation = {}, includedLines = [], pendingLines = [], excludedLines = [], hiddenIssues = [], proposals = [], issues = [] } = {}) {
  const supportLevel = calculation.coverage?.supportLevel || calculation.coverage?.support_level || "partial";
  const includedScopeLabels = uniqueCompact(includedLines.map((line) => line.businessCategory || receiptGroupLabel(line.orderType)));
  const excludedScopeLabels = uniqueCompact(excludedLines.map((line) => line.businessCategory || receiptGroupLabel(line.orderType)));
  const pendingScopeLabels = uniqueCompact(pendingLines.map((line) => line.businessCategory || receiptGroupLabel(line.orderType)));
  const unresolvedCount = proposals.length + issues.length + pendingLines.length;
  const description = supportLevel === "supported"
    ? "候補化できた算定行の合計です。確定請求前に採否と根拠を確認してください。"
    : "現在のカルテとマスター照合から候補化できた範囲の合計です。未確認項目は確定前に確認してください。";
  return compactObject({
    title: "候補化済み部分合計",
    supportLevel,
    supportLevelLabel: supportLevel === "supported" ? "対応範囲内" : "部分対応",
    description,
    includedScopeLabels,
    pendingScopeLabels,
    excludedScopeLabels,
    hiddenIssueCount: hiddenIssues.length,
    unresolvedCount,
    badges: [
      ...includedScopeLabels.map((label) => `${label}を候補化`),
      unresolvedCount > 0 ? `未処理 ${unresolvedCount}件` : "追加対応なし"
    ]
  });
}

function uniqueCompact(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function candidateActionSemanticKey(item = {}, normalized = {}) {
  const text = `${normalized.displayTitle || ""} ${normalized.displayReason || ""} ${item.title || ""} ${item.reason || ""}`.toLowerCase();
  const exclusion = parseElectronicExclusionMessage(text);
  if (exclusion) return `warning:electronic_exclusion:${[exclusion.baseCode, exclusion.excludedCode].sort().join(":")}`;
  const normalizedExclusion = text.match(/同日複数処置の確認\s*[:：]\s*(.+?)と(.+?)を同日に算定/u);
  if (normalizedExclusion) return `warning:electronic_exclusion:${[normalizeSemanticToken(normalizedExclusion[1]), normalizeSemanticToken(normalizedExclusion[2])].sort().join(":")}`;
  if (/施設基準|hospital_profile_missing|facility_standard/u.test(text)) return "warning:facility_standard";
  if (/mri|ｍｒｉ/u.test(text) && /予定|依頼|オーダー|planned|ordered/u.test(text)) return "warning:mri_planned";
  if (/単純x線|x線|レントゲン|simple_radiography/u.test(text) && /撮影方式|写真診断|機器|条件/u.test(text)) return "warning:simple_radiography_condition";
  const drugName = text.match(/薬剤「([^」]+)」/u)?.[1];
  if (drugName && /数量|日数|不足/u.test(text)) return `warning:drug_quantity:${normalizeSemanticToken(drugName)}`;
  return `${item.sourceType || "review"}:${normalized.displayTitle || ""}:${normalized.displayReason || ""}`;
}

function humanizeReviewMessage(message = "") {
  const raw = String(message || "").trim();
  if (!raw) return "算定候補の内容を確認してください。";
  const text = raw.replace(/^[a-z][a-z0-9_]*:\s*/iu, "").trim();
  const exclusion = parseElectronicExclusionMessage(text);
  if (exclusion) {
    return `同日複数処置の確認: ${exclusion.baseName}と${exclusion.excludedName}を同日に算定しています。別部位・別創傷として処置した根拠を確認してください。`;
  }
  if (/In-house medication fee requires drug inputs/i.test(text)) {
    return "院内処方の薬剤情報確認: 薬剤料を計算するには、薬剤名、用量、日数または総量が必要です。";
  }
  if (/hospital_profile_missing|facility_standard|Lab management fee skipped|施設基準がない|施設基準/u.test(raw)) {
    return "施設基準が登録されていないため、施設基準が必要な加算は自動追加していません。";
  }
  if (/This result is a billing candidate/i.test(text)) {
    return "この結果は算定候補です。確定請求前に内容を確認してください。";
  }
  if (/Input drug code; medical drug fee rounded/i.test(text)) {
    return "入力された薬剤コードから薬剤料を候補化しました。薬価合計を点数に換算しています。";
  }
  if (/Medication fee candidate for in_house/i.test(text)) {
    return "院内処方に関する投薬料候補です。処方内容と算定条件を確認してください。";
  }
  if (/D026 judgement fee for group/i.test(text)) {
    return "判断料確認: 検査判断料の候補です。実施検査と同月算定条件を確認してください。";
  }
  if (/Collection fee requested by blood_venous/i.test(text)) {
    return "採血料確認: 静脈採血料の候補です。採血実施と算定条件を確認してください。";
  }
  if (/Outpatient rapid lab add-on skipped/i.test(text)) {
    return "外来迅速検体検査加算は、当日説明・文書要件を確認できないため自動追加していません。";
  }
  if (/レセプトコメント|Required comment candidate|必要なコメント/u.test(text)) {
    return humanReadableRequiredCommentMessage(text);
  }
  if (/Imaging fee skipped: duplicate imaging order/i.test(text)) {
    return "画像診断の重複候補を除外しました。必要な撮影だけが算定されているか確認してください。";
  }
  if (/Imaging fee candidate for simple_radiography/i.test(text)) {
    return "単純X線に関する画像診断料候補です。撮影方式と写真診断区分を確認してください。";
  }
  if (/Imaging fee candidate for ct/i.test(text)) {
    return "CT撮影に関する画像診断料候補です。撮影内容と機器区分を確認してください。";
  }
  if (/Imaging fee candidate for mri/i.test(text)) {
    return "MRI撮影に関する画像診断料候補です。撮影内容と機器区分を確認してください。";
  }
  if (/Outpatient basic fee candidate for initial/i.test(text)) {
    return "初診料の候補です。受診履歴と初診の条件を確認してください。";
  }
  if (/Outpatient basic fee candidate for revisit/i.test(text)) {
    return "再診料の候補です。受診履歴と再診の条件を確認してください。";
  }
  if (/Input medical procedure code matched master only/i.test(text)) {
    return "標準マスターには一致しましたが、章ごとの算定条件は未確認です。";
  }
  return text;
}

function parseElectronicExclusionMessage(value = "") {
  const match = String(value || "").match(/Exclusion candidate:\s*(\d{6,})\s+(.+?)\s+and\s+(\d{6,})\s+(.+?)\s+matched from\s+(.+)$/iu);
  if (!match) {
    return null;
  }
  return {
    baseCode: match[1],
    baseName: String(match[2] || "").trim(),
    excludedCode: match[3],
    excludedName: String(match[4] || "").trim(),
    matchedFrom: String(match[5] || "").trim()
  };
}

function humanReadableRequiredCommentMessage(value = "") {
  const text = String(value || "").trim();
  const target = text.match(/(?:レセプトコメントの確認\s*[:：]\s*)?(.+?)\s*に必要なコメント/u)?.[1]
    || text.match(/^Required comment candidate:\s*(.+?)\s+needs\s+/iu)?.[1]
    || "";
  const prefix = target ? `${target.replace(/\b\d{6,}\b/gu, "").trim()}: ` : "";
  if (/創傷処置|熱傷処置|皮膚科軟膏処置|爪甲除去|デブリードマン/u.test(text)) {
    return `${prefix}同日に複数の創傷・熱傷などの処置を算定する場合は、部位・面積・処置内容が分かるレセプトコメントを確認してください。`;
  }
  if (/複数診療科で処方/u.test(text)) {
    return `${prefix}複数診療科で処方している場合は、その旨をレセプトコメントに記載してください。`;
  }
  if (/[１1]を算定しない理由/u.test(text)) {
    return `${prefix}処方料1を算定しない理由を確認し、該当する場合は理由をレセプトコメントに記載してください。`;
  }
  return `${prefix}レセプトコメントの要否を確認し、必要な理由を記載してください。`;
}

function stableHash(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function normalizeSemanticToken(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} is required`);
    error.name = "ValidationError";
    error.statusCode = 400;
    error.field = field;
    throw error;
  }

  return value.trim();
}

function optionalString(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function timestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value || new Date().toISOString();
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => compactObject(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compactObject(item)])
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function feeSessionHasRequiredCalculationContext(session = {}) {
  return Boolean(session.patientId && session.facilityId && session.serviceDate);
}

// ── 導入前 一括レセプト差分診断(Phase B / fee-web側) ──────────────────
// engineClaim(=保存済みの当社算定結果)と baselineClaim(=アップロードした既存レセ)を
// 患者×月で突合し、算定もれ候補/要確認/検討の3分類にする。Python版 baseline_diagnosis と同義。
export const BASELINE_DIFF_CATEGORY = Object.freeze({
  MISSING: "missing_candidate",
  REVIEW: "needs_review",
  CONSIDER: "consider"
});

const BASELINE_DIFF_CATEGORY_LABELS = Object.freeze({
  missing_candidate: "算定もれ候補",
  needs_review: "要確認",
  consider: "検討"
});

export const BASELINE_COMPARISON_STATUS = Object.freeze({
  BASELINE_ONLY: "baseline_only",
  ENGINE_ONLY: "engine_only",
  BOTH_DELTA: "both_delta",
  MATCHED: "matched"
});

const BASELINE_COMPARISON_STATUS_LABELS = Object.freeze({
  baseline_only: "既存のみ",
  engine_only: "当社のみ",
  both_delta: "両方差分あり",
  matched: "一致"
});

// engineClaim に含める(=当社が前に出す)ステータス。confirmed以外は低確信扱い。
const ENGINE_INCLUDED_STATUSES = new Set(["confirmed", "candidate", "needs_review"]);

export function baselineDiffCategoryLabel(category) {
  return BASELINE_DIFF_CATEGORY_LABELS[category] || category;
}

export function baselineComparisonStatusLabel(status) {
  return BASELINE_COMPARISON_STATUS_LABELS[status] || status;
}


function normalizeBaselineCode(code, codeMap) {
  const raw = String(code || "").trim();
  if (codeMap && Object.prototype.hasOwnProperty.call(codeMap, raw)) {
    return String(codeMap[raw]).trim();
  }
  return raw;
}

function aggregateBaselineLines(lines, codeMap) {
  const aggregated = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const code = normalizeBaselineCode(line.code, codeMap);
    if (!code) {
      continue;
    }
    const points = line.totalPoints != null
      ? Number(line.totalPoints) || 0
      : (Number(line.points || 0) || 0) * (Number(line.count ?? line.quantity ?? 1) || 0);
    const entry = aggregated.get(code) || { code, name: "", count: 0, totalPoints: 0 };
    if (!entry.name && line.name) {
      entry.name = line.name;
    }
    entry.count += Number(line.count ?? line.quantity ?? 1) || 0;
    entry.totalPoints += points;
    aggregated.set(code, entry);
  }
  return aggregated;
}

// 月次の各セッションの算定結果(lineItems)から engineClaim を組み立てる(患者×月)。
export function engineClaimFromSessions(sessions = [], { patientId = "", claimMonth = "" } = {}) {
  const aggregated = new Map();
  const lowConfidence = new Set();
  const confirmed = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const lines = Array.isArray(session?.calculationResult?.lineItems) ? session.calculationResult.lineItems : [];
    for (const line of lines) {
      const status = String(line.status || "candidate");
      if (!ENGINE_INCLUDED_STATUSES.has(status)) {
        continue;
      }
      const code = String(line.code || "").trim();
      if (!code) {
        continue;
      }
      const entry = aggregated.get(code) || { code, name: line.name || "", points: Number(line.points || 0) || 0, count: 0 };
      entry.count += Number(line.quantity || 1) || 0;
      aggregated.set(code, entry);
      if (status === "confirmed") {
        confirmed.add(code);
      } else {
        lowConfidence.add(code);
      }
    }
  }
  for (const code of confirmed) {
    lowConfidence.delete(code);
  }
  return {
    patientId,
    claimMonth,
    lines: [...aggregated.values()],
    lowConfidenceCodes: [...lowConfidence]
  };
}

export function buildBaselineDiagnosis(baseline = {}, engine = {}, options = {}) {
  const knownUnsupported = new Set(options.knownUnsupportedCodes || []);
  const lowConfidence = new Set(engine.lowConfidenceCodes || []);
  const codeMap = options.codeMap || null;
  const tolerance = Number(options.pointTolerance || 0);
  const base = aggregateBaselineLines(baseline.lines, codeMap);
  const eng = aggregateBaselineLines(engine.lines, codeMap);
  const findings = [];
  const comparisonRows = [];

  const push = (category, code, name, points, side, reason) => {
    findings.push({
      category,
      categoryLabel: baselineDiffCategoryLabel(category),
      code,
      name: name || "",
      points: Number(points) || 0,
      estimatedYen: estimateReceiptYen(points),
      side,
      reason
    });
  };
  const pushComparison = ({
    comparisonStatus,
    category = "",
    code,
    name,
    baselineEntry = null,
    engineEntry = null,
    points = 0,
    side = "",
    reason = ""
  }) => {
    comparisonRows.push({
      comparisonStatus,
      comparisonStatusLabel: baselineComparisonStatusLabel(comparisonStatus),
      category,
      categoryLabel: category ? baselineDiffCategoryLabel(category) : baselineComparisonStatusLabel(comparisonStatus),
      code,
      name: name || baselineEntry?.name || engineEntry?.name || "",
      points: Number(points) || 0,
      estimatedYen: estimateReceiptYen(points),
      baselinePoints: Number(baselineEntry?.totalPoints || 0) || 0,
      enginePoints: Number(engineEntry?.totalPoints || 0) || 0,
      deltaPoints: (Number(engineEntry?.totalPoints || 0) || 0) - (Number(baselineEntry?.totalPoints || 0) || 0),
      baselineCount: Number(baselineEntry?.count || 0) || 0,
      engineCount: Number(engineEntry?.count || 0) || 0,
      side,
      reason
    });
  };

  const codes = [...new Set([...base.keys(), ...eng.keys()])].sort();
  for (const code of codes) {
    const b = base.get(code);
    const e = eng.get(code);
    if (e && !b) {
      if (lowConfidence.has(code)) {
        push(BASELINE_DIFF_CATEGORY.CONSIDER, code, e.name, e.totalPoints, "engine_only", "低確信の当社候補");
        pushComparison({
          comparisonStatus: BASELINE_COMPARISON_STATUS.ENGINE_ONLY,
          category: BASELINE_DIFF_CATEGORY.CONSIDER,
          code,
          name: e.name,
          engineEntry: e,
          points: e.totalPoints,
          side: "engine_only",
          reason: "低確信の当社候補"
        });
      } else {
        push(BASELINE_DIFF_CATEGORY.MISSING, code, e.name, e.totalPoints, "engine_only", "当社再算定では候補だが既存レセに無い");
        pushComparison({
          comparisonStatus: BASELINE_COMPARISON_STATUS.ENGINE_ONLY,
          category: BASELINE_DIFF_CATEGORY.MISSING,
          code,
          name: e.name,
          engineEntry: e,
          points: e.totalPoints,
          side: "engine_only",
          reason: "当社再算定では候補だが既存レセに無い"
        });
      }
    } else if (b && !e) {
      if (knownUnsupported.has(code)) {
        push(BASELINE_DIFF_CATEGORY.CONSIDER, code, b.name, b.totalPoints, "baseline_only", "当社未対応領域の可能性");
        pushComparison({
          comparisonStatus: BASELINE_COMPARISON_STATUS.BASELINE_ONLY,
          category: BASELINE_DIFF_CATEGORY.CONSIDER,
          code,
          name: b.name,
          baselineEntry: b,
          points: b.totalPoints,
          side: "baseline_only",
          reason: "当社未対応領域の可能性"
        });
      } else {
        push(BASELINE_DIFF_CATEGORY.REVIEW, code, b.name, b.totalPoints, "baseline_only", "既存にあり当社で再現せず（当社未対応の可能性／既存の過剰の可能性）");
        pushComparison({
          comparisonStatus: BASELINE_COMPARISON_STATUS.BASELINE_ONLY,
          category: BASELINE_DIFF_CATEGORY.REVIEW,
          code,
          name: b.name,
          baselineEntry: b,
          points: b.totalPoints,
          side: "baseline_only",
          reason: "既存にあり当社で再現せず（当社未対応の可能性／既存の過剰の可能性）"
        });
      }
    } else if (b && e) {
      const delta = e.totalPoints - b.totalPoints;
      if (Math.abs(delta) <= tolerance) {
        pushComparison({
          comparisonStatus: BASELINE_COMPARISON_STATUS.MATCHED,
          code,
          name: e.name || b.name,
          baselineEntry: b,
          engineEntry: e,
          points: 0,
          side: "both",
          reason: "既存レセと当社再算定が一致"
        });
        continue;
      }
      if (delta > 0) {
        push(BASELINE_DIFF_CATEGORY.MISSING, code, e.name || b.name, delta, "both", "当社再算定の方が回数/点数が多い");
        pushComparison({
          comparisonStatus: BASELINE_COMPARISON_STATUS.BOTH_DELTA,
          category: BASELINE_DIFF_CATEGORY.MISSING,
          code,
          name: e.name || b.name,
          baselineEntry: b,
          engineEntry: e,
          points: delta,
          side: "both",
          reason: "当社再算定の方が回数/点数が多い"
        });
      } else {
        push(BASELINE_DIFF_CATEGORY.REVIEW, code, e.name || b.name, Math.abs(delta), "both", "既存の方が回数/点数が多い（当社未対応の可能性／既存の過剰の可能性）");
        pushComparison({
          comparisonStatus: BASELINE_COMPARISON_STATUS.BOTH_DELTA,
          category: BASELINE_DIFF_CATEGORY.REVIEW,
          code,
          name: e.name || b.name,
          baselineEntry: b,
          engineEntry: e,
          points: Math.abs(delta),
          side: "both",
          reason: "既存の方が回数/点数が多い（当社未対応の可能性／既存の過剰の可能性）"
        });
      }
    }
  }

  const baselineTotal = baseline.totalPoints != null
    ? Number(baseline.totalPoints) || 0
    : [...base.values()].reduce((sum, entry) => sum + entry.totalPoints, 0);
  const engineTotal = engine.totalPoints != null
    ? Number(engine.totalPoints) || 0
    : [...eng.values()].reduce((sum, entry) => sum + entry.totalPoints, 0);

  return {
    patientId: baseline.patientId || engine.patientId || null,
    claimMonth: baseline.claimMonth || engine.claimMonth || null,
    findings,
    comparisonRows,
    baselineTotalPoints: baselineTotal,
    engineTotalPoints: engineTotal
  };
}

// 月次点検向け: セッション群(engineClaim源)とアップロードした baselineClaims を患者×月で突合。
export function buildMonthlyBaselineDiagnosis({ sessions = [], baselineClaims = [], claimMonth = "", knownUnsupportedCodes = [], codeMap = null } = {}) {
  const month = baselineClaimMonth({ claimMonth });
  const sessionsByKey = new Map();
  const baselineByKey = new Map();

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const patientId = String(session?.patientId || "").trim();
    const sessionMonth = baselineClaimMonth(session, month);
    if (!patientId || (month && sessionMonth !== month)) {
      continue;
    }
    const key = monthlyBaselineKey(patientId, sessionMonth);
    const entry = sessionsByKey.get(key) || { patientId, claimMonth: sessionMonth, sessions: [] };
    entry.sessions.push(session);
    sessionsByKey.set(key, entry);
  }

  for (const claim of Array.isArray(baselineClaims) ? baselineClaims : []) {
    const patientId = String(claim?.patientId ?? claim?.patient_id ?? "").trim();
    const baselineMonth = baselineClaimMonth(claim, month);
    if (!patientId || (month && baselineMonth !== month)) {
      continue;
    }
    const key = monthlyBaselineKey(patientId, baselineMonth);
    const normalized = normalizeBaselineClaimForDiagnosis(claim, { patientId, claimMonth: baselineMonth });
    const current = baselineByKey.get(key);
    baselineByKey.set(key, current ? mergeBaselineClaims(current, normalized) : normalized);
  }

  const keys = [...new Set([...baselineByKey.keys(), ...sessionsByKey.keys()])].sort();
  const diagnoses = keys.map((key) => {
    const sessionEntry = sessionsByKey.get(key);
    const baseline = baselineByKey.get(key);
    const patientId = sessionEntry?.patientId || baseline?.patientId || "";
    const diagnosisMonth = sessionEntry?.claimMonth || baseline?.claimMonth || month;
    const engine = engineClaimFromSessions(sessionEntry?.sessions || [], { patientId, claimMonth: diagnosisMonth });
    return buildBaselineDiagnosis(
      baseline || { patientId, claimMonth: diagnosisMonth, lines: [] },
      engine,
      { knownUnsupportedCodes, codeMap }
    );
  });

  const countCategory = (category) => diagnoses.reduce(
    (sum, diagnosis) => sum + diagnosis.findings.filter((finding) => finding.category === category).length,
    0
  );
  const countComparisonStatus = (status) => diagnoses.reduce(
    (sum, diagnosis) => sum + (diagnosis.comparisonRows || []).filter((row) => row.comparisonStatus === status).length,
    0
  );
  const missingPoints = diagnoses.reduce(
    (sum, diagnosis) => sum + diagnosis.findings.filter((finding) => finding.category === BASELINE_DIFF_CATEGORY.MISSING).reduce((acc, finding) => acc + finding.points, 0),
    0
  );

  return {
    claimMonth: month || null,
    patientCount: diagnoses.length,
    diagnoses,
    summary: {
      missingCandidateCount: countCategory(BASELINE_DIFF_CATEGORY.MISSING),
      missingCandidatePoints: missingPoints,
      missingCandidateEstimatedYen: estimateReceiptYen(missingPoints),
      needsReviewCount: countCategory(BASELINE_DIFF_CATEGORY.REVIEW),
      considerCount: countCategory(BASELINE_DIFF_CATEGORY.CONSIDER),
      baselineOnlyCount: countComparisonStatus(BASELINE_COMPARISON_STATUS.BASELINE_ONLY),
      engineOnlyCount: countComparisonStatus(BASELINE_COMPARISON_STATUS.ENGINE_ONLY),
      bothDiffCount: countComparisonStatus(BASELINE_COMPARISON_STATUS.BOTH_DELTA),
      matchedCount: countComparisonStatus(BASELINE_COMPARISON_STATUS.MATCHED)
    }
  };
}

function monthlyBaselineKey(patientId, claimMonth) {
  return `${String(patientId || "").trim()}\u0000${String(claimMonth || "").trim()}`;
}

function baselineClaimMonth(value = {}, fallback = "") {
  const raw = String(
    value.claimMonth
    ?? value.claim_month
    ?? (value.serviceDate ? String(value.serviceDate).slice(0, 7) : "")
    ?? fallback
    ?? ""
  ).trim();
  return raw ? raw.slice(0, 7) : String(fallback || "").trim().slice(0, 7);
}

function normalizeBaselineClaimForDiagnosis(claim = {}, fallback = {}) {
  const patientId = String(claim.patientId ?? claim.patient_id ?? fallback.patientId ?? "").trim();
  const claimMonth = baselineClaimMonth(claim, fallback.claimMonth);
  const lines = Array.isArray(claim.lines)
    ? claim.lines
    : (Array.isArray(claim.lineItems) ? claim.lineItems : []);
  return {
    ...claim,
    patientId,
    claimMonth,
    lines
  };
}

function mergeBaselineClaims(left = {}, right = {}) {
  const totalLeft = Number(left.totalPoints ?? left.total_points);
  const totalRight = Number(right.totalPoints ?? right.total_points);
  return {
    ...left,
    ...right,
    patientId: left.patientId || right.patientId,
    claimMonth: left.claimMonth || right.claimMonth,
    lines: [...(Array.isArray(left.lines) ? left.lines : []), ...(Array.isArray(right.lines) ? right.lines : [])],
    ...(Number.isFinite(totalLeft) || Number.isFinite(totalRight)
      ? { totalPoints: (Number.isFinite(totalLeft) ? totalLeft : 0) + (Number.isFinite(totalRight) ? totalRight : 0) }
      : {})
  };
}
