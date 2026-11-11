import { APPOINTMENT_ARRIVED_STATUSES, APPOINTMENT_STATUS_LABELS } from "../../../packages/eye-contracts/src/index.js";

// 経営データの集計（デジカルの「経営データ集計」と「月別受付回数」にあたる）。期間（日本時間の日付・両端を含む・366 日まで）の
// 予約・受付から、日ごと・月ごとの件数と、受診の一覧を作る。金額（点数・負担金）はレセコンで扱うので含めない。

export const REPORT_MAX_DAYS = 366;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PURPOSE_LABELS = { revisit: "再診", initial: "初診", exam: "検査", injection: "注射", postop: "術後", contact_lens: "コンタクト", other: "その他" };
const ARRIVED = new Set(APPOINTMENT_ARRIVED_STATUSES);

export function validateReportRange(params) {
  const from = String(params.get("from") || "");
  const to = String(params.get("to") || "");
  for (const [field, value] of [["from", from], ["to", to]]) {
    if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw validationError(`${field} must be YYYY-MM-DD`, field);
  }
  if (to < from) throw validationError("終わりの日は始まりの日以降にしてください。", "to");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > REPORT_MAX_DAYS) throw validationError(`期間は${REPORT_MAX_DAYS}日までです。`, "to");
  return { from, to, days, includeMemo: params.get("includeMemo") === "1" };
}

export function buildVisitReport(appointments, { from, to, includeMemo }) {
  const days = new Map();
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    days.set(date, { date, booked: 0, arrived: 0, initial: 0, revisit: 0, walkIn: 0, cancelled: 0, absent: 0 });
  }
  const visits = [];
  for (const item of appointments) {
    const day = days.get(item.date);
    if (!day) continue;
    const status = item.status === "no_show" ? "absent" : item.status;
    if (!item.walkIn) day.booked += 1;
    if (status === "cancelled") day.cancelled += 1;
    if (status === "absent") day.absent += 1;
    if (!ARRIVED.has(status)) continue;
    day.arrived += 1;
    if (item.walkIn) day.walkIn += 1;
    if (item.purpose === "initial") day.initial += 1;
    else day.revisit += 1;
    visits.push({
      date: item.date,
      queueNumber: item.queueNumber ?? "",
      time: item.time || "",
      checkedInAt: item.checkedInAt || "",
      patientId: item.patientId || "",
      patientNumber: item.patientSnapshot?.primaryPatientNumber || "",
      patientName: item.patientSnapshot?.displayName || item.patientName || "",
      purpose: PURPOSE_LABELS[item.purpose] || item.purpose || "",
      walkIn: Boolean(item.walkIn),
      status: APPOINTMENT_STATUS_LABELS[status] || status,
      department: item.department || "",
      doctorMemberId: item.doctorMemberId || "",
      ...(includeMemo ? { receptionMemo: item.receptionMemo ?? item.note ?? "" } : {})
    });
  }
  const dayRows = [...days.values()];
  const months = new Map();
  for (const day of dayRows) {
    const month = day.date.slice(0, 7);
    const current = months.get(month) || { month, arrived: 0, initial: 0, revisit: 0, cancelled: 0, absent: 0, openDays: 0 };
    current.arrived += day.arrived;
    current.initial += day.initial;
    current.revisit += day.revisit;
    current.cancelled += day.cancelled;
    current.absent += day.absent;
    if (day.arrived > 0) current.openDays += 1;
    months.set(month, current);
  }
  const totals = dayRows.reduce((sum, day) => {
    for (const key of ["booked", "arrived", "initial", "revisit", "walkIn", "cancelled", "absent"]) sum[key] += day[key];
    return sum;
  }, { booked: 0, arrived: 0, initial: 0, revisit: 0, walkIn: 0, cancelled: 0, absent: 0 });
  visits.sort((left, right) => left.date.localeCompare(right.date) || String(left.queueNumber).padStart(6, "0").localeCompare(String(right.queueNumber).padStart(6, "0")) || left.time.localeCompare(right.time));
  return { range: { from, to }, totals, days: dayRows, months: [...months.values()], visits };
}

function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}
