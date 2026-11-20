// API の入力エラー（payload.field と英語の message）を、画面に出す日本語にする。
// field は「content.prescriptions.1.quantity」の形（sections. で来ることもある）。

const SECTION_LABELS = {
  chiefComplaint: "主訴", history: "現病歴", exam: "検査値", findings: "所見", sketches: "シェーマ", diagnoses: "病名",
  assessment: "評価", plan: "方針", prescriptions: "処方", nextVisit: "次回受診", staffNote: "スタッフメモ",
  orders: "検査・処置", flags: "散瞳・フラグ", examConfirmations: "検査値の確認", optical: "眼鏡・CL",
  counselling: "説明・同意", adherence: "点眼アドヒアランス", examRecords: "検査記録", findingsText: "主訴・所見"
};
const KEY_LABELS = {
  quantity: "数量", unit: "単位", days: "日数", timesPerDay: "1日の回数", usage: "用法", name: "名前", eye: "眼",
  route: "院内・院外", note: "メモ", text: "コメント", status: "状態", intervalWeeks: "次回まで（週）", date: "日付",
  iop: "眼圧", vaUncorrected: "裸眼視力", vaCorrected: "矯正視力", sphere: "球面（S）", cylinder: "円柱（C）", axis: "軸（Ax）",
  pd: "瞳孔間距離（PD）", bc: "ベースカーブ（BC）", dia: "直径（DIA）", cdRatio: "C/D 比", planItems: "診療予定"
};
const ROW_LABELS = { prescriptions: "薬剤名", orders: "名前" };
const SIDE_LABELS = { od: "右眼", os: "左眼" };

// "content.prescriptions.1.quantity" → { path: "prescriptions.1.quantity", label: "処方 2行目の数量", short: "数量" }
export function fieldLabel(field = "") {
  const path = String(field || "").replace(/^(content|sections)\./u, "");
  if (!path) return { path: "", label: "", short: "" };
  const parts = path.split(".");
  const section = SECTION_LABELS[parts[0]] || "";
  const rest = parts.slice(1);
  const words = [];
  let short = "";
  for (const part of rest) {
    if (/^\d+$/u.test(part)) {
      words.push(`${Number(part) + 1}行目`);
    } else if (SIDE_LABELS[part]) {
      words.push(SIDE_LABELS[part]);
    } else if (KEY_LABELS[part]) {
      short = part === "name" ? ROW_LABELS[parts[0]] || KEY_LABELS.name : KEY_LABELS[part];
      words.push(`の${short}`);
    }
  }
  const label = `${section}${words.length ? " " : ""}${words.join("")}`.replace(/ の/u, "の").trim();
  return { path, label: label || section, short: short || section };
}

// 英語のメッセージを日本語の短い指示にする（分からない形は「値を確認してください」）。
export function fieldMessage(message = "", short = "") {
  const subject = short ? `${short}は` : "";
  const text = String(message || "");
  let match = text.match(/must be between (-?[\d.]+) and (-?[\d.]+)/u);
  if (match) return `${subject}${match[1]}〜${match[2]}で入れてください。`;
  match = text.match(/must be at most (\d+) characters/u);
  if (match) return `${subject}${match[1]}文字以内で入れてください。`;
  match = text.match(/must contain at most (\d+) items/u);
  if (match) return `${subject}${match[1]}件までです。`;
  if (/must be an integer/u.test(text)) return `${subject}整数で入れてください。`;
  if (/must be a number/u.test(text)) return `${subject}数字で入れてください。`;
  if (/must be one of/u.test(text)) return `${subject}選び直してください。`;
  if (/must be YYYY-MM-DD/u.test(text)) return `${subject}日付（年-月-日）で入れてください。`;
  if (/is required/u.test(text)) return `${subject}入力が必要です。`;
  if (/[ぁ-んァ-ン一-龠]/u.test(text)) return text;
  return `${short || "入力"}の値を確認してください。`;
}

// API の 400（field 付き）を画面の文にする。top: 画面上部の短いお知らせ、inline: 欄の横に出す文。
export function describeFieldError(field, message) {
  const { path, label, short } = fieldLabel(field);
  const inline = fieldMessage(message, short);
  return { path, label, inline, top: label ? `${label}: ${fieldMessage(message, "")}` : inline };
}
