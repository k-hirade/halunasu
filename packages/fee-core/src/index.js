import crypto from "node:crypto";
import {
  validateCreateMockCalculationInput,
  validateReviewDecisionInput
} from "../../fee-contracts/src/index.js";

const ORDER_TYPE_POINTS = Object.freeze({
  lab: 60,
  drug: 68,
  injection: 45,
  treatment: 80,
  imaging: 210,
  procedure: 120,
  other: 10,
  unknown: 10
});

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
    calculationResult: null,
    latestCalculationId: null,
    reviewDecisions: {},
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });
}

export function applyMockCalculation(current = {}, input = {}, options = {}) {
  const calculationResult = buildMockFeeCalculation(current, input, options);
  const now = timestamp(options.now);
  const status = calculationNeedsReview(calculationResult) ? "needs_review" : "calculated";

  return {
    ...current,
    status,
    calculationResult,
    latestCalculationId: calculationResult.calculationId,
    updatedAt: now
  };
}

export function buildMockFeeCalculation(session = {}, input = {}, options = {}) {
  const normalized = validateCreateMockCalculationInput(input);
  const now = timestamp(options.now);
  const orders = normalized.orders ?? session.orders ?? [];
  const clinicalText = normalized.clinicalText ?? session.clinicalText ?? "";
  const lineItems = [
    baseLine(session),
    ...orders.map((order, index) => orderLine(order, index))
  ];
  const textHints = clinicalText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  const totalPoints = lineItems.reduce((sum, line) => sum + line.totalPoints, 0);

  return {
    calculationId: options.calculationId || createId("calc"),
    feeSessionId: requiredString(session.feeSessionId, "feeSessionId"),
    orgId: requiredString(session.orgId, "orgId"),
    patientId: requiredString(session.patientId, "patientId"),
    patientRef: session.patientRef || session.patientId,
    provider: "mock",
    source: "fee-core",
    status: "completed",
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
    warnings: warningMessages(session),
    evidence: textHints.map((text, index) => ({
      evidenceId: `ev_${index + 1}`,
      text
    })),
    generatedAt: now,
    schemaVersion: 1
  };
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

function baseLine(session) {
  const inpatient = session.setting === "inpatient";
  const points = inpatient ? 400 : 288;

  return {
    lineId: "mock_basic",
    code: inpatient ? "A100-MOCK" : "A000-MOCK",
    name: inpatient ? "入院基本料 mock" : "初診/再診料 mock",
    orderType: "basic",
    points,
    quantity: 1,
    totalPoints: points,
    status: "candidate",
    source: "mock"
  };
}

function orderLine(order, index) {
  const orderType = order.orderType || "unknown";
  const points = ORDER_TYPE_POINTS[orderType] || ORDER_TYPE_POINTS.unknown;
  const quantity = Number(order.quantity || 1);
  const totalPoints = Math.round(points * quantity);

  return {
    lineId: `mock_order_${index + 1}`,
    code: `MOCK-${orderType.toUpperCase()}-${index + 1}`,
    name: order.standardName || order.localName || order.content || "未分類オーダー mock",
    orderId: order.orderId,
    orderType,
    points,
    quantity,
    totalPoints,
    status: "candidate",
    source: "mock"
  };
}

function warningMessages(session) {
  const warnings = [];
  if (!session.facilitySnapshot?.medicalInstitutionCode) {
    warnings.push("medicalInstitutionCode is missing on Platform facility");
  }
  if (!session.facilitySnapshot?.regionalBureau) {
    warnings.push("regionalBureau is missing on Platform facility");
  }

  return warnings;
}

function calculationNeedsReview(calculation) {
  return (calculation.warnings || []).length > 0
    || (calculation.lineItems || []).some((line) => ["candidate", "needs_review"].includes(line.status || "candidate"));
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
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
