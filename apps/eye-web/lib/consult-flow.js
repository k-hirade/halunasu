// 診察画面（/）とヘッダーの人数バッジで使う「段階」の決め方。
// 受付（reception-workspace.js）と同じ基準: 散瞳の点眼から 20 分たつまでは「散瞳中」として扱う。
import { minutesSince, todayIso } from "./format.js";

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
  if (["done", "cancelled", "absent", "no_show"].includes(item.status)) return "finished";
  const encounter = encountersByPatient[item.patientId];
  if (["checked_in", "in_exam", "waiting_doctor"].includes(item.status) && encounter?.dilationStartedAt
    && minutesSince(encounter.dilationStartedAt, now) < DILATION_READY_MINUTES) return "dilating";
  return item.status;
}

export function consultStageOf(item, encountersByPatient = {}, now = Date.now()) {
  const group = flowGroupOf(item, encountersByPatient, now);
  if (group === "waiting_doctor") return "waiting";
  if (group === "in_consult") return "consult";
  if (["checked_in", "in_exam", "in_treatment", "dilating"].includes(group)) return "soon";
  if (group === "booked") return "booked";
  return null;
}

// 診察の患者一覧の場所タブ（トプコンの「場所一覧」: 受付・検査・暗室・診察 … 会計・すべて に倣う）
export const LIST_STAGES = [
  { key: "waiting", label: "診察待", status: "waiting_doctor" },
  { key: "consult", label: "診察中", status: "in_consult" },
  { key: "exam", label: "検査", status: "in_exam" },
  { key: "dark", label: "暗室", status: "dilating", title: "散瞳中（点眼から20分まで）" },
  { key: "booked", label: "予約", status: "booked" },
  { key: "checkout", label: "会計", status: "checkout" }
];

export function listStageOf(item, encountersByPatient = {}, now = Date.now()) {
  if (item.status === "done") return "checkout";
  const group = flowGroupOf(item, encountersByPatient, now);
  if (group === "waiting_doctor") return "waiting";
  if (group === "in_consult") return "consult";
  if (group === "dilating") return "dark";
  if (["checked_in", "in_exam", "in_treatment"].includes(group)) return "exam";
  if (group === "booked") return "booked";
  if (group === "checkout") return "checkout";
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

// 段階に入った時刻（受付の状態が最後に変わった時刻）
export function stageEnteredAt(item) {
  return item.statusHistory?.at(-1)?.at || item.checkedInAt || "";
}

// 院内（待ち時間を数える）状態
export const WAIT_COUNTED_STATUSES = ["checked_in", "in_exam", "in_treatment", "waiting_doctor", "in_consult", "checkout"];

// 待ち時間。今の状態に入った時刻から、その待ちが終わった時刻まで（今日で院内なら今まで）。
// - 会計済（done）は、会計待に入った時刻から会計済になった時刻まで（増え続けない）
// - 過去の日で院内の状態のまま残った受付は、数えずに { unfinished: true }（since = 最後に更新した時刻）
// 返り値: { minutes, unfinished, since }。待ちを出さない状態は null。
export function waitTimeOf(item, { now = Date.now(), today = todayIso() } = {}) {
  const history = Array.isArray(item?.statusHistory) ? item.statusHistory : [];
  if (item?.status === "done") {
    const index = history.findLastIndex((entry) => entry.status === "checkout");
    const end = index >= 0 ? history[index + 1] : null;
    if (!end) return null;
    return { minutes: minutesSince(history[index].at, Date.parse(end.at)), unfinished: false, since: history[index].at };
  }
  if (!WAIT_COUNTED_STATUSES.includes(item?.status)) return null;
  const since = stageEnteredAt(item);
  if (!since) return null;
  if (item.date && item.date < today) return { minutes: null, unfinished: true, since };
  return { minutes: minutesSince(since, now), unfinished: false, since };
}

function byStageEntered(left, right) {
  return String(stageEnteredAt(left)).localeCompare(String(stageEnteredAt(right))) || (left.queueNumber || 0) - (right.queueNumber || 0);
}

// 次の検査の患者（受付済・検査中で、その段階に入ったのが早い順。同時なら受付番号順）
export function nextExamPatient(appointments = [], excludePatientId = "") {
  return appointments
    .filter((item) => item.patientId && item.patientId !== excludePatientId && ["checked_in", "in_exam"].includes(item.status))
    .sort(byStageEntered)[0] || null;
}

// 次に診る患者（診察待ちになったのが早い順。同時なら受付番号順）。デジカルの「患者リスト（診察待）」の先頭。
export function nextWaitingPatient(appointments = [], encountersByPatient = {}, now = Date.now()) {
  return appointments
    .filter((item) => item.patientId && consultStageOf(item, encountersByPatient, now) === "waiting")
    .sort(byStageEntered)[0] || null;
}

// その日のカルテの ID。なければ作る（前回の確定カルテがあれば再診）。
export async function ensureEncounterFor(api, item, encountersByPatient = {}) {
  const existing = encountersByPatient[item.patientId];
  if (existing) return existing.encounterId;
  const chart = await api(`/v1/eye/patients/${item.patientId}/chart`);
  const payload = await api("/v1/eye/encounters", {
    method: "POST",
    body: { patientId: item.patientId, encounterDate: item.date, visitType: chart.latestFinalized ? "revisit" : "initial" }
  });
  return payload.encounter.encounterId;
}
