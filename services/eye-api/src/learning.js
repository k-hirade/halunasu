import { COMMENT_KIND, LEARNING_CATEGORIES, isSuspectedDiagnosis } from "../../../packages/eye-contracts/src/index.js";
import { groupRps } from "../../../packages/eye-core/src/index.js";

// 学習リスト: この医院で確定したカルテから、よく使う束（処方の Rp・オーダーの Rp・病名）を回数の多い順に返す。
// デジカルの右パネルの「学習リスト」にあたる。読む範囲は直近 LEARNING_WINDOW_DAYS 日・最大 LEARNING_SCAN_LIMIT 件に限り、
// 結果は医院ごとに LEARNING_TTL_MS のあいだ覚えておく（同じ医院の連続した表示でカルテを読み直さないため）。

export const LEARNING_WINDOW_DAYS = 180;
export const LEARNING_SCAN_LIMIT = 500;
export const LEARNING_TTL_MS = 10 * 60 * 1000;
export const LEARNING_ITEM_LIMIT = 50;

const caches = new WeakMap();

export async function learningList(eyeStore, orgId, { category = "", now = new Date() } = {}) {
  const all = await cachedAggregate(eyeStore, orgId, now);
  const categories = category ? [category] : LEARNING_CATEGORIES;
  return {
    generatedAt: all.generatedAt,
    scannedEncounters: all.scannedEncounters,
    windowDays: LEARNING_WINDOW_DAYS,
    items: Object.fromEntries(categories.map((key) => [key, all.items[key]]))
  };
}

async function cachedAggregate(eyeStore, orgId, now) {
  if (!caches.has(eyeStore)) caches.set(eyeStore, new Map());
  const cache = caches.get(eyeStore);
  const hit = cache.get(orgId);
  if (hit && now.getTime() - hit.at < LEARNING_TTL_MS) return hit.value;
  const sinceIso = new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86400000).toISOString();
  const encounters = (await eyeStore.listRecentFinalizedEncounters(orgId, { sinceIso, limit: LEARNING_SCAN_LIMIT }))
    .filter((encounter) => encounter.status === "finalized");
  const value = { generatedAt: now.toISOString(), scannedEncounters: encounters.length, items: aggregateLearning(encounters) };
  cache.set(orgId, { at: now.getTime(), value });
  return value;
}

// 確定のたびに、その医院の分を捨てる（次の表示で読み直す）。
export function invalidateLearningCache(eyeStore, orgId) {
  caches.get(eyeStore)?.delete(orgId);
}

export function aggregateLearning(encounters = []) {
  const tallies = Object.fromEntries(LEARNING_CATEGORIES.map((key) => [key, new Map()]));
  for (const encounter of encounters) {
    const content = encounter.content || {};
    const usedAt = encounter.finalizedAt || encounter.encounterDate || "";
    for (const group of groupRps(content.prescriptions || [])) {
      const bundle = prescriptionBundle(group);
      if (bundle) count(tallies.prescription, bundle, usedAt);
    }
    for (const group of groupRps(content.orders || [])) {
      const bundle = orderBundle(group);
      if (bundle) count(tallies.order, bundle, usedAt);
    }
    for (const diagnosis of content.diagnoses || []) {
      const bundle = diagnosisBundle(diagnosis);
      if (bundle) count(tallies.diagnosis, bundle, usedAt);
    }
  }
  return Object.fromEntries(LEARNING_CATEGORIES.map((key) => [key, [...tallies[key].values()]
    .sort((left, right) => right.count - left.count || String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)) || left.label.localeCompare(right.label, "ja"))
    .slice(0, LEARNING_ITEM_LIMIT)]));
}

function count(tally, bundle, usedAt) {
  const current = tally.get(bundle.key);
  if (current) {
    current.count += 1;
    if (String(usedAt) > String(current.lastUsedAt)) current.lastUsedAt = usedAt;
    return;
  }
  const { key, ...rest } = bundle;
  tally.set(key, { key, ...rest, count: 1, lastUsedAt: usedAt });
}

// 処方の束: 薬剤（名称・コード・種類・数量・単位）と、Rp の指示（眼・回数・用法・日数・院内外）とコメント。
function prescriptionBundle(group) {
  const items = group.items.map(({ row }) => row).filter((row) => String(row.name || "").trim());
  if (!items.length) return null;
  const head = items[0];
  const rows = [
    ...items.map((row) => clean({
      kind: row.kind, name: row.name, drugCode: row.drugCode, presetId: row.presetId, quantity: row.quantity, unit: row.unit,
      eye: row.eye, timesPerDay: row.timesPerDay, usage: row.usage, days: row.days, route: row.route
    })),
    ...group.comments.map(({ row }) => clean({ kind: COMMENT_KIND, text: row.text, scope: row.scope })).filter((row) => row.text)
  ];
  const rp = clean({ eye: head.eye, timesPerDay: head.timesPerDay, usage: head.usage, days: head.days, route: head.route });
  return {
    key: JSON.stringify(["rx", rows.map((row) => [row.kind, row.drugCode || row.name || row.text, row.quantity ?? null, row.unit || ""]), rp]),
    label: items.map((row) => row.name).join("・"),
    rp,
    rows
  };
}

// オーダーの束: 行為（名称・コード・種類・眼）とコメント。実施・取消の状態は束に含めない。
function orderBundle(group) {
  const items = group.items.map(({ row }) => row).filter((row) => row.status !== "cancelled" && String(row.name || row.code || "").trim());
  if (!items.length) return null;
  const rows = [
    ...items.map((row) => clean({ kind: row.kind, code: row.code, procedureCode: row.procedureCode, name: row.name, eye: row.eye })),
    ...group.comments.map(({ row }) => clean({ kind: COMMENT_KIND, text: row.text, scope: row.scope })).filter((row) => row.text)
  ];
  return {
    key: JSON.stringify(["order", rows.map((row) => [row.kind, row.procedureCode || row.code || row.name || row.text, row.eye || ""])]),
    label: items.map((row) => row.name || row.code).join("・"),
    rows
  };
}

function diagnosisBundle(diagnosis) {
  const name = String(diagnosis.name || "").trim();
  if (!name) return null;
  const row = clean({
    name,
    code: diagnosis.code,
    eye: diagnosis.eye,
    modifiers: Array.isArray(diagnosis.modifiers) && diagnosis.modifiers.length ? diagnosis.modifiers : undefined,
    suspected: isSuspectedDiagnosis(diagnosis) || undefined
  });
  return {
    key: JSON.stringify(["dx", row.code || name, row.eye || "", (row.modifiers || []).map((item) => item.code || item.name), Boolean(row.suspected)]),
    label: name,
    rows: [row]
  };
}

function clean(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
