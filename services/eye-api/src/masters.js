import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MASTER_TYPES } from "./master-parse.js";

// 公開マスター（医薬品・傷病名・修飾語・診療行為）のメモリ内検索。
// データは scripts/build_eye_masters.mjs が作る services/eye-api/data/masters/*.json。無ければ空の検索になる。

export const DEFAULT_MASTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "masters");
export const MASTER_SEARCH_LIMIT = 30;

// 検索の表記ゆれをそろえる: 全角・半角（NFKC）、ひらがな → カタカナ、大文字 → 小文字、空白・中黒を除く。
export function normalizeMasterQuery(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[ぁ-ゖ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60))
    .toLowerCase()
    .replace(/[\s・･]/gu, "");
}

export function createMasterIndex(data = {}) {
  const tables = Object.fromEntries(MASTER_TYPES.map((type) => [type, (data[type] || []).map((record) => ({
    record,
    // 名称（と、あれば正式名称・一般名）とカナ
    names: [record.name, record.longName, record.generic].filter(Boolean).map(normalizeMasterQuery),
    kana: normalizeMasterQuery(record.kana)
  }))]));
  const byCode = Object.fromEntries(MASTER_TYPES.map((type) => [type, new Map(tables[type].map((entry) => [String(entry.record.code), entry.record]))]));
  return {
    counts: Object.fromEntries(MASTER_TYPES.map((type) => [type, tables[type].length])),
    // コードで引く（カルテの行・学習リストに点数・薬価を出すため）。無いコードは返さない。
    lookup: (type, codes = []) => lookupCodes(byCode[type], codes),
    available: (type) => tables[type].length > 0,
    search: ({ type, q, limit = MASTER_SEARCH_LIMIT, eyeOnly = false }) => searchTable(tables[type] || [], { q, limit, eyeOnly })
  };
}

// 前方一致 → 部分一致の順。同じ順位の中では眼科のもの、短い名称、コードの順。
// 空白で区切った語は、すべてを含むものだけを返す（順位は最初の語で決める）。
function searchTable(table, { q, limit, eyeOnly }) {
  const terms = String(q || "").split(/[\s　]+/u).map(normalizeMasterQuery).filter(Boolean);
  if (!terms.length) return [];
  const [first, ...rest] = terms;
  const hits = [];
  for (const entry of table) {
    if (eyeOnly && !entry.record.eye) continue;
    const haystacks = [...entry.names, entry.kana];
    if (!rest.every((term) => haystacks.some((text) => text.includes(term)))) continue;
    let tier = -1;
    if (haystacks.some((text) => text.startsWith(first))) tier = 0;
    else if (haystacks.some((text) => text.includes(first))) tier = 1;
    if (tier < 0) continue;
    hits.push({ tier, entry });
  }
  hits.sort((left, right) => (
    left.tier - right.tier
    || Number(Boolean(right.entry.record.eye)) - Number(Boolean(left.entry.record.eye))
    || left.entry.record.name.length - right.entry.record.name.length
    || String(left.entry.record.code).localeCompare(String(right.entry.record.code))
  ));
  return hits.slice(0, limit).map((hit) => ({ ...hit.entry.record, match: hit.tier === 0 ? "prefix" : "contains" }));
}

export const MASTER_LOOKUP_LIMIT = 100;

function lookupCodes(table, codes) {
  if (!table) return [];
  const seen = new Set();
  const results = [];
  for (const raw of codes) {
    const code = String(raw || "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const record = table.get(code);
    if (record) results.push(record);
  }
  return results;
}

// codes=a,b,c の文字列を検査して配列にする（英数字だけ・最大 MASTER_LOOKUP_LIMIT 件）。
export function parseLookupCodes(value) {
  const codes = [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
  if (codes.length > MASTER_LOOKUP_LIMIT) {
    const error = new Error(`codes must be ${MASTER_LOOKUP_LIMIT} or fewer`);
    error.name = "BadRequestError";
    error.statusCode = 400;
    error.field = "codes";
    throw error;
  }
  for (const code of codes) {
    if (!/^[0-9A-Za-z]{1,20}$/u.test(code)) {
      const error = new Error("codes must be alphanumeric");
      error.name = "BadRequestError";
      error.statusCode = 400;
      error.field = "codes";
      throw error;
    }
  }
  return codes;
}

export function loadMasterData(dir = DEFAULT_MASTER_DIR) {
  const data = {};
  for (const type of MASTER_TYPES) {
    const file = join(dir, `${type}.json`);
    data[type] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  }
  const metaFile = join(dir, "meta.json");
  return { data, meta: existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : null };
}

let defaultIndex = null;

// 最初の検索のときに一度だけ読む（起動を遅くしないため）。
export function defaultMasterIndex() {
  if (!defaultIndex) {
    const { data, meta } = loadMasterData();
    defaultIndex = { ...createMasterIndex(data), meta };
  }
  return defaultIndex;
}
