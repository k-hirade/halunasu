// 患者の概要（トプコンの「カルテ概要」）に出す値の組み立て。描画から切り離してテストする。
// 今日のカルテ（下書きでも）に検査記録があればそれを、なければ前回の確定カルテの値を使う。
import { EYE_LABELS, formatVisualAcuityLine, VA_CORRECTION_TYPE_LABELS } from "./format.js";

const PLAN_EYE = { od: "右", os: "左", ou: "両" };

// 「34歳7ヵ月」
export function ageWithMonths(birthDate, onDate) {
  if (!birthDate || !onDate) return "";
  const [by, bm, bd] = birthDate.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = onDate.slice(0, 10).split("-").map(Number);
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  if (!Number.isFinite(months) || months < 0) return "";
  return `${Math.floor(months / 12)}歳${months % 12}ヵ月`;
}

// 日数の差を「1年2ヵ月3日」の形で。
export function elapsedLabel(fromIso, toIso) {
  if (!fromIso || !toIso) return "";
  const [fy, fm, fd] = fromIso.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = toIso.slice(0, 10).split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  let days = td - fd;
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(ty, tm - 1, 0)).getUTCDate();
  }
  if (months < 0) return "";
  const years = Math.floor(months / 12);
  return [years ? `${years}年` : "", months % 12 ? `${months % 12}ヵ月` : "", `${days}日`].join("");
}

function sorted(records = []) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => String(left.record.at).localeCompare(String(right.record.at)) || left.index - right.index)
    .map((item) => item.record);
}

function clockOf(iso) {
  const time = Date.parse(iso || "");
  return Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(11, 16) : "";
}

function examinerOf(record) {
  return record?.examinerName || record?.recordedBy?.displayName || "";
}

function hasVision(exam = {}) {
  return ["od", "os"].some((side) => exam[side]?.vaUncorrected || exam[side]?.vaCorrected);
}

// 最新の視力。{ date, isToday, time, examiner, type, far: {od, os}, near: {od, os} } か null
export function latestVision({ today = null, finalized = null, todayDate = "" } = {}) {
  for (const encounter of [today, finalized]) {
    const content = encounter?.content;
    if (!content || !hasVision(content.exam)) continue;
    const record = [...sorted(content.examRecords)].reverse().find((item) => item.values?.vision?.far) || null;
    const exam = content.exam;
    const type = exam.od?.vaCorrectionType || exam.os?.vaCorrectionType || "";
    const near = Object.fromEntries(["od", "os"].map((side) => {
      const row = record?.values?.vision?.near?.[side];
      const text = row ? formatVisualAcuityLine({ vaUncorrected: row.uncorrected, vaCorrected: row.corrected }) : exam[side]?.vaNear || "";
      return [side, text];
    }));
    return {
      date: encounter.encounterDate,
      isToday: encounter.encounterDate === todayDate,
      time: record ? clockOf(record.at) : "",
      examiner: examinerOf(record),
      type: VA_CORRECTION_TYPE_LABELS[type] || "矯正",
      far: Object.fromEntries(["od", "os"].map((side) => [side, formatVisualAcuityLine(exam[side] || {})])),
      near: near.od || near.os ? near : null
    };
  }
  return null;
}

// 最新の眼圧（3 回＋平均）。{ date, isToday, time, examiner, method, od: {readings, average}, os } か null
export function latestIop({ today = null, finalized = null, todayDate = "" } = {}) {
  for (const encounter of [today, finalized]) {
    const content = encounter?.content;
    if (!content) continue;
    const record = [...sorted(content.examRecords)].reverse().find((item) => ["od", "os"].some((side) => item.values?.iop?.[side]?.readings?.length)) || null;
    const exam = content.exam || {};
    if (!record && !["od", "os"].some((side) => Number.isFinite(exam[side]?.iop))) continue;
    const eye = (side) => {
      const values = record?.values?.iop?.[side];
      if (values?.readings?.length) return { readings: values.readings.map((item) => item.value), average: values.average ?? null };
      return Number.isFinite(exam[side]?.iop) && !record ? { readings: [exam[side].iop], average: exam[side].iop } : { readings: [], average: null };
    };
    const method = record ? record.values.iop.od?.method || record.values.iop.os?.method || "" : exam.od?.iopMethod || exam.os?.iopMethod || "";
    const measuredAt = record ? record.values.iop.od?.at || record.values.iop.os?.at || clockOf(record.at) : exam.od?.measuredAt || exam.os?.measuredAt || "";
    return {
      date: encounter.encounterDate,
      isToday: encounter.encounterDate === todayDate,
      time: measuredAt,
      examiner: examinerOf(record),
      method,
      od: eye("od"),
      os: eye("os")
    };
  }
  return null;
}

// 本日予定（部位＋項目）。今日のカルテの予定オーダー、なければ前回立てた次回予定。
export function todayPlan({ today = null, finalized = null } = {}) {
  const orders = (today?.content?.orders || []).filter((order) => order.kind !== "comment" && order.status !== "cancelled");
  if (orders.length) {
    return orders.map((order) => ({ key: order.orderId || order.name, eye: PLAN_EYE[order.eye] || "", name: order.name, done: order.status === "performed" }));
  }
  const items = finalized?.content?.nextVisit?.planItems || [];
  return items.map((item, index) => ({ key: `${item.code || item.name}-${index}`, eye: PLAN_EYE[item.eye] || "", name: item.name || item.code, done: false }));
}

// 病名（主病名を先頭、治癒は除く）
export function activeDiagnoses(profile, finalized) {
  const list = (profile?.diagnoses?.length ? profile.diagnoses : finalized?.content?.diagnoses || []).filter((item) => item.status !== "resolved");
  return [...list].sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)));
}

export function eyeLabel(eye) {
  return EYE_LABELS[eye] || "";
}
