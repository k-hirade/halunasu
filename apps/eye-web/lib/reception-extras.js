// 受付の追加の機能（replicate-2）で使う純粋な関数と定数。画面から切り離してテストする。
// - 場所（トプコンの場所一覧: 受付・検査・暗室…）: 受付で決めた場所があればそれ、無ければ状態から決まる場所
// - 患者マーク（トプコンの患者マーキング: 車椅子・難聴…）の表示
// - 受付編集履歴（デジカルの受付編集履歴）の文言
import { normalizeAppointmentStatus } from "@halunasu/eye-contracts";

export const RECEPTION_LOCATIONS = Object.freeze([
  { key: "reception", label: "受付" },
  { key: "exam", label: "検査" },
  { key: "darkroom", label: "暗室" },
  { key: "consult", label: "診察" },
  { key: "treatment", label: "処置" }
]);
export const LOCATION_LABELS = Object.freeze(Object.fromEntries(RECEPTION_LOCATIONS.map((item) => [item.key, item.label])));

// 状態から決まる既定の場所。院内にいない状態（予約済・会計済・不在・取消）は場所なし
const STATUS_LOCATIONS = Object.freeze({
  checked_in: "reception",
  in_exam: "exam",
  waiting_doctor: "consult",
  in_consult: "consult",
  in_treatment: "treatment",
  checkout: "reception"
});

// 受付で決めた場所は、決めたときの状態のあいだだけ使う（状態が進んだら既定に戻る）
export function locationOf(appointment) {
  const status = normalizeAppointmentStatus(appointment.status);
  const fallback = STATUS_LOCATIONS[status] || "";
  if (!fallback) return "";
  if (appointment.location && appointment.locationStatus === status) return appointment.location;
  return fallback;
}

// 場所ごとの人数（タブの件数）
export function countByLocation(rows) {
  const counts = Object.fromEntries(RECEPTION_LOCATIONS.map((item) => [item.key, 0]));
  for (const row of rows) {
    const key = locationOf(row);
    if (key) counts[key] += 1;
  }
  return counts;
}

export function filterByLocation(rows, location) {
  if (!location) return rows;
  return rows.filter((row) => locationOf(row) === location);
}

// 患者マークのキー → 定義（消された定義のキーは出さない。データは残る）
export function marksOf(keys = [], definitions = []) {
  const byKey = new Map(definitions.map((mark) => [mark.key, mark]));
  return keys.map((key) => byKey.get(key)).filter(Boolean);
}

export const MARK_TONES = Object.freeze(["teal", "blue", "green", "amber", "red", "neutral"]);

// ---- 受付編集履歴 ----
export const HISTORY_FIELD_LABELS = Object.freeze({
  date: "予約日",
  time: "予約時間",
  purpose: "目的",
  note: "受付メモ",
  doctorMemberId: "医師",
  department: "診療科",
  patientId: "患者",
  patientName: "氏名",
  receptionLabels: "ラベル",
  location: "場所"
});

export function historyValueLabel(field, value, { doctorName = (id) => id, purposeLabels = {} } = {}) {
  if (value === "" || value === null || value === undefined) return "（なし）";
  if (field === "doctorMemberId") return doctorName(value) || value;
  if (field === "purpose") return purposeLabels[value] || value;
  if (field === "location") return LOCATION_LABELS[value] || value;
  if (field === "patientId") return "登録済みの患者に紐づけ";
  if (field === "date") return value.replaceAll("-", "/");
  return value;
}

// 時刻（ISO）を「11/11 09:05」の形で
export function historyTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const jst = new Date(date.getTime() + 9 * 3600000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${jst.getUTCFullYear()}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

// 予約票・受付票の印刷画面の URL
export function receptionPrintHref(appointmentId, kind, { memo = false } = {}) {
  const query = new URLSearchParams({ kind });
  if (memo) query.set("memo", "1");
  return `/reception/print/${encodeURIComponent(appointmentId)}?${query}`;
}

// 院内掲示（診察待・診察中の番号）。番号のある受付だけ。診療科で絞れる
export function displayBoard(appointments, department = "") {
  const pick = (status) => appointments
    .filter((item) => item.queueNumber && normalizeAppointmentStatus(item.status) === status && (!department || item.department === department))
    .sort((left, right) => left.queueNumber - right.queueNumber)
    .map((item) => String(item.queueNumber).padStart(3, "0"));
  return { waiting: pick("waiting_doctor"), calling: pick("in_consult") };
}

// 患者検索の検索オプション（空の欄は送らない）
export function searchOptionsBody(options = {}) {
  const body = {};
  for (const key of ["visitFrom", "visitTo", "diagnosis", "history", "phone"]) {
    const value = String(options[key] || "").trim();
    if (value) body[key] = value;
  }
  if (body.diagnosis && options.diagnosisAll) body.diagnosisAll = true;
  if (body.history && options.historyAll) body.historyAll = true;
  return body;
}

export function hasSearchOptions(options = {}) {
  return Object.keys(searchOptionsBody(options)).length > 0;
}

// 「今月」「先月」の受診期間（JST の今日から）
export function monthRange(today, offset = 0) {
  const [year, month] = today.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const last = new Date(Date.UTC(year, month + offset, 0));
  return { visitFrom: first.toISOString().slice(0, 10), visitTo: last.toISOString().slice(0, 10) };
}
