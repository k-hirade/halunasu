import crypto from "node:crypto";
import {
  validateCreateSoapDraftInput,
  validatePatchChartingEncounterInput,
  validatePatchSoapDraftInput
} from "../../charting-contracts/src/index.js";

export function buildChartingEncounter(input = {}, options = {}) {
  const now = options.now instanceof Date ? options.now.toISOString() : options.now || new Date().toISOString();
  const encounterId = options.encounterId || createId("enc");

  return compactObject({
    encounterId,
    sessionId: encounterId,
    orgId: requiredString(input.orgId, "orgId"),
    patientId: requiredString(input.patientId, "patientId"),
    patientSnapshot: input.patientSnapshot || null,
    facilityId: input.facilityId || null,
    departmentId: input.departmentId || null,
    createdByMemberId: requiredString(input.createdByMemberId, "createdByMemberId"),
    doctorMemberId: input.doctorMemberId || input.createdByMemberId,
    accessMemberIds: uniqueValues([input.createdByMemberId, input.doctorMemberId, ...(input.accessMemberIds || [])]),
    status: input.status || "ready",
    title: input.title || null,
    visitReason: input.visitReason || null,
    transcript: input.transcript || "",
    notes: input.notes || "",
    latestSoapDraftId: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });
}

export function patchChartingEncounter(current = {}, input = {}, options = {}) {
  const patch = validatePatchChartingEncounterInput(input);
  const now = options.now instanceof Date ? options.now.toISOString() : options.now || new Date().toISOString();

  return compactObject({
    ...current,
    ...patch,
    facilityId: hasOwn(patch, "facilityId") ? patch.facilityId || null : current.facilityId,
    departmentId: hasOwn(patch, "departmentId") ? patch.departmentId || null : current.departmentId,
    title: hasOwn(patch, "title") ? patch.title || null : current.title,
    visitReason: hasOwn(patch, "visitReason") ? patch.visitReason || null : current.visitReason,
    transcript: hasOwn(patch, "transcript") ? patch.transcript || "" : current.transcript,
    notes: hasOwn(patch, "notes") ? patch.notes || "" : current.notes,
    updatedAt: now
  });
}

export function buildMockSoapDraft(encounter = {}, input = {}, options = {}) {
  const normalized = validateCreateSoapDraftInput(input);
  const now = options.now instanceof Date ? options.now.toISOString() : options.now || new Date().toISOString();
  const sourceText = [
    normalized.transcript,
    normalized.notes,
    encounter.transcript,
    encounter.notes,
    encounter.visitReason
  ].filter(Boolean).join("\n");
  const lines = sourceText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines.slice(0, 3).join(" / ") || "診療内容を確認してください。";

  return {
    soapDraftId: options.soapDraftId || createId("soap"),
    encounterId: requiredString(encounter.encounterId, "encounterId"),
    orgId: requiredString(encounter.orgId, "orgId"),
    patientId: requiredString(encounter.patientId, "patientId"),
    patientSnapshot: encounter.patientSnapshot || null,
    status: "ready",
    provider: "mock",
    source: "charting-core",
    subjective: encounter.visitReason || "主訴は診療内容から確認してください。",
    objective: summary,
    assessment: "AI下書きのため、医師による確認が必要です。",
    plan: "診療方針を確認し、必要に応じて追記してください。",
    outputText: [
      `S\n${encounter.visitReason || "主訴は診療内容から確認してください。"}`,
      `O\n${summary}`,
      "A\nAI下書きのため、医師による確認が必要です。",
      "P\n診療方針を確認し、必要に応じて追記してください。"
    ].join("\n\n"),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

export function patchSoapDraft(current = {}, input = {}, options = {}) {
  const patch = validatePatchSoapDraftInput(input);
  const now = options.now instanceof Date ? options.now.toISOString() : options.now || new Date().toISOString();

  const next = compactObject({
    ...current,
    ...patch,
    subjective: hasOwn(patch, "subjective") ? patch.subjective || "" : current.subjective,
    objective: hasOwn(patch, "objective") ? patch.objective || "" : current.objective,
    assessment: hasOwn(patch, "assessment") ? patch.assessment || "" : current.assessment,
    plan: hasOwn(patch, "plan") ? patch.plan || "" : current.plan,
    outputText: hasOwn(patch, "outputText") ? patch.outputText || "" : current.outputText,
    approvedAt: patch.status === "approved" ? now : current.approvedAt,
    updatedAt: now
  });

  if (!hasOwn(patch, "outputText") && hasSoapParts(patch)) {
    next.outputText = [
      `S\n${next.subjective || ""}`,
      `O\n${next.objective || ""}`,
      `A\n${next.assessment || ""}`,
      `P\n${next.plan || ""}`
    ].join("\n\n");
  }

  return next;
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
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

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function hasSoapParts(value) {
  return ["subjective", "objective", "assessment", "plan"].some((key) => hasOwn(value, key));
}
