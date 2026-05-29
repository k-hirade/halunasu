import crypto from "node:crypto";
import {
  validateRenderReferralDocumentInput,
  validatePatchReferralDraftInput
} from "../../referral-contracts/src/index.js";

export function buildReferralDraft(input = {}, options = {}) {
  const now = timestamp(options.now);
  const referralId = options.referralId || createId("ref");

  return compactObject({
    referralId,
    orgId: requiredString(input.orgId, "orgId"),
    patientId: requiredString(input.patientId, "patientId"),
    patientSnapshot: input.patientSnapshot || null,
    facilityId: requiredString(input.facilityId, "facilityId"),
    facilitySnapshot: input.facilitySnapshot || null,
    departmentId: requiredString(input.departmentId, "departmentId"),
    departmentSnapshot: input.departmentSnapshot || null,
    authorMemberId: requiredString(input.authorMemberId, "authorMemberId"),
    authorMemberSnapshot: input.authorMemberSnapshot || null,
    recipientInstitutionSnapshot: snapshotRecipientInstitution(input.recipientInstitution, now),
    recipientDoctorSnapshot: snapshotRecipientDoctor(input.recipientDoctor, now),
    status: input.status || "draft",
    title: input.title || "診療情報提供書",
    purpose: input.purpose || "",
    clinicalSummary: input.clinicalSummary || "",
    diagnoses: Array.isArray(input.diagnoses) ? input.diagnoses : [],
    medications: Array.isArray(input.medications) ? input.medications : [],
    allergies: Array.isArray(input.allergies) ? input.allergies : [],
    requestedAction: input.requestedAction || "",
    notes: input.notes || "",
    documentArtifact: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });
}

export function patchReferralDraft(current = {}, input = {}, options = {}) {
  const patch = validatePatchReferralDraftInput(input);
  const now = timestamp(options.now);

  return compactObject({
    ...current,
    facilityId: hasOwn(patch, "facilityId") ? patch.facilityId || current.facilityId : current.facilityId,
    facilitySnapshot: hasOwn(input, "facilitySnapshot") ? input.facilitySnapshot || current.facilitySnapshot : current.facilitySnapshot,
    departmentId: hasOwn(patch, "departmentId") ? patch.departmentId || current.departmentId : current.departmentId,
    departmentSnapshot: hasOwn(input, "departmentSnapshot") ? input.departmentSnapshot || current.departmentSnapshot : current.departmentSnapshot,
    authorMemberId: hasOwn(patch, "authorMemberId") ? patch.authorMemberId || current.authorMemberId : current.authorMemberId,
    authorMemberSnapshot: hasOwn(input, "authorMemberSnapshot") ? input.authorMemberSnapshot || current.authorMemberSnapshot : current.authorMemberSnapshot,
    recipientInstitutionSnapshot: hasOwn(patch, "recipientInstitution")
      ? snapshotRecipientInstitution(patch.recipientInstitution, now)
      : current.recipientInstitutionSnapshot,
    recipientDoctorSnapshot: hasOwn(patch, "recipientDoctor")
      ? snapshotRecipientDoctor(patch.recipientDoctor, now)
      : current.recipientDoctorSnapshot,
    title: hasOwn(patch, "title") ? patch.title || current.title : current.title,
    purpose: hasOwn(patch, "purpose") ? patch.purpose || "" : current.purpose,
    clinicalSummary: hasOwn(patch, "clinicalSummary") ? patch.clinicalSummary || "" : current.clinicalSummary,
    diagnoses: hasOwn(patch, "diagnoses") ? patch.diagnoses : current.diagnoses,
    medications: hasOwn(patch, "medications") ? patch.medications : current.medications,
    allergies: hasOwn(patch, "allergies") ? patch.allergies : current.allergies,
    requestedAction: hasOwn(patch, "requestedAction") ? patch.requestedAction || "" : current.requestedAction,
    notes: hasOwn(patch, "notes") ? patch.notes || "" : current.notes,
    status: hasOwn(patch, "status") ? patch.status || current.status : current.status,
    updatedAt: now
  });
}

export function attachReferralDocument(current = {}, input = {}, options = {}) {
  const documentArtifact = buildReferralDocument(current, input, options);
  const now = timestamp(options.now);

  return {
    ...current,
    status: "document_ready",
    documentArtifact,
    updatedAt: now
  };
}

export function buildReferralDocument(referral = {}, input = {}, options = {}) {
  const normalized = validateRenderReferralDocumentInput(input);
  const now = normalized.requestedAt || timestamp(options.now);
  const fileName = normalized.fileName || `${referral.referralId || "referral"}-referral.html`;
  const renderedText = renderReferralText(referral);
  const renderedHtml = renderReferralHtml(referral, renderedText);

  return {
    documentArtifactId: options.documentArtifactId || createId("doc"),
    referralId: requiredString(referral.referralId, "referralId"),
    orgId: requiredString(referral.orgId, "orgId"),
    provider: "halunasu_html",
    status: "ready",
    fileName,
    contentType: "text/html; charset=utf-8",
    storage: "inline",
    renderedText,
    renderedHtml,
    createdAt: now,
    schemaVersion: 1
  };
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

function renderReferralText(referral) {
  return [
    referral.title || "診療情報提供書",
    "",
    `患者: ${referral.patientSnapshot?.displayName || referral.patientId}`,
    `紹介先: ${referral.recipientInstitutionSnapshot?.displayName || ""} ${referral.recipientDoctorSnapshot?.displayName || ""}`,
    `目的: ${referral.purpose || ""}`,
    "",
    referral.clinicalSummary || "",
    "",
    referral.requestedAction || ""
  ].join("\n").trim();
}

function renderReferralHtml(referral, renderedText) {
  const lines = String(renderedText || "")
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");
  return [
    "<!doctype html>",
    "<html lang=\"ja\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    `<title>${escapeHtml(referral.title || "診療情報提供書")}</title>`,
    "<style>",
    "body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;margin:32px;color:#111;line-height:1.8}",
    "main{max-width:800px;margin:0 auto}",
    "h1{text-align:center;font-size:22px;margin:0 0 28px}",
    "p{margin:0 0 6px;white-space:pre-wrap}",
    "@media print{body{margin:18mm}}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(referral.title || "診療情報提供書")}</h1>`,
    lines,
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function snapshotRecipientInstitution(input = {}, snapshotAt) {
  return {
    ...input,
    snapshotAt
  };
}

function snapshotRecipientDoctor(input = {}, snapshotAt) {
  return {
    ...input,
    snapshotAt
  };
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}
