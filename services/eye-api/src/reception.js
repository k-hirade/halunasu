// 受付まわりの追加の API（デジカル・トプコンに合わせた受付の機能）。server.js から最初に呼び、当てはまらなければ undefined を返す。
// - 受付の設定: 受付メモのラベル（紹介状あり など）と患者マーク（車椅子・難聴 など）の定義。医院ごとに 1 件。
// - 患者マーク: 患者ごとの印。受付一覧の行頭と患者検索に出す。
// - 受付 1 件の取得と受付編集履歴（予約票・受診票の印刷、履歴の画面）。
// - 受付のラベルと場所（受付・検査・暗室・診察・処置）の変更。編集履歴に残す。
// - 患者検索の検索オプション（受診期間・傷病名・診療履歴・電話番号）。
import { requirePlatformCsrf } from "../../../packages/auth-client/src/index.js";
import { APPOINTMENT_ARRIVED_STATUSES, EYE_RECEPTION_ROLES, normalizeAppointmentStatus } from "../../../packages/eye-contracts/src/index.js";
import { appointmentHistory, appointmentView, withEditHistory } from "./appointments.js";

export const RECEPTION_LOCATIONS = Object.freeze(["reception", "exam", "darkroom", "consult", "treatment"]);
export const MARK_TONES = Object.freeze(["teal", "blue", "green", "amber", "red", "neutral"]);
export const DEFAULT_RECEPTION_LABELS = Object.freeze(["紹介状あり", "散瞳予定", "視野検査", "書類お渡し", "次回予約"]);
export const DEFAULT_PATIENT_MARKS = Object.freeze([
  { key: "hearing", label: "難聴", symbol: "耳", tone: "amber" },
  { key: "wheelchair", label: "車椅子", symbol: "車", tone: "blue" },
  { key: "assist", label: "要介助", symbol: "介", tone: "blue" },
  { key: "caution", label: "要注意", symbol: "注", tone: "red" },
  { key: "child", label: "小児", symbol: "子", tone: "green" },
  { key: "diabetes", label: "糖尿病", symbol: "糖", tone: "amber" },
  { key: "no_dilation", label: "散瞳不可", symbol: "散", tone: "red" },
  { key: "documents", label: "書類あり", symbol: "書", tone: "teal" }
]);

const MAX_LABELS = 40;
const MAX_LABEL_LENGTH = 20;
const MAX_MARKS = 20;
const MAX_MARK_LABEL_LENGTH = 12;
const MARK_KEY = /^[a-z0-9_-]{1,24}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ADVANCED_SCAN_LIMIT = 3000;
const ADVANCED_RANGE_DAYS = 3660;

// ---- 受付の設定 ----

// 受付ラベル・患者マークの保存先はここ（eye_reception_settings）だけ。施設管理の「受付ラベル・患者マーク」もこの API を読み書きする。
// legacy: 施設管理の設定（clinic-config の receptionLabels）に以前保存された値。まだ取り込んでいなければ読むときに足す（消さない）。
export function receptionSettingsView(settings, legacy = null) {
  const view = {
    labels: Array.isArray(settings?.labels) ? settings.labels : [...DEFAULT_RECEPTION_LABELS],
    marks: Array.isArray(settings?.marks) ? settings.marks : DEFAULT_PATIENT_MARKS.map((mark) => ({ ...mark })),
    revision: settings?.revision || 0,
    updatedAt: settings?.updatedAt || "",
    updatedBy: settings?.updatedBy || null
  };
  return mergeLegacyReceptionLabels(view, legacy, settings?.legacyRevision || 0);
}

const LEGACY_TONES = { teal: "teal", blue: "blue", amber: "amber", red: "red", gray: "neutral" };

// 施設管理（clinic-config receptionLabels: labels[{ labelId, name, tone, active }], marks[{ markId, name, symbol, tone, active }]）の値を、
// 受付の設定の形（labels: 名前の配列、marks: [{ key, label, symbol, tone, active? }]）に直して足す。名前が同じものは足さない。
// 取り込んだ版（legacyRevision）を受付の設定の保存時に記録するので、受付の設定で消したものが戻ってくることはない。
export function mergeLegacyReceptionLabels(view, legacy, mergedRevision = 0) {
  if (!legacy?.value || !(legacy.revision > mergedRevision)) return view;
  const labels = [...view.labels];
  for (const item of Array.isArray(legacy.value.labels) ? legacy.value.labels : []) {
    const name = String(item?.name || "").replace(/\s+/gu, " ").trim().slice(0, MAX_LABEL_LENGTH);
    if (name && !labels.includes(name) && labels.length < MAX_LABELS) labels.push(name);
  }
  const marks = [...view.marks];
  const keys = new Set(marks.map((mark) => mark.key));
  const names = new Set(marks.map((mark) => mark.label));
  for (const item of Array.isArray(legacy.value.marks) ? legacy.value.marks : []) {
    const label = String(item?.name || "").replace(/\s+/gu, " ").trim().slice(0, MAX_MARK_LABEL_LENGTH);
    const symbol = [...String(item?.symbol || "").trim()].slice(0, 2).join("");
    if (!label || !symbol || names.has(label) || marks.length >= MAX_MARKS) continue;
    let key = `c_${String(item.markId || "").toLowerCase().replace(/[^a-z0-9_-]/gu, "")}`.slice(0, 24);
    for (let suffix = 2; !MARK_KEY.test(key) || keys.has(key); suffix += 1) key = `c_mark${marks.length}_${suffix}`.slice(0, 24);
    keys.add(key);
    names.add(label);
    marks.push({ key, label, symbol, tone: LEGACY_TONES[item.tone] || "neutral", ...(item.active === false ? { active: false } : {}) });
  }
  return { ...view, labels, marks, legacyRevision: legacy.revision };
}

export function validateReceptionSettingsInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw validationError("body must be an object", "body");
  const expectedRevision = input.expectedRevision === undefined ? 0 : input.expectedRevision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw validationError("expectedRevision must be a non-negative integer", "expectedRevision");
  const result = { expectedRevision };
  if (input.labels !== undefined) result.labels = validateLabels(input.labels, "labels", MAX_LABELS);
  if (input.marks !== undefined) {
    if (!Array.isArray(input.marks) || input.marks.length > MAX_MARKS) throw validationError(`marks must be an array of at most ${MAX_MARKS}`, "marks");
    const keys = new Set();
    result.marks = input.marks.map((mark, index) => {
      if (!mark || typeof mark !== "object") throw validationError("mark must be an object", `marks.${index}`);
      const key = String(mark.key || "").trim();
      if (!MARK_KEY.test(key) || keys.has(key)) throw validationError("mark key must be unique lower-case letters, digits, _ or -", `marks.${index}.key`);
      keys.add(key);
      const label = String(mark.label || "").replace(/\s+/gu, " ").trim();
      if (!label || label.length > MAX_MARK_LABEL_LENGTH) throw validationError(`mark label must be 1-${MAX_MARK_LABEL_LENGTH} characters`, `marks.${index}.label`);
      const symbol = String(mark.symbol || "").trim();
      if (!symbol || [...symbol].length > 2) throw validationError("mark symbol must be 1-2 characters", `marks.${index}.symbol`);
      const tone = MARK_TONES.includes(mark.tone) ? mark.tone : "neutral";
      // active: false は「新しく付ける候補に出さない」だけ（付いている患者の表示は続ける）。省略は使う
      return { key, label, symbol, tone, ...(mark.active === false ? { active: false } : {}) };
    });
  }
  return result;
}

function validateLabels(value, field, max) {
  if (!Array.isArray(value) || value.length > max) throw validationError(`${field} must be an array of at most ${max}`, field);
  const seen = new Set();
  const labels = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw validationError(`${field} must contain strings`, field);
    const label = raw.replace(/\s+/gu, " ").trim();
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) throw validationError(`each label must be at most ${MAX_LABEL_LENGTH} characters`, field);
    if (!seen.has(label)) labels.push(label);
    seen.add(label);
  }
  return labels;
}

// ---- 受付のラベル・場所 ----

export function validateReceptionPatchInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  const result = { expectedRevision };
  if (input.receptionLabels !== undefined) result.receptionLabels = validateLabels(input.receptionLabels, "receptionLabels", 10);
  if (input.location !== undefined) {
    const location = String(input.location ?? "");
    if (location && !RECEPTION_LOCATIONS.includes(location)) throw validationError(`location must be one of: ${RECEPTION_LOCATIONS.join(", ")}`, "location");
    result.location = location;
  }
  if (result.receptionLabels === undefined && result.location === undefined) throw validationError("receptionLabels or location is required", "body");
  return result;
}

// 場所は、決めたときの状態のあいだだけ有効（状態が進んだら、状態から決まる既定の場所に戻る）
export function applyReceptionPatch(current, input, { actor, now }) {
  const next = { ...current };
  if (input.receptionLabels !== undefined) next.receptionLabels = input.receptionLabels;
  if (input.location !== undefined) {
    next.location = input.location;
    next.locationStatus = input.location ? normalizeAppointmentStatus(current.status) : "";
  }
  const updated = withEditHistory(current, next, { actor, now });
  if (updated === next && JSON.stringify(next) === JSON.stringify(current)) return null;
  return { ...updated, revision: current.revision + 1, updatedBy: actor, updatedAt: now };
}

// ---- 患者マーク ----

export function validatePatientMarksInput(input = {}, definitions = []) {
  const expectedRevision = input.expectedRevision === undefined ? 0 : input.expectedRevision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw validationError("expectedRevision must be a non-negative integer", "expectedRevision");
  if (!Array.isArray(input.marks) || input.marks.length > MAX_MARKS) throw validationError(`marks must be an array of at most ${MAX_MARKS}`, "marks");
  const known = new Set(definitions.map((mark) => mark.key));
  const marks = [...new Set(input.marks.map((key) => String(key || "").trim()))].filter(Boolean);
  for (const key of marks) {
    if (!known.has(key)) throw validationError(`unknown mark: ${key}`, "marks");
  }
  return { expectedRevision, marks };
}

// 受付一覧・患者検索用: 患者 ID ごとのマーク（無ければ空）。読めなくても一覧は止めない。
export async function loadPatientMarks(eyeStore, orgId, patientIds) {
  if (!eyeStore.getPatientMarks) return {};
  const records = await Promise.all(patientIds.map((patientId) => Promise.resolve().then(() => eyeStore.getPatientMarks(orgId, patientId)).catch(() => null)));
  return Object.fromEntries(patientIds.map((patientId, index) => [patientId, { marks: records[index]?.marks || [], revision: records[index]?.revision || 0 }]));
}

// ---- 患者検索の検索オプション ----

export function parseAdvancedSearch(body = {}) {
  const words = (value) => String(value || "").normalize("NFKC").trim().split(/\s+/u).filter(Boolean).slice(0, 5).map((word) => word.slice(0, 40));
  const visitFrom = String(body.visitFrom || "").trim();
  const visitTo = String(body.visitTo || "").trim();
  if (visitFrom && !DATE_PATTERN.test(visitFrom)) throw validationError("visitFrom must be YYYY-MM-DD", "visitFrom");
  if (visitTo && !DATE_PATTERN.test(visitTo)) throw validationError("visitTo must be YYYY-MM-DD", "visitTo");
  if (visitFrom && visitTo && visitFrom > visitTo) throw validationError("visitFrom must be on or before visitTo", "visitFrom");
  const options = {
    visitFrom,
    visitTo,
    diagnosis: words(body.diagnosis),
    diagnosisAll: body.diagnosisAll === true,
    history: words(body.history),
    historyAll: body.historyAll === true,
    phone: String(body.phone || "").normalize("NFKC").replace(/\D/gu, "").slice(0, 15)
  };
  const active = Boolean(options.visitFrom || options.visitTo || options.diagnosis.length || options.history.length || options.phone);
  return active ? options : null;
}

function matchWords(text, words, all) {
  if (!words.length) return true;
  const haystack = text.normalize("NFKC");
  return all ? words.every((word) => haystack.includes(word)) : words.some((word) => haystack.includes(word));
}

// カルテの本文から文字だけを集める（ID・日時などの短い記号は外す）
function encounterText(encounter) {
  const out = [];
  const walk = (value, key = "") => {
    if (typeof value === "string") {
      if (!/(Id|At|By|code|status)$/u.test(key) && value.length > 1) out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
    }
  };
  walk(encounter.content || {});
  return out.join("\n");
}

function inRange(date, { visitFrom, visitTo }) {
  return Boolean(date) && (!visitFrom || date >= visitFrom) && (!visitTo || date <= visitTo);
}

function addDays(iso, days) {
  const value = new Date(`${iso}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// 条件に当てはまる患者を、基本の検索（語・生年月日）の結果、受診期間の受付、全患者の順に候補を作って絞る。
export async function advancedPatientSearch({ platformStore, eyeStore, orgId, options, baseSearch, hasBaseQuery, limit }) {
  let candidates;
  let truncated = false;
  if (hasBaseQuery) {
    candidates = await baseSearch();
  } else if (options.visitFrom || options.visitTo) {
    const from = options.visitFrom || addDays(options.visitTo, -ADVANCED_RANGE_DAYS);
    const to = options.visitTo || addDays(options.visitFrom, ADVANCED_RANGE_DAYS);
    const [appointments, encounters] = await Promise.all([
      eyeStore.listAppointmentsInRange(orgId, from, to),
      eyeStore.listRecentFinalizedEncounters ? eyeStore.listRecentFinalizedEncounters(orgId, { sinceIso: from, limit: ADVANCED_SCAN_LIMIT }) : []
    ]);
    // 短い期間（92 日まで）は日ごとのカルテ（下書きを含む）も見る。長い期間は確定したカルテと受付だけ
    const days = [];
    for (let day = from; day <= to && days.length <= 92; day = addDays(day, 1)) days.push(day);
    const daily = days.length <= 92 ? (await Promise.all(days.map((day) => eyeStore.listEncountersByDate(orgId, day)))).flat() : [];
    const ids = new Set([
      ...daily.map((item) => item.patientId),
      ...appointments.filter((item) => item.patientId && (item.checkedInAt || APPOINTMENT_ARRIVED_STATUSES.includes(item.status))).map((item) => item.patientId),
      ...encounters.filter((item) => inRange(item.encounterDate, { visitFrom: from, visitTo: to })).map((item) => item.patientId)
    ]);
    const patients = await Promise.all([...ids].slice(0, ADVANCED_SCAN_LIMIT).map((patientId) => Promise.resolve(platformStore.getPatient(orgId, patientId)).catch(() => null)));
    candidates = patients.filter(Boolean);
    truncated = ids.size > ADVANCED_SCAN_LIMIT;
  } else {
    const all = await platformStore.listPatients(orgId);
    candidates = all.slice(0, ADVANCED_SCAN_LIMIT);
    truncated = all.length > ADVANCED_SCAN_LIMIT;
  }
  const results = [];
  for (const patient of candidates) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    if (!patient || patient.status === "merged") continue;
    if (options.phone) {
      const phones = [patient.contact?.phone1, patient.contact?.phone2, patient.contact?.phone, patient.phone].map((value) => String(value || "").normalize("NFKC").replace(/\D/gu, ""));
      if (!phones.some((value) => value && value.includes(options.phone))) continue;
    }
    const needsEncounters = options.history.length || options.visitFrom || options.visitTo || options.diagnosis.length;
    const encounters = needsEncounters ? await eyeStore.listPatientEncounters(orgId, patient.patientId) : [];
    if (options.visitFrom || options.visitTo) {
      const appointments = await eyeStore.listPatientAppointments(orgId, patient.patientId);
      const dates = [
        ...appointments.filter((item) => item.checkedInAt || APPOINTMENT_ARRIVED_STATUSES.includes(item.status)).map((item) => item.date),
        ...encounters.map((item) => item.encounterDate)
      ];
      if (!dates.some((date) => inRange(date, options))) continue;
    }
    if (options.diagnosis.length) {
      const profile = await eyeStore.getPatientProfile(orgId, patient.patientId);
      const names = [
        ...(profile?.diagnoses || []).map((item) => item.name),
        ...encounters.flatMap((item) => (item.content?.diagnoses || []).map((diagnosis) => diagnosis.name))
      ].filter(Boolean).join("\n");
      if (!matchWords(names, options.diagnosis, options.diagnosisAll)) continue;
    }
    if (options.history.length) {
      const text = encounters.filter((item) => inRange(item.encounterDate, options) || (!options.visitFrom && !options.visitTo)).map(encounterText).join("\n");
      if (!matchWords(text, options.history, options.historyAll)) continue;
    }
    results.push(patient);
  }
  return { patients: results, truncated };
}

// 施設管理（clinic-config）に以前保存された受付ラベル・患者マーク。読めなくても受付は止めない。
export async function loadLegacyReceptionLabels(eyeStore, orgId) {
  return Promise.resolve().then(() => eyeStore.getClinicConfig?.(orgId, "receptionLabels") ?? null).catch(() => null);
}

export async function loadReceptionSettings(eyeStore, orgId) {
  return receptionSettingsView(eyeStore.getReceptionSettings ? await eyeStore.getReceptionSettings(orgId) : null, await loadLegacyReceptionLabels(eyeStore, orgId));
}

// ---- ルート ----

export async function routeReception({ method, parts, url, input, context, orgId, actor, now, audit, eyeStore, platformStore, helpers }) {
  const { ok, requireAccess, requirePatient, requireAppointment } = helpers;
  const is = (...expected) => parts.length === expected.length && expected.every((value, index) => value === "*" || parts[index] === value);
  const requireWrite = () => {
    requireAccess(context, EYE_RECEPTION_ROLES, "Reception access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
  };
  const loadLegacy = () => loadLegacyReceptionLabels(eyeStore, orgId);
  const loadSettings = () => loadReceptionSettings(eyeStore, orgId);

  if (is("v1", "eye", "reception-settings")) {
    if (method === "GET") return ok({ settings: await loadSettings() });
    if (method === "PUT") {
      requireWrite();
      const validated = validateReceptionSettingsInput(input.body || {});
      const current = await eyeStore.getReceptionSettings(orgId);
      const view = receptionSettingsView(current, await loadLegacy());
      const legacyRevision = view.legacyRevision ?? current?.legacyRevision;
      const saved = await eyeStore.saveReceptionSettings(orgId, {
        labels: validated.labels ?? view.labels,
        marks: validated.marks ?? view.marks,
        ...(legacyRevision ? { legacyRevision } : {}),
        revision: (current?.revision || 0) + 1,
        createdAt: current?.createdAt || now,
        updatedAt: now,
        updatedBy: actor
      }, validated.expectedRevision);
      await audit({ eventType: "eye.reception_settings_saved", targetType: "organization", targetId: orgId, safePayload: { labelCount: saved.labels.length, markCount: saved.marks.length } });
      return ok({ settings: receptionSettingsView(saved) });
    }
  }

  if (is("v1", "eye", "patients", "*", "marks")) {
    const patient = await requirePatient(platformStore, orgId, parts[3]);
    if (method === "GET") {
      const record = await eyeStore.getPatientMarks(orgId, patient.patientId);
      return ok({ patientId: patient.patientId, marks: record?.marks || [], revision: record?.revision || 0 });
    }
    if (method === "PUT") {
      requireWrite();
      const settings = await loadSettings();
      const validated = validatePatientMarksInput(input.body || {}, settings.marks);
      const current = await eyeStore.getPatientMarks(orgId, patient.patientId);
      const saved = await eyeStore.savePatientMarks(orgId, {
        patientId: patient.patientId,
        marks: validated.marks,
        revision: (current?.revision || 0) + 1,
        updatedAt: now,
        updatedBy: actor
      }, validated.expectedRevision);
      await audit({ eventType: "eye.patient_marks_updated", targetType: "patient", targetId: patient.patientId, patientId: patient.patientId, safePayload: { markCount: saved.marks.length } });
      return ok({ patientId: patient.patientId, marks: saved.marks, revision: saved.revision });
    }
  }

  // その日の受付の患者ごとのマーク（受付一覧の行頭のマーク列）
  if (method === "GET" && is("v1", "eye", "appointments", "patient-marks")) {
    const date = String(url.searchParams.get("date") || "");
    if (!DATE_PATTERN.test(date)) throw validationError("date must be YYYY-MM-DD", "date");
    const appointments = await eyeStore.listAppointmentsByDate(orgId, date);
    const patientIds = [...new Set(appointments.map((item) => item.patientId).filter(Boolean))];
    return ok({ date, patients: await loadPatientMarks(eyeStore, orgId, patientIds) });
  }

  // 受付 1 件と受付編集履歴（range・patient-details は別の一覧なので除く）
  if (method === "GET" && is("v1", "eye", "appointments", "*") && !["range", "patient-details", "patient-marks"].includes(parts[3])) {
    const appointment = await requireAppointment(eyeStore, orgId, parts[3]);
    return ok({ appointment: appointmentView(appointment), history: appointmentHistory(appointment) });
  }

  if (method === "PATCH" && is("v1", "eye", "appointments", "*", "reception")) {
    requireWrite();
    const validated = validateReceptionPatchInput(input.body || {});
    const current = await requireAppointment(eyeStore, orgId, parts[3]);
    if (current.revision !== validated.expectedRevision) {
      const error = new Error("appointment was updated by someone else; reload and try again");
      error.name = "ConflictError";
      error.statusCode = 409;
      throw error;
    }
    const updated = applyReceptionPatch(current, validated, { actor, now });
    if (!updated) return ok({ appointment: appointmentView(current) });
    const saved = await eyeStore.replaceAppointment(orgId, updated, validated.expectedRevision);
    await audit({ eventType: "eye.appointment_updated", targetType: "appointment", targetId: saved.appointmentId, patientId: saved.patientId });
    return ok({ appointment: appointmentView(saved) });
  }

  return undefined;
}

function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}
