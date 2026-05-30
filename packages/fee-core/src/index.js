import crypto from "node:crypto";
import {
  validateReviewDecisionInput
} from "../../fee-contracts/src/index.js";

export function buildFeeSession(input = {}, options = {}) {
  const now = timestamp(options.now);
  const feeSessionId = options.feeSessionId || createId("fee");

  return compactObject({
    feeSessionId,
    sessionId: feeSessionId,
    orgId: requiredString(input.orgId, "orgId"),
    patientId: requiredString(input.patientId, "patientId"),
    patientRef: input.patientRef || input.patientId,
    patientSnapshot: input.patientSnapshot || null,
    facilityId: requiredString(input.facilityId, "facilityId"),
    facilitySnapshot: input.facilitySnapshot || null,
    departmentId: input.departmentId || null,
    departmentSnapshot: input.departmentSnapshot || null,
    createdByMemberId: requiredString(input.createdByMemberId, "createdByMemberId"),
    status: input.status || "ready",
    serviceDate: requiredString(input.serviceDate, "serviceDate"),
    claimMonth: input.claimMonth || String(input.serviceDate).slice(0, 7),
    setting: input.setting || "outpatient",
    clinicalText: input.clinicalText || "",
    orders: Array.isArray(input.orders) ? input.orders : [],
    diagnoses: Array.isArray(input.diagnoses) ? input.diagnoses : [],
    insurance: input.insurance || null,
    sourceSystem: input.sourceSystem || null,
    calculationResult: input.calculationResult || null,
    latestCalculationId: null,
    reviewDecisions: {},
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });
}

export function applyCalculationResult(current = {}, calculationResult = {}, options = {}) {
  const normalizedResult = normalizeCalculationResult(current, calculationResult, options);
  const now = timestamp(options.now);
  const status = calculationNeedsReview(normalizedResult) ? "needs_review" : "calculated";

  return {
    ...current,
    status,
    calculationResult: normalizedResult,
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

  return compactObject({
    calculationId: options.calculationId || createId("calc"),
    feeSessionId: requiredString(session.feeSessionId, "feeSessionId"),
    orgId: requiredString(session.orgId, "orgId"),
    patientId: requiredString(session.patientId, "patientId"),
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
    messages: Array.isArray(calculation.messages) ? calculation.messages : [],
    evidence: normalizeEvidence(calculation.evidence || []),
    inputCodes: Array.isArray(calculation.inputCodes) ? calculation.inputCodes : calculation.input_codes || [],
    candidateCodes: Array.isArray(calculation.candidateCodes) ? calculation.candidateCodes : calculation.candidate_codes || [],
    rawResult: isPlainObject(calculation.rawResult) ? calculation.rawResult : undefined,
    generatedAt: now,
    schemaVersion: 1
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
    source: line.source || calculation.source || "fee-core"
  }));

  return {
    receiptDraftId: `receipt_${requiredString(session.feeSessionId, "feeSessionId")}`,
    feeSessionId: session.feeSessionId,
    orgId: requiredString(session.orgId, "orgId"),
    patientId: requiredString(session.patientId, "patientId"),
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
    .filter((line) => ["candidate", "needs_review"].includes(line.status || "candidate"))
    .map((line) => reviewItem({
      reviewItemId: `line_${line.lineId || line.code || line.name}`,
      sourceType: "line_item",
      severity: "review",
      title: line.name || line.code || "算定候補",
      reason: "算定候補を確認してください。",
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
    || (calculation.lineItems || []).some((line) => ["candidate", "needs_review"].includes(line.status || "candidate"));
}

function normalizeLineItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item, index) => {
    const points = Number(item.points || 0);
    const quantity = Number(item.quantity || 1);
    const totalPoints = Number(item.totalPoints ?? item.total_points ?? points * quantity);
    return compactObject({
      lineId: item.lineId || item.line_id || `line_${index + 1}`,
      code: item.code || null,
      name: item.name || item.label || "未分類",
      orderId: item.orderId || item.order_id,
      orderType: item.orderType || item.order_type || "unknown",
      points,
      quantity,
      totalPoints,
      status: item.status || "candidate",
      reason: item.reason || null,
      source: item.source || "medical_fee_calculation"
    });
  });
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
