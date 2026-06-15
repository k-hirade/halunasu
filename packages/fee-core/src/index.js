import crypto from "node:crypto";
import {
  validateReviewDecisionInput
} from "../../fee-contracts/src/index.js";

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
    facilityId: facilityId || null,
    facilitySnapshot: input.facilitySnapshot || null,
    departmentId: input.departmentId || null,
    departmentSnapshot: input.departmentSnapshot || null,
    createdByMemberId: requiredString(input.createdByMemberId, "createdByMemberId"),
    status,
    serviceDate,
    claimMonth: input.claimMonth || serviceDate.slice(0, 7),
    setting: input.setting || "outpatient",
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

  if (!hasOwn(patch, "status") && ["draft", "ready", "failed", "calculated", "needs_review"].includes(current.status || "")) {
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

  return {
    receiptDraftId: `receipt_${requiredString(session.feeSessionId, "feeSessionId")}`,
    feeSessionId: session.feeSessionId,
    orgId: requiredString(session.orgId, "orgId"),
    patientId: session.patientId || null,
    patientRef: session.patientRef || session.patientId,
    facilitySnapshot: session.facilitySnapshot || null,
    departmentSnapshot: session.departmentSnapshot || null,
    serviceDate: requiredString(session.serviceDate, "serviceDate"),
    claimMonth: session.claimMonth || String(session.serviceDate).slice(0, 7),
    setting: session.setting || "outpatient",
    status: calculation.status ? "ready" : "not_calculated",
    exportStatus: "draft",
    totalPoints: Number(includedLines.reduce((sum, line) => sum + line.totalPoints, 0)),
    lines,
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
    return reviewItem({
      reviewItemId,
      sourceType: "review_issue",
      severity: issue.severity || "warning",
      title: issue.topicLabel || issue.title || reviewWarningTitle(issue.messageForStaff),
      reason: issue.messageForStaff || "確認が必要です。",
      defaultStatus: "needs_review",
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
    return reviewItem({
      reviewItemId,
      legacyReviewItemId,
      sourceType: "warning",
      severity: "warning",
      title: reviewWarningTitle(message),
      reason: message,
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
  attachWarningsToLines(lines, warningItems);
  const lineTexts = lines.map((line) => `${line.name || ""} ${line.displayTitle || ""}`).join(" ");
  const proposals = [];
  const issues = [];
  const seen = new Set();

  for (const item of proposalItems) {
    if (item.status === "approved" || item.status === "rejected") {
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

  for (const item of warningItems) {
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
        kindLabel: "確認・修正",
        bucket: "issue"
      });
    }
  }

  const includedLines = lines.filter((line) => line.inclusionStatus === "included");
  const pendingLines = lines.filter((line) => line.inclusionStatus === "pending");
  const excludedLines = lines.filter((line) => line.inclusionStatus === "excluded");
  const reviewLineCount = includedLines.filter((line) => line.reviewRequired === true).length + pendingLines.length;
  const potentialPointsTotal = proposals.reduce((sum, item) => sum + Number(item.potentialPoints || 0), 0);
  const coverageSummary = buildCoverageSummary({
    calculation: session.calculationResult || {},
    includedLines,
    pendingLines,
    excludedLines,
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
    proposals,
    issues,
    counts: {
      included: includedLines.length,
      pending: pendingLines.length,
      excluded: excludedLines.length,
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
  return (calculation.warnings || []).length > 0
    || (calculation.candidateProposals || []).length > 0
    || (calculation.reviewIssues || []).length > 0
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
    return compactObject({
      lineId: item.lineId || item.line_id || `line_${index + 1}`,
      code: item.code || null,
      name: item.name || item.label || "未分類",
      orderId: item.orderId || item.order_id,
      orderType: item.orderType || item.order_type || "unknown",
      points,
      quantity,
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
    reason,
    conditionText,
    basis: item.basis || item.basisText || item.basis_text || null,
    evidence: item.evidence || null,
    actionType,
    potentialPoints,
    code: item.code || candidateLine?.code || null,
    orderType: item.orderType || item.order_type || candidateLine?.orderType || null,
    source: item.source || "candidate_proposal",
    policy: isPlainObject(item.policy) ? item.policy : null,
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
  const reviewRequired = coerceBoolean(
    input.reviewRequired ?? input.review_required,
    warnings.length > 0 || reviewLineCount > 0
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
    reviewMessageCount: Number(input.reviewMessageCount ?? input.review_message_count ?? warnings.length),
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
  return "included";
}

function lineIncludedInTotal(line = {}, decisions = {}) {
  return lineInclusionStatus(line, decisions) === "included";
}

function proposalDecision(proposal = {}, decisions = {}) {
  return decisions[proposalReviewItemId(proposal)] || null;
}

function proposalIncludedInTotal(proposal = {}, decisions = {}) {
  if (proposalIsReviewOnly(proposal)) {
    return false;
  }
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
    source,
    policy,
    candidateLine: proposal?.candidateLine || item.lineItem || null,
    candidateProposal: proposal,
    reviewIssue,
    sourceItem: item
  };
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
    pending: "保留"
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
    return "実際に当日実施した検査なら算定できます。予定や依頼だけの場合は保留にしてください。";
  }
  if (/薬剤|処方|数量|日数/u.test(text)) {
    return "必要な情報: 1回量、1日回数、日数または総量。例: 60mg 1日2回 7日分。入力後に薬剤料などを再計算できます。";
  }
  if (/病名|コメント/u.test(text)) {
    return "必要な病名またはレセプトコメントを確認・追記できれば算定できます。";
  }
  return "条件を満たす場合は算定できます。満たさない場合は保留にしてください。";
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
    if (!isVisitFeeReviewText(text)) {
      continue;
    }
    const note = humanizeReviewMessage(item.reason || "");
    basicLine.attentionNotes = uniqueCompact([...(basicLine.attentionNotes || []), note]);
    if (!basicLine.displayReason || /受診履歴と初診\/再診|候補化しています/u.test(basicLine.displayReason)) {
      basicLine.displayReason = note;
    }
  }
}

function isVisitFeeReviewText(text = "") {
  return /初診|再診|受診履歴|過去算定記録|Outpatient basic/u.test(String(text || ""));
}

function buildCoverageSummary({ calculation = {}, includedLines = [], pendingLines = [], excludedLines = [], proposals = [], issues = [] } = {}) {
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
    unresolvedCount,
    badges: [
      ...includedScopeLabels.map((label) => `${label}を候補化`),
      unresolvedCount > 0 ? `要確認 ${unresolvedCount}件` : "追加確認なし"
    ]
  });
}

function uniqueCompact(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function candidateActionSemanticKey(item = {}, normalized = {}) {
  const text = `${normalized.displayTitle || ""} ${normalized.displayReason || ""} ${item.title || ""} ${item.reason || ""}`.toLowerCase();
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
  if (/Required comment candidate:/i.test(text)) {
    return text
      .replace(/^Required comment candidate:\s*/iu, "レセプトコメントの確認: ")
      .replace(/\s+needs\s+/iu, " に必要なコメント: ");
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
