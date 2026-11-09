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

export function applyAppointmentUpdate(current, input, { patientSnapshot, actor, now }) {
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
