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
    clinicalText: input.clinicalText || "",
    orders: Array.isArray(input.orders) ? input.orders : [],
    diagnoses: Array.isArray(input.diagnoses) ? input.diagnoses : [],
    insurance: input.insurance || null,
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
      serviceDate: patch.serviceDate,
      claimMonth: patch.claimMonth || (patch.serviceDate ? String(patch.serviceDate).slice(0, 7) : undefined),
      setting: patch.setting,
      clinicalText: hasOwn(patch, "clinicalText") ? patch.clinicalText || "" : undefined,
      orders: hasOwn(patch, "orders") ? patch.orders : undefined,
      diagnoses: hasOwn(patch, "diagnoses") ? patch.diagnoses : undefined,
      insurance: hasOwn(patch, "insurance") ? patch.insurance || null : undefined,
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
    "clinicalText",
    "orders",
    "diagnoses",
    "insurance"
  ].some((key) => hasOwn(patch, key));

  if (changedCalculationInput && (next.calculationResult || next.calculationSummary)) {
    next.calculationResult = null;
    next.calculationSummary = null;
    next.latestCalculationId = null;
  }

  if (["draft", "ready", "failed", "calculated", "needs_review"].includes(current.status || "")) {
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
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const warnings = Array.isArray(calculation.warnings) ? calculation.warnings : [];
  const lines = lineItems.map((line, index) => ({
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
    reviewRequired: line.reviewRequired
  }));

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
    totalPoints: Number(calculation.totalPoints || lines.reduce((sum, line) => sum + line.totalPoints, 0)),
    lines,
    lineGroups: groupReceiptLines(lines),
    validationIssues: warnings.map((message, index) => ({
      issueId: `warning_${index + 1}`,
      severity: "warning",
      message
    })),
    generatedAt: timestamp(options.now || calculation.generatedAt),
    schemaVersion: 1
  };
}

export function buildReviewItems(session = {}) {
  const calculation = session.calculationResult || {};
  const decisions = isPlainObject(session.reviewDecisions) ? session.reviewDecisions : {};
  const warnings = Array.isArray(calculation.warnings) ? calculation.warnings : [];
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  const warningItems = warnings.map((message, index) => reviewItem({
    reviewItemId: `warning_${index + 1}`,
    sourceType: "warning",
    severity: "warning",
    title: "算定警告",
    reason: message,
    decision: decisions[`warning_${index + 1}`]
  }));
  const lineReviewItems = lineItems
    .filter((line) => {
      const status = line.status || "candidate";
      return ["candidate", "needs_review"].includes(status) || line.reviewRequired === true;
    })
    .map((line) => reviewItem({
      reviewItemId: `line_${line.lineId || line.code || line.name}`,
      sourceType: "line_item",
      severity: "review",
      title: line.name || line.code || "算定候補",
      reason: line.reason || "算定候補を確認してください。",
      lineItem: line,
      decision: decisions[`line_${line.lineId || line.code || line.name}`]
    }));

  return [...warningItems, ...lineReviewItems];
}

export function applyReviewDecision(current = {}, reviewItemId, input = {}, options = {}) {
  const decision = validateReviewDecisionInput(input);
  const items = buildReviewItems(current);
  const exists = items.some((item) => item.reviewItemId === reviewItemId);
  if (!exists) {
    const error = new Error("review item not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }

  const now = timestamp(options.now);
  const reviewDecisions = {
    ...(current.reviewDecisions || {}),
    [reviewItemId]: {
      ...decision,
      decidedAt: now
    }
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
    treatment: "処置",
    imaging: "画像",
    procedure: "手技",
    other: "その他",
    unknown: "未分類"
  }[orderType] || orderType;
}

function reviewItem(input) {
  const decision = isPlainObject(input.decision) ? input.decision : null;
  return compactObject({
    reviewItemId: input.reviewItemId,
    sourceType: input.sourceType,
    severity: input.severity,
    title: input.title,
    reason: input.reason,
    status: decision?.status || "needs_review",
    decision,
    lineItem: input.lineItem
  });
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
