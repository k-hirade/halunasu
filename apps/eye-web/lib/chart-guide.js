// カルテガイド（トプコンの「記入状況でボタンの色が変わる」）。中央の見出しの下に、項目ごとの記入状況を出す。
// state: done（入力済み）・warn（要確認）・todo（未入力）。target は押したときに移る欄の id。

import { hasExamValues } from "./exam-record.js";

const SIDES = ["od", "os"];

// 文字列・数値の入った値が 1 つでもあるか（所見の木を見る）
export function anyText(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(anyText);
  if (typeof value === "object") return Object.values(value).some(anyText);
  return false;
}


export const GUIDE_STATE_LABELS = Object.freeze({ done: "入力済み", warn: "要確認", todo: "未入力" });

export function chartGuide(content = {}, { profile = null, confirmations = null } = {}) {
  const exam = content.exam || {};
  const examFilled = SIDES.some((side) => hasExamValues(exam[side])) || (content.examRecords || []).length > 0;
  const examPending = confirmations ? SIDES.some((side) => !confirmations[side] && hasExamValues(exam[side])) : false;
  const rx = (content.prescriptions || []).filter((row) => row.kind !== "comment");
  const orders = (content.orders || []).filter((row) => row.kind !== "comment" && row.status !== "cancelled");
  // 注射は用法を持たない（デジカルの注射は回数だけ）ので、用法の未入力には数えない
  const usageMissing = rx.some((row) => row.kind !== "injection" && row.issued !== false && !row.timesPerDay && !String(row.usage || "").trim());
  const carried = rx.some((row) => row.carriedOver);
  const planned = orders.some((row) => row.status === "planned");
  const activeDx = (profile?.diagnoses || []).filter((item) => item.status !== "resolved");
  const next = content.nextVisit || {};
  return [
    { id: "complaint", label: "主訴", target: "sec-findings", state: anyText(content.chiefComplaint) || anyText(content.findingsText) ? "done" : "todo", hint: "" },
    { id: "exam", label: "検査", target: "sec-exam", state: !examFilled ? "todo" : examPending ? "warn" : "done", hint: examPending ? "検査値が未確認" : "" },
    { id: "findings", label: "所見", target: "sec-findings", state: anyText(content.findings) || (content.sketches || []).length ? "done" : "todo", hint: "" },
    { id: "diagnosis", label: "病名", target: "", state: activeDx.length ? "done" : "todo", hint: "" },
    { id: "rx", label: "処方", target: "sec-acts", state: !rx.length ? "todo" : usageMissing || carried ? "warn" : "done", hint: usageMissing ? "用法が未入力" : carried ? "引き継ぎが未確認" : "" },
    { id: "orders", label: "処置", target: "sec-acts", state: !orders.length ? "todo" : planned ? "warn" : "done", hint: planned ? "予定のまま" : "" },
    { id: "plan", label: "方針", target: "field-plan", state: anyText(content.plan) ? "done" : "todo", hint: "" },
    { id: "next", label: "次回", target: "sec-next-visit", state: next.intervalWeeks || next.date || (next.planItems || []).length ? "done" : "todo", hint: "" }
  ];
}
