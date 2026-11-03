// 診察画面（/）とヘッダーの人数バッジで使う「段階」の決め方。
// 受付（reception-workspace.js）と同じ基準: 散瞳の点眼から 20 分たつまでは「散瞳中」として扱う。
import { minutesSince } from "./format";

export const CONSULT_REFRESH_MS = 15000;
export const DILATION_READY_MINUTES = 20;

// 診察画面の段階。受付済・検査中・散瞳中は「まもなく」にまとめる。会計待ち・終了は出さない（受付で見る）
export const CONSULT_STAGES = [
  { key: "waiting", label: "診察待ち", status: "waiting_doctor" },
  { key: "consult", label: "診察中", status: "in_consult" },
  { key: "soon", label: "まもなく", status: "in_exam" },
  { key: "booked", label: "来院予定", status: "booked" }
];

// 受付の段階（色の帯に使う）。受付の groupOf と同じ。
export function flowGroupOf(item, encountersByPatient = {}, now = Date.now()) {
  if (["done", "cancelled", "no_show"].includes(item.status)) return "finished";
  const encounter = encountersByPatient[item.patientId];
  if (["checked_in", "in_exam", "waiting_doctor"].includes(item.status) && encounter?.dilationStartedAt
    && minutesSince(encounter.dilationStartedAt, now) < DILATION_READY_MINUTES) return "dilating";
  return item.status;
}

export function consultStageOf(item, encountersByPatient = {}, now = Date.now()) {
  const group = flowGroupOf(item, encountersByPatient, now);
  if (group === "waiting_doctor") return "waiting";
  if (group === "in_consult") return "consult";
  if (["checked_in", "in_exam", "dilating"].includes(group)) return "soon";
  if (group === "booked") return "booked";
  return null;
}

export function countWaiting(payload = {}, now = Date.now()) {
  return (payload.appointments || []).filter((item) => consultStageOf(item, payload.encountersByPatient, now) === "waiting").length;
}

// 診察画面が読み込んだ人数をヘッダーに知らせる（同じデータを 2 回取らないため）
export const WAITING_COUNT_EVENT = "halunasu-eye:waiting-count";

export function publishWaitingCount(count) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WAITING_COUNT_EVENT, { detail: count }));
}
