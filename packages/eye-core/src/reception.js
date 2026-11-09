import {
  APPOINTMENT_STATUS_LABELS,
  isActiveAppointmentStatus,
  normalizeAppointmentStatus
} from "../../eye-contracts/src/index.js";

// 受付・予約・会計の表示に使う計算。保存はしない（API と画面の両方から使う）。

// 会計連携の状態（患者・日ごと）
// none: 確定したカルテがない / draft: 未確定のカルテだけ / pending: 未連携 / handed_off: 連携済 / changed: 連携後に品目が変わった
export const BILLING_STATES = Object.freeze(["none", "draft", "pending", "handed_off", "changed"]);

// 同じ日に同じ患者のカルテが複数あるときは、いちばん手当てが要るものを代表にする。
export function summarizeBillingState(states = []) {
  for (const state of ["changed", "pending", "draft", "handed_off"]) {
    if (states.includes(state)) return state;
  }
  return "none";
}

// 一覧に出す状態。会計待・会計済で、連携後にカルテの品目が変わったものは「再計待」。古い no_show は不在。
export function appointmentDisplayStatus(appointment = {}, billingState = "none") {
  const status = normalizeAppointmentStatus(appointment.status);
  if ((status === "checkout" || status === "done") && billingState === "changed") return "rebill_waiting";
  return status;
}

export function appointmentStatusLabel(status) {
  return APPOINTMENT_STATUS_LABELS[status] || "";
}

// その状態に最後に入った時刻（statusHistory から）。無ければ受付時刻・作成時刻。
export function enteredStatusAt(appointment = {}, status = appointment.status) {
  const history = Array.isArray(appointment.statusHistory) ? appointment.statusHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.status === status) return history[index].at || "";
  }
  return appointment.checkedInAt || appointment.createdAt || "";
}

// 次に診る患者: 診察待のうち、診察待になったのがいちばん早い人。同時なら受付番号の小さい人。
export function pickNextWaitingAppointment(appointments = [], { excludeAppointmentId = "", excludePatientId = "" } = {}) {
  const waiting = appointments.filter((item) => item.status === "waiting_doctor"
    && item.appointmentId !== excludeAppointmentId
    && (!excludePatientId || item.patientId !== excludePatientId));
  waiting.sort((left, right) => String(enteredStatusAt(left)).localeCompare(String(enteredStatusAt(right)))
    || (left.queueNumber ?? Number.MAX_SAFE_INTEGER) - (right.queueNumber ?? Number.MAX_SAFE_INTEGER)
    || String(left.appointmentId).localeCompare(String(right.appointmentId)));
  return waiting[0] || null;
}

// 予約状況（週 × 時間）の件数。取消・不在は数えない。時刻のない予約は「終日」（untimed）。
// slots は 1 時間ごと（"09" → 件数）。halfSlots は 30 分ごと（"09:00" / "09:30" → 件数）。
export function countAppointmentSlots(appointments = [], { from, to } = {}) {
  const days = [];
  for (const date of datesBetween(from, to)) days.push({ date, total: 0, untimed: 0, slots: {}, halfSlots: {} });
  const byDate = new Map(days.map((day) => [day.date, day]));
  for (const item of appointments) {
    const day = byDate.get(item.date);
    if (!day || !isActiveAppointmentStatus(item.status)) continue;
    day.total += 1;
    if (!/^\d{2}:\d{2}$/u.test(item.time || "")) {
      day.untimed += 1;
      continue;
    }
    const hour = item.time.slice(0, 2);
    const half = `${hour}:${Number(item.time.slice(3, 5)) < 30 ? "00" : "30"}`;
    day.slots[hour] = (day.slots[hour] || 0) + 1;
    day.halfSlots[half] = (day.halfSlots[half] || 0) + 1;
  }
  return days;
}

export function datesBetween(from, to) {
  const dates = [];
  if (!from || !to) return dates;
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= end && dates.length < 400; time += 86400000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}
