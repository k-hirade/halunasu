// 表示の設定（利用者メニュー →「表示の設定」）。端末ごと・利用者ごと（病院 + 利用者の ID）に覚える。
// - ヘッダーのアイコン: 出す・隠す・並び順。検索・ヘルプ・利用者メニューはいつも出す。権限の無い項目は設定に関係なく出さない。
// - カルテ左の「患者の情報」のタブ: 出す・隠す・並び順（1 つは必ず出す）。
//   Shift+数字のキーは並べ替えても元の割り当てのまま（ヘルプの一覧と同じ）。隠したタブもキーやボタンから開ける（開いている間だけタブの並びの最後に出す）。
// - カルテガイドの表示、文字の大きさ（標準・大）。
// 読めない・書けない環境では既定（いままでの表示）に戻る。

export const NAV_ITEMS = Object.freeze([
  { id: "reception", label: "受付画面" },
  { id: "list", label: "患者リスト" },
  { id: "schedule", label: "予約状況" },
  { id: "billing", label: "会計連携" },
  { id: "settings", label: "施設管理・セット管理" },
  { id: "audit", label: "操作記録" },
  { id: "report", label: "経営データ集計" },
  { id: "dark", label: "暗室" }
]);
export const NAV_IDS = Object.freeze(NAV_ITEMS.map((item) => item.id));
// encounter-panels.js の LEFT_TABS と同じ並び（既定の並び）
export const LEFT_TAB_IDS = Object.freeze(["info", "interview", "allergy", "vitals", "exam", "history", "drugs", "files", "summary", "diagnoses"]);
export const TEXT_SIZES = Object.freeze({ standard: "標準", large: "大" });

export const DEFAULT_DISPLAY_PREFS = Object.freeze({
  nav: Object.freeze({ order: NAV_IDS, hidden: Object.freeze([]) }),
  leftTabs: Object.freeze({ order: LEFT_TAB_IDS, hidden: Object.freeze([]) }),
  guide: true,
  textSize: "standard"
});

export const DISPLAY_PREFS_EVENT = "halunasu-eye-display-prefs";
const STORAGE_PREFIX = "halunasu-eye-display";
// 文字の大きさは最初の描画より前に当てたいので、最後に使った値を端末にも写しておく（利用者が分かる前に読む）
export const TEXT_SIZE_STORAGE_KEY = "halunasu-eye-text-size";
export const TEXT_SIZE_BOOT_SCRIPT = `try{if(window.localStorage.getItem(${JSON.stringify(TEXT_SIZE_STORAGE_KEY)})==="large"){document.documentElement.dataset.textSize="large"}}catch(e){}`;

export function displayPrefsKey(orgId, memberId) {
  return orgId && memberId ? `${STORAGE_PREFIX}:${orgId}:${memberId}` : "";
}

// 並び順: 知らない ID・重なりを除き、足りない ID は既定の位置の近く（既定で前にある ID の後ろ）に足す
function normalizeOrder(order, ids) {
  const seen = new Set();
  const result = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (ids.includes(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  ids.forEach((id, index) => {
    if (seen.has(id)) return;
    const before = ids.slice(0, index).reverse().find((other) => seen.has(other));
    result.splice(before ? result.indexOf(before) + 1 : 0, 0, id);
    seen.add(id);
  });
  return result;
}

function normalizeList(value, ids) {
  const order = normalizeOrder(value?.order, ids);
  const hidden = [...new Set((Array.isArray(value?.hidden) ? value.hidden : []).filter((id) => ids.includes(id)))];
  return { order, hidden };
}

export function normalizeDisplayPrefs(value) {
  const source = value && typeof value === "object" ? value : {};
  const nav = normalizeList(source.nav, NAV_IDS);
  const leftTabs = normalizeList(source.leftTabs, LEFT_TAB_IDS);
  // 左のタブは 1 つは必ず出す（全部隠したら既定の診療履歴を出す）
  if (leftTabs.hidden.length >= LEFT_TAB_IDS.length) leftTabs.hidden = leftTabs.hidden.filter((id) => id !== "history");
  return {
    nav,
    leftTabs,
    guide: source.guide !== false,
    textSize: source.textSize === "large" ? "large" : "standard"
  };
}

// 出す項目を並び順で返す（items は id を持つもの。権限で出せない項目は items に入れない）
export function arrangeItems(items, list) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const order = list?.order || [];
  const hidden = new Set(list?.hidden || []);
  const ordered = [...order.filter((id) => byId.has(id)), ...items.map((item) => item.id).filter((id) => !order.includes(id))];
  return ordered.filter((id) => !hidden.has(id)).map((id) => byId.get(id));
}

// 1 つ上・下へ動かす（visibleIds = 画面に並べている ID。権限の無い項目をまたいで動かすため、その中の隣と入れ替える）
export function moveItem(list, id, direction, visibleIds = list.order) {
  const position = visibleIds.indexOf(id);
  const neighbor = visibleIds[position + direction];
  if (position < 0 || !neighbor) return list;
  const order = [...list.order];
  const from = order.indexOf(id);
  const to = order.indexOf(neighbor);
  order[from] = neighbor;
  order[to] = id;
  return { ...list, order };
}

export function setItemHidden(list, id, hidden) {
  const rest = list.hidden.filter((other) => other !== id);
  return { ...list, hidden: hidden ? [...rest, id] : rest };
}

export function readDisplayPrefs(key, storage = globalThis.localStorage) {
  if (!key) return normalizeDisplayPrefs(null);
  try {
    const raw = storage?.getItem(key);
    return normalizeDisplayPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeDisplayPrefs(null);
  }
}

export function writeDisplayPrefs(key, prefs, storage = globalThis.localStorage) {
  const value = normalizeDisplayPrefs(prefs);
  try {
    if (key) storage?.setItem(key, JSON.stringify(value));
    storage?.setItem(TEXT_SIZE_STORAGE_KEY, value.textSize);
  } catch {
    // 保存できない環境では今回の表示だけ切り替える
  }
  return value;
}
