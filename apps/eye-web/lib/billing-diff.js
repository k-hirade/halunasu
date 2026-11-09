// 会計連携の品目の差分と要約。画面と連絡票で使う（API とは独立した純粋な関数）。

export const BILLING_CATEGORIES = ["検査", "処置", "処方", "注射", "文書"];
const DETAIL_FIELDS = ["quantity", "unit", "days", "route", "usage", "note"];

// 区分ごとの件数の要約。「検査3 処方2 文書1」。0 件の区分は出さない。品目がなければ空文字。
export function itemSummary(items = []) {
  const counts = new Map();
  for (const item of items) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  const order = [...BILLING_CATEGORIES, ...[...counts.keys()].filter((key) => !BILLING_CATEGORIES.includes(key))];
  return order.filter((key) => counts.get(key)).map((key) => `${key}${counts.get(key)}`).join(" ");
}

// 区分ごとにまとめる（区分の並びは固定、区分内は元の順）。
export function groupByCategory(items = []) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const order = [...BILLING_CATEGORIES, ...[...groups.keys()].filter((key) => !BILLING_CATEGORIES.includes(key))];
  return order.filter((key) => groups.has(key)).map((category) => ({ category, items: groups.get(category) }));
}

// 前回連携した品目と今回の品目の差分。
// 同じ品目かどうかは「区分・コード・名称・眼」で見る（配列の順番は使わない）。同じ鍵が複数あるときは、
// まず全項目が一致するものどうしを組にし、残りを順に「変更」、余りを「追加」「削除」とする。
// 戻り値: [{ kind: "same" | "changed" | "added" | "removed", previous, current }]（今回の順 → 削除の順）
export function diffItems(previous = [], current = []) {
  const remaining = new Map();
  for (const item of previous) {
    const key = itemKey(item);
    if (!remaining.has(key)) remaining.set(key, []);
    remaining.get(key).push(item);
  }
  const rows = current.map((item) => ({ kind: "added", previous: null, current: item }));
  // 1 回目: 全項目が一致するもの
  for (const row of rows) {
    const candidates = remaining.get(itemKey(row.current));
    const index = candidates ? candidates.findIndex((item) => sameDetails(item, row.current)) : -1;
    if (index >= 0) {
      row.kind = "same";
      row.previous = candidates.splice(index, 1)[0];
    }
  }
  // 2 回目: 鍵は同じで中身が違うもの
  for (const row of rows) {
    if (row.kind !== "added") continue;
    const candidates = remaining.get(itemKey(row.current));
    if (candidates?.length) {
      row.kind = "changed";
      row.previous = candidates.shift();
    }
  }
  const removed = [...remaining.values()].flat().map((item) => ({ kind: "removed", previous: item, current: null }));
  return [...rows, ...removed];
}

// 一覧の行に出す差分のチップ。「+チモロール」「−ラタノプロスト」「~眼圧検査」
export function diffChips(rows = []) {
  const sign = { added: "+", removed: "−", changed: "~" };
  return rows.filter((row) => row.kind !== "same").map((row) => ({ kind: row.kind, label: `${sign[row.kind]}${(row.current || row.previous).name}` }));
}

function itemKey(item) {
  return JSON.stringify([item.category || "", item.code || "", item.name || "", item.eye || ""]);
}

function sameDetails(left, right) {
  return DETAIL_FIELDS.every((key) => normalize(left[key]) === normalize(right[key]));
}

function normalize(value) {
  return value === null || value === undefined ? "" : String(value);
}

// ───────── 会計連携の一覧（デジカルの受付一覧の［会計］と同じく、1 人ずつ連携する） ─────────

// 一覧のタブ。人が見るべきもの（未連携・再計待）を先に。
export const BILLING_TABS = [
  { key: "pending", label: "未連携" },
  { key: "changed", label: "再計待" },
  { key: "handed_off", label: "連携済" },
  { key: "draft", label: "未確定" }
];

const INACTIVE_APPOINTMENT = new Set(["cancelled", "absent", "no_show"]);

// その患者のこの日の受付。取消・不在は除き、会計待があればそれ、なければ来院の早いもの。
export function appointmentFor(patientId, appointments = []) {
  if (!patientId) return null;
  const mine = appointments.filter((item) => item.patientId === patientId && !INACTIVE_APPOINTMENT.has(item.status));
  if (!mine.length) return null;
  return mine.find((item) => item.status === "checkout") || [...mine].sort(byArrival)[0];
}

// 会計の状態: pending 未連携 / changed 再計待 / handed_off 連携済 / draft 未確定（修正中を含む）。
// 並びは受付番号の順（受付の無いカルテは後ろ、確定・更新の順）。
export function billingRows(day, appointments = []) {
  if (!day) return [];
  const finals = (day.encounters || []).map((item) => ({ key: item.encounterId, state: item.handoff?.state || "pending", item, patient: item.patient || {}, patientId: item.patient?.patientId || item.patientId || "" }));
  const drafts = (day.drafts || []).map((item) => ({ key: item.encounterId, state: "draft", item, patient: item.patientSnapshot || {}, patientId: item.patientId || item.patientSnapshot?.patientId || "" }));
  return [...finals, ...drafts]
    .map((row) => ({ ...row, appointment: appointmentFor(row.patientId, appointments) }))
    .sort((left, right) => byArrival(left.appointment || {}, right.appointment || {}) || String(timeOf(left)).localeCompare(String(timeOf(right))));
}

export function countByState(rows = []) {
  const counts = { all: rows.length };
  for (const tab of BILLING_TABS) counts[tab.key] = rows.filter((row) => row.state === tab.key).length;
  return counts;
}

// 受付番号の順（番号の無い予約は後ろ、同じなら受付時刻）
function byArrival(left, right) {
  const leftNumber = Number.isFinite(left.queueNumber) ? left.queueNumber : Number.POSITIVE_INFINITY;
  const rightNumber = Number.isFinite(right.queueNumber) ? right.queueNumber : Number.POSITIVE_INFINITY;
  if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
  return String(left.checkedInAt || left.time || "").localeCompare(String(right.checkedInAt || right.time || ""));
}

function timeOf(row) {
  return row.item.finalizedAt || row.item.updatedAt || "";
}
