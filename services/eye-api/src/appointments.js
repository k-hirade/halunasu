import { assertAppointmentTransition } from "../../../packages/eye-contracts/src/index.js";

// 予約・受付の状態遷移。受付番号は受付（checked_in）に初めて入ったときにストアが採番する。

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

export function applyAppointmentStatus(current, status, { actor, now }) {
  assertAppointmentTransition(current.status, status);
  const firstCheckIn = status === "checked_in" && !current.queueNumber;
  return {
    appointment: {
      ...current,
      status,
      checkedInAt: firstCheckIn ? now : current.checkedInAt,
      statusHistory: [...(current.statusHistory || []), { status, at: now, by: actor }].slice(-30),
      revision: current.revision + 1,
      updatedBy: actor,
      updatedAt: now
    },
    assignQueueNumber: firstCheckIn
  };
}

export function isActiveAppointment(appointment) {
  return !["cancelled", "no_show"].includes(appointment.status);
}
