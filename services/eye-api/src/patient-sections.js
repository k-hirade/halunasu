import { allergyOnset, validatePatientProfileInput, validationError } from "../../../packages/eye-contracts/src/index.js";
import { createId } from "./ids.js";

// カルテ左ペインの患者ごとの記録（デジカルの 副作用薬等・バイタル・問診・サマリー タブ）。
// どれも患者のプロファイル（eye_patient_profiles）に足した項目で、区画ごとに保存する。
// - allergies: アレルギー（既存の項目。発症時期 onset を足した）と「なし（確認済み）」
// - adverseDrugs: 副作用が出た薬  - regularMedications: 常用薬（他院の処方など）
// - history: 既往（全身既往・内服／眼科既往／CL。既存の項目）
// - vitals: バイタル（測定日ごと）  - interviews: 問診（日付と内容）  - summary: サマリー（自由記述 1 つ）
// 新しい項目は、知らない画面（既存のプロファイル保存）が保存しても消えないよう applyProfileUpdate で引き継ぐ。

export const PROFILE_SECTIONS = Object.freeze(["allergies", "adverseDrugs", "regularMedications", "history", "vitals", "interviews", "summary"]);
// 既存のプロファイル保存（PUT /profile）が知らない項目。保存のたびに今の値を引き継ぐ。
export const EXTRA_PROFILE_KEYS = Object.freeze(["adverseDrugs", "regularMedications", "vitals", "interviews", "summary"]);

export const VITAL_FIELDS = Object.freeze({
  systolic: { min: 30, max: 300, integer: true },
  diastolic: { min: 10, max: 200, integer: true },
  pulse: { min: 10, max: 300, integer: true },
  temperature: { min: 30, max: 45 },
  spo2: { min: 50, max: 100, integer: true },
  height: { min: 30, max: 250 },
  weight: { min: 1, max: 400 },
  glucose: { min: 10, max: 1000, integer: true }
});

const MAX_SHORT = 200;
const MAX_TEXT = 4000;
const MAX_SUMMARY = 8000;
const MAX_DRUGS = 60;
const MAX_VITALS = 500;
const MAX_INTERVIEWS = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function list(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${field} must be an array`, field);
  if (value.length > max) throw validationError(`${field} must have at most ${max} items`, field);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw validationError(`${field}.${index} must be an object`, `${field}.${index}`);
    return item;
  });
}

function text(value, field, max, { required = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== "string") throw validationError(`${field} must be a string`, field);
  const result = String(value ?? "").trim();
  if (required && !result) throw validationError(`${field} is required`, field);
  if (result.length > max) throw validationError(`${field} must be at most ${max} characters`, field);
  return result;
}

function date(value, field, { required = false } = {}) {
  const result = String(value ?? "").trim();
  if (!result && !required) return "";
  if (!DATE.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) throw validationError(`${field} must be YYYY-MM-DD`, field);
  return result;
}

function number(value, field, { min, max, integer = false }) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
    throw validationError(`${field} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`, field);
  }
  return integer ? result : Math.round(result * 10) / 10;
}

function idOf(value, field, prefix) {
  return text(value, field, MAX_SHORT) || createId(prefix);
}

function validateDrugs(value, field, kind) {
  return list(value, field, MAX_DRUGS).map((item, index) => {
    const path = `${field}.${index}`;
    const base = {
      itemId: idOf(item.itemId, `${path}.itemId`, kind === "adverse" ? "eadr" : "emed"),
      name: text(item.name, `${path}.name`, MAX_SHORT, { required: true }),
      ...(text(item.code, `${path}.code`, 40) ? { code: text(item.code, `${path}.code`, 40) } : {}),
      note: text(item.note, `${path}.note`, MAX_SHORT)
    };
    if (kind === "adverse") {
      return { ...base, reaction: text(item.reaction, `${path}.reaction`, MAX_SHORT), ...allergyOnset(item.onset, `${path}.onset`) };
    }
    return { ...base, usage: text(item.usage, `${path}.usage`, MAX_SHORT), current: item.current === undefined ? true : Boolean(item.current) };
  });
}

function validateVitals(value, field, actor, now) {
  return list(value, field, MAX_VITALS).map((item, index) => {
    const path = `${field}.${index}`;
    const values = {};
    for (const [key, range] of Object.entries(VITAL_FIELDS)) {
      const result = number(item[key], `${path}.${key}`, range);
      if (result !== null) values[key] = result;
    }
    const note = text(item.note, `${path}.note`, MAX_SHORT);
    if (!Object.keys(values).length && !note) throw validationError(`${path} needs at least one value`, path);
    return {
      vitalId: idOf(item.vitalId, `${path}.vitalId`, "evit"),
      date: date(item.date, `${path}.date`, { required: true }),
      ...values,
      note,
      recordedAt: text(item.recordedAt, `${path}.recordedAt`, 40) || now,
      recordedBy: item.recordedBy && typeof item.recordedBy === "object" ? pickActor(item.recordedBy) : actor
    };
  }).sort((left, right) => left.date.localeCompare(right.date) || String(left.recordedAt).localeCompare(String(right.recordedAt)));
}

function validateInterviews(value, field, actor, now) {
  return list(value, field, MAX_INTERVIEWS).map((item, index) => {
    const path = `${field}.${index}`;
    return {
      interviewId: idOf(item.interviewId, `${path}.interviewId`, "eint"),
      date: date(item.date, `${path}.date`, { required: true }),
      text: text(item.text, `${path}.text`, MAX_TEXT, { required: true }),
      updatedAt: text(item.updatedAt, `${path}.updatedAt`, 40) || now,
      updatedBy: item.updatedBy && typeof item.updatedBy === "object" ? pickActor(item.updatedBy) : actor
    };
  }).sort((left, right) => right.date.localeCompare(left.date));
}

function pickActor(value) {
  return {
    memberId: String(value.memberId || "").slice(0, MAX_SHORT),
    loginId: String(value.loginId || "").slice(0, MAX_SHORT),
    displayName: String(value.displayName || "").slice(0, MAX_SHORT)
  };
}

// 区画 1 つ分の入力を確かめ、プロファイルに書く値（キーと値）を返す。
export function validateProfileSectionInput(input = {}, { actor = null, now = "" } = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw validationError("expectedRevision must be zero or a positive integer", "expectedRevision");
  const section = String(input.section || "");
  if (!PROFILE_SECTIONS.includes(section)) throw validationError(`section must be one of: ${PROFILE_SECTIONS.join(", ")}`, "section");
  const value = input.value;
  let patch;
  if (section === "allergies") {
    const validated = validatePatientProfileInput({ expectedRevision, allergies: value?.allergies ?? [], noKnownAllergies: Boolean(value?.noKnownAllergies) });
    patch = { allergies: validated.allergies, noKnownAllergies: validated.noKnownAllergies };
  } else if (section === "history") {
    patch = {
      medicalHistory: text(value?.medicalHistory, "value.medicalHistory", MAX_TEXT),
      ophthalmicHistory: text(value?.ophthalmicHistory, "value.ophthalmicHistory", MAX_TEXT),
      contactLensUser: Boolean(value?.contactLensUser)
    };
  } else if (section === "adverseDrugs") {
    patch = { adverseDrugs: validateDrugs(value, "value", "adverse") };
  } else if (section === "regularMedications") {
    patch = { regularMedications: validateDrugs(value, "value", "regular") };
  } else if (section === "vitals") {
    patch = { vitals: validateVitals(value, "value", actor, now) };
  } else if (section === "interviews") {
    patch = { interviews: validateInterviews(value, "value", actor, now) };
  } else {
    patch = { summary: text(value, "value", MAX_SUMMARY), summaryUpdatedAt: now, summaryUpdatedBy: actor };
  }
  return { expectedRevision, section, patch };
}

// 今のプロファイル（未保存なら病名から組み立てた初期値）に区画の値を重ねる。
export function applyProfileSection({ current, patch, orgId, patientId, actor, now }) {
  const base = current?.derived ? { ...current, derived: false } : { ...(current || {}) };
  return {
    allergies: [],
    noKnownAllergies: false,
    diagnoses: [],
    medicalHistory: "",
    ophthalmicHistory: "",
    contactLensUser: false,
    patientMemo: "",
    ...base,
    ...patch,
    allergies: (patch.allergies || base.allergies || []).map((item) => ({ ...item, allergyId: item.allergyId || createId("ealg") })),
    diagnoses: (base.diagnoses || []).map((item) => ({ ...item, diagnosisId: item.diagnosisId || createId("edx") })),
    patientId,
    orgId,
    revision: (current?.derived ? 0 : current?.revision || 0) + 1,
    derived: false,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    updatedBy: actor,
    schemaVersion: 1
  };
}

// 既存のプロファイル保存で、ここで足した項目を引き継ぐ。
export function carryExtraProfileKeys(current) {
  const extras = {};
  for (const key of [...EXTRA_PROFILE_KEYS, "summaryUpdatedAt", "summaryUpdatedBy"]) {
    if (current && current[key] !== undefined) extras[key] = current[key];
  }
  return extras;
}

// 監査ログに残す件数（本文は残さない）。
export function sectionAuditPayload(section, profile) {
  const counts = {
    allergies: profile.allergies?.length || 0,
    adverseDrugs: profile.adverseDrugs?.length || 0,
    regularMedications: profile.regularMedications?.length || 0,
    vitals: profile.vitals?.length || 0,
    interviews: profile.interviews?.length || 0
  };
  return { section, revision: profile.revision, ...(section in counts ? { count: counts[section] } : {}) };
}
