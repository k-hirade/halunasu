import {
  APPOINTMENT_ARRIVED_STATUSES,
  assertAppointmentTransition,
  isActiveAppointmentStatus,
  normalizeAppointmentStatus
} from "../../../packages/eye-contracts/src/index.js";

// 予約・受付の状態。状態はどこからどこへでも移れる（デジカルと同じ）。
// 受付番号と受付時刻は、来院した状態（受付中・診察待など）に初めて入ったときに付ける（番号はストアが採番する）。
// 受付メモは従来の note 欄に保存し、返すときに receptionMemo としても見せる。

export function buildAppointment({ appointmentId, orgId, input, patientSnapshot, actor, now }) {
  const status = input.walkIn ? "checked_in" : "booked";
  return {
    appointmentId,
    orgId,
    date: input.date,
    time: input.time,
    patientId: patientSnapshot?.patientId || "",
    patientSnapshot: patientSnapshot || null,
    patientName: patientSnapshot ? patientSnapshot.displayName : input.patientName,
    purpose: input.purpose,
    note: input.note,
    doctorMemberId: input.doctorMemberId || "",
    department: input.department || "",
    walkIn: input.walkIn,
    sourceEncounterId: input.sourceEncounterId,
    status,
    queueNumber: null,
    checkedInAt: status === "checked_in" ? now : "",
    statusHistory: [{ status, at: now, by: actor }],
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

// 受付編集履歴（デジカルの受付編集履歴）に残す項目。値は画面に出せる短い文字列だけ（患者の情報は氏名のみ）。
export const APPOINTMENT_HISTORY_FIELDS = Object.freeze(["date", "time", "purpose", "note", "doctorMemberId", "department", "patientId", "patientName", "receptionLabels", "location"]);
const EDIT_HISTORY_LIMIT = 50;

// before → after で変わった項目を 1 件の履歴にして足す（変わっていなければそのまま）。古いものから捨てて 50 件まで。
export function withEditHistory(before, after, { actor, now }) {
  const changes = [];
  for (const field of APPOINTMENT_HISTORY_FIELDS) {
    const from = historyValue(before[field]);
    const to = historyValue(after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  if (!changes.length) return after;
  return { ...after, editHistory: [...(before.editHistory || []), { at: now, by: actor, changes }].slice(-EDIT_HISTORY_LIMIT) };
}

function historyValue(value) {
  if (Array.isArray(value)) return value.join("、");
  return String(value ?? "").slice(0, 200);
}

// 受付の作成・編集・状態の変更を時刻の順に並べる（受付編集履歴の画面用）
export function appointmentHistory(appointment) {
  const entries = [
    { kind: "created", at: appointment.createdAt, by: appointment.createdBy || null },
    ...(appointment.statusHistory || []).filter((item, index) => !(index === 0 && item.at === appointment.createdAt)).map((item) => ({ kind: "status", at: item.at, by: item.by || null, status: item.status })),
    ...(appointment.editHistory || []).map((item) => ({ kind: "edit", at: item.at, by: item.by || null, changes: item.changes }))
  ];
  return entries.filter((item) => item.at).sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

export function applyAppointmentUpdate(current, input, { patientSnapshot, actor, now }) {
  return withEditHistory(current, applyAppointmentFields(current, input, { patientSnapshot, actor, now }), { actor, now });
}

function applyAppointmentFields(current, input, { patientSnapshot, actor, now }) {
  return {
    ...current,
    date: input.date ?? current.date,
    time: input.time ?? current.time,
    purpose: input.purpose ?? current.purpose,
    note: input.note ?? current.note,
    doctorMemberId: input.doctorMemberId ?? current.doctorMemberId ?? "",
    department: input.department ?? current.department ?? "",
    ...(patientSnapshot
      ? { patientId: patientSnapshot.patientId, patientSnapshot, patientName: patientSnapshot.displayName }
      : input.patientName !== undefined && !current.patientId
        ? { patientName: input.patientName }
        : {}),
    revision: current.revision + 1,
    updatedBy: actor,
    updatedAt: now
  };
}

// 状態の変更。同じ状態への変更は何もしない（changed: false）。
export function applyAppointmentStatus(current, requested, { actor, now }) {
  const status = normalizeAppointmentStatus(requested);
  if (normalizeAppointmentStatus(current.status) === status && current.status === status) {
    return { appointment: current, assignQueueNumber: false, changed: false };
  }
  assertAppointmentTransition(current.status, status);
  const arrived = APPOINTMENT_ARRIVED_STATUSES.includes(status);
  const firstArrival = arrived && !current.queueNumber;
  return {
    appointment: {
      ...current,
      status,
      checkedInAt: arrived && !current.checkedInAt ? now : current.checkedInAt,
      statusHistory: [...(current.statusHistory || []), { status, at: now, by: actor }].slice(-30),
      revision: current.revision + 1,
      updatedBy: actor,
      updatedAt: now
    },
    assignQueueNumber: firstArrival,
    changed: true
  };
}

export function isActiveAppointment(appointment) {
  return isActiveAppointmentStatus(appointment.status);
}

// 一覧で返す形。受付メモは note と同じ値を receptionMemo でも返す。担当医・診療科は古い予約では空。
export function appointmentView(appointment, extra = {}) {
  return {
    ...appointment,
    doctorMemberId: appointment.doctorMemberId || "",
    department: appointment.department || "",
    receptionMemo: appointment.note || "",
    ...extra
  };
}
