export const EYE_LABELS = { od: "右眼", os: "左眼", ou: "両眼" };
export const EYE_SHORT = { od: "R", os: "L", ou: "両" };
export const SEX_LABELS = { male: "男", female: "女", other: "他", unknown: "不明" };
export const VISIT_TYPE_LABELS = { initial: "初診", revisit: "再診" };
export const PRESCRIPTION_KIND_LABELS = {
  eye_drop: "点眼",
  eye_ointment: "眼軟膏",
  oral: "内服",
  injection: "注射",
  other: "その他"
};
export const IOP_METHOD_LABELS = { nct: "NCT", goldmann: "GAT", icare: "iCare", other: "その他" };
export const DIAGNOSIS_STATUS_LABELS = { active: "", suspected: "疑い", resolved: "治癒" };

export function ageOn(birthDate, onDate = todayIso()) {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ty, tm, td] = onDate.split("-").map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

export function todayIso() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

export function formatDate(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.slice(0, 10).split("-");
  return `${year}/${month}/${day}`;
}

export function formatDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function formatRefraction(value = {}) {
  const parts = [];
  if (Number.isFinite(value.sphere)) parts.push(`S${signed(value.sphere)}`);
  if (Number.isFinite(value.cylinder)) parts.push(`C${signed(value.cylinder)}`);
  if (Number.isFinite(value.axis)) parts.push(`Ax${value.axis}°`);
  return parts.join(" ");
}

export function patientLine(patient = {}) {
  const age = ageOn(patient.birthDate);
  return [
    patient.primaryPatientNumber ? `No.${patient.primaryPatientNumber}` : "",
    age === null ? "" : `${age}歳`,
    SEX_LABELS[patient.sex] || ""
  ].filter(Boolean).join(" ・ ");
}

export function diagnosisText(diagnosis = {}) {
  const status = DIAGNOSIS_STATUS_LABELS[diagnosis.status];
  return `${EYE_LABELS[diagnosis.eye] || ""} ${diagnosis.name}${status ? `（${status}）` : ""}`.trim();
}

export function prescriptionText(item = {}) {
  const details = [
    item.route === "inside" ? "院内" : "",
    item.eye ? EYE_LABELS[item.eye] : "",
    item.timesPerDay ? `1日${item.timesPerDay}回` : "",
    item.usage || "",
    item.issued === false ? "今回処方なし" : item.quantity ? `${item.quantity}${item.unit || ""}` : "",
    item.issued !== false && item.days ? `${item.days}日分` : ""
  ].filter(Boolean);
  return details.length ? `${item.name}（${details.join(" ")}）` : item.name;
}

function signed(value) {
  const fixed = Number(value).toFixed(2);
  return value > 0 ? `+${fixed}` : fixed;
}

export const APPOINTMENT_PURPOSE_LABELS = {
  revisit: "再診",
  initial: "初診",
  exam: "検査",
  injection: "注射",
  postop: "術後",
  contact_lens: "コンタクト",
  other: "その他"
};
export const APPOINTMENT_STATUS_LABELS = {
  booked: "予約",
  checked_in: "受付済",
  in_exam: "検査中",
  waiting_doctor: "診察待ち",
  in_consult: "診察中",
  checkout: "会計待ち",
  done: "終了",
  cancelled: "キャンセル",
  no_show: "来院なし"
};

export function minutesSince(iso, now = Date.now()) {
  if (!iso) return null;
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
}

export const COMMON_USAGES = ["就寝前", "朝", "朝・夕", "1日3回 朝昼夕", "1日4回 毎食後・就寝前", "疼痛時", "かゆい時", "起床時"];
export const PHRASE_TARGET_LABELS = {
  chiefComplaint: "主訴",
  history: "現病歴・経過",
  assessment: "評価",
  plan: "方針",
  staffNote: "スタッフメモ",
  "findings.anterior": "所見：前眼部",
  "findings.lens": "所見：中間透光体",
  "findings.fundus": "所見：眼底"
};
