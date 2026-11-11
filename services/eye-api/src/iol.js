import { createId } from "./ids.js";

// IOL（眼内レンズ）管理（トプコン IMAGEnet eカルテの「IOL管理」に倣う）。
// 患者ごとに 1 件の文書（records の配列と revision）。眼ごとに予定・挿入済み・摘出の記録を持つ。
// 計算そのもの（度数の算出）はしない。術前の入力値（眼軸長・前房深度・目標屈折・A定数）と選んだレンズを記録する。

export const IOL_STATUSES = Object.freeze(["planned", "implanted", "removed"]);
export const IOL_STATUS_LABELS = Object.freeze({ planned: "予定", implanted: "挿入済み", removed: "摘出" });
export const IOL_LENS_TYPES = Object.freeze(["monofocal", "toric", "multifocal", "edof", "other"]);
export const IOL_PLACEMENTS = Object.freeze(["bag", "sulcus", "ac", "scleral", "other"]);
const IOL_EYES = ["od", "os"];
const MAX_RECORDS = 20;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function invalid(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(`${field} is required`, field);
    return "";
  }
  if (typeof value !== "string") throw invalid(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (required && !trimmed) throw invalid(`${field} is required`, field);
  if (trimmed.length > max) throw invalid(`${field} must be at most ${max} characters`, field);
  return trimmed;
}

function number(value, field, { min, max, step = 0.01 }) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw invalid(`${field} must be a number`, field);
  if (parsed < min || parsed > max) throw invalid(`${field} must be between ${min} and ${max}`, field);
  return step === 1 ? Math.round(parsed) : Math.round(parsed * 100) / 100;
}

function oneOf(value, list, field, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!list.includes(value)) throw invalid(`${field} must be one of: ${list.join(", ")}`, field);
  return value;
}

function date(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw invalid(`${field} must be YYYY-MM-DD`, field);
  return value;
}

export function validateIolRecord(input, field = "record") {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`${field} must be an object`, field);
  const eye = oneOf(input.eye, IOL_EYES, `${field}.eye`, "");
  if (!eye) throw invalid(`${field}.eye is required`, `${field}.eye`);
  const iolId = text(input.iolId, `${field}.iolId`, 60);
  if (iolId && !/^[A-Za-z0-9_-]+$/u.test(iolId)) throw invalid(`${field}.iolId is invalid`, `${field}.iolId`);
  return {
    iolId,
    eye,
    status: oneOf(input.status, IOL_STATUSES, `${field}.status`, "implanted"),
    model: text(input.model, `${field}.model`, 100, { required: true }),
    manufacturer: text(input.manufacturer, `${field}.manufacturer`, 100),
    lensType: oneOf(input.lensType, IOL_LENS_TYPES, `${field}.lensType`, ""),
    power: number(input.power, `${field}.power`, { min: -20, max: 50 }),
    cylinder: number(input.cylinder, `${field}.cylinder`, { min: 0, max: 15 }),
    axis: number(input.axis, `${field}.axis`, { min: 0, max: 180, step: 1 }),
    aConstant: number(input.aConstant, `${field}.aConstant`, { min: 100, max: 130 }),
    targetRefraction: number(input.targetRefraction, `${field}.targetRefraction`, { min: -15, max: 10 }),
    axialLength: number(input.axialLength, `${field}.axialLength`, { min: 14, max: 40 }),
    acd: number(input.acd, `${field}.acd`, { min: 1, max: 7 }),
    formula: text(input.formula, `${field}.formula`, 40),
    placement: oneOf(input.placement, IOL_PLACEMENTS, `${field}.placement`, ""),
    serial: text(input.serial, `${field}.serial`, 60),
    surgeryDate: date(input.surgeryDate, `${field}.surgeryDate`),
    surgeon: text(input.surgeon, `${field}.surgeon`, 100),
    note: text(input.note, `${field}.note`, 500)
  };
}

export function validateIolRecordsInput(body = {}) {
  const expectedRevision = Number(body?.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw invalid("expectedRevision must be zero or a positive integer", "expectedRevision");
  if (!Array.isArray(body.records)) throw invalid("records must be an array", "records");
  if (body.records.length > MAX_RECORDS) throw invalid(`records must contain at most ${MAX_RECORDS} items`, "records");
  const records = body.records.map((item, index) => validateIolRecord(item, `records.${index}`));
  const ids = records.map((item) => item.iolId).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw invalid("records contain a duplicated iolId", "records");
  return { expectedRevision, records };
}

// 保存する形。id の無い行には新しい id を振り、作った日時は前の版から引き継ぐ。
// 並びは 眼（右→左）→ 手術日の新しい順。
export function applyIolUpdate({ current, validated, patientId, actor, now }) {
  const before = new Map((current?.records || []).map((item) => [item.iolId, item]));
  const records = validated.records.map((item) => {
    const iolId = item.iolId || createId("iol");
    const previous = before.get(iolId);
    return { ...item, iolId, createdAt: previous?.createdAt || now, updatedAt: previous && sameRecord(previous, item) ? previous.updatedAt || now : now };
  }).sort((left, right) => IOL_EYES.indexOf(left.eye) - IOL_EYES.indexOf(right.eye) || String(right.surgeryDate).localeCompare(String(left.surgeryDate)));
  return {
    patientId,
    records,
    revision: (current?.revision || 0) + 1,
    updatedAt: now,
    updatedBy: actor
  };
}

function sameRecord(left, right) {
  return Object.keys(right).every((key) => key === "iolId" || JSON.stringify(left[key] ?? null) === JSON.stringify(right[key] ?? null));
}

export function emptyIolRecords(patientId) {
  return { patientId, records: [], revision: 0 };
}

// 応答の形（orgId は返さない）
export function iolView(doc, patientId) {
  if (!doc) return emptyIolRecords(patientId);
  const { orgId, ...rest } = doc;
  return { ...rest, records: rest.records || [] };
}
