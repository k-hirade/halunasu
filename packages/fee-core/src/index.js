import crypto from "node:crypto";
import {
  validateCreateMockCalculationInput
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
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });
}

export function applyMockCalculation(current = {}, input = {}, options = {}) {
  const calculationResult = buildMockFeeCalculation(current, input, options);
  const now = timestamp(options.now);

  return {
    ...current,
    status: "calculated",
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
