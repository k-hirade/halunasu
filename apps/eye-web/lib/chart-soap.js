// SOAP の形で書くための手伝い（2026-11 要望 #40）。主訴・所見は 1 欄のまま（S/O/A/P の 4 欄には分けない）で、
// - 記載の型: 医師ごとのひな形。新しいカルテの主訴・所見が空なら API が入れる。カルテの「型を入れる」でも入れられる。
// - 定型文の S/O/A/P: 定型文ごとの区分（任意）。カルテの定型文の一覧を S・O・A・P・その他に分けて並べる。
import { PHRASE_TARGET_SOAP } from "./format.js";

export const SOAP_KEYS = ["S", "O", "A", "P", ""];
export const SOAP_GROUP_LABELS = { S: "S 主観", O: "O 客観", A: "A 評価", P: "P 計画", "": "その他" };
// 設定の選択肢。"" は差し込む欄から決める、none は区分なし（その他）。
export const PHRASE_SOAP_OPTIONS = [
  ["", "自動（欄から決める）"],
  ["S", "S 主観"],
  ["O", "O 客観"],
  ["A", "A 評価"],
  ["P", "P 計画"],
  ["none", "その他（区分なし）"]
];

// 設定の「例から入れる」に出す記載の型
export const BUILTIN_CHART_TEMPLATES = [
  { id: "soap", label: "SOAP", text: "S)\nO)\nA)\nP)" },
  { id: "followup", label: "眼科の経過観察", text: "S) 自覚症状：\nO) VA：　IOP：\n　前眼部：\n　眼底：\nA) \nP) 点眼継続、次回 　週後" },
  { id: "initial", label: "眼科の初診", text: "主訴：\n現病歴：\n既往・内服：\n所見：\n　前眼部：\n　中間透光体：\n　眼底：\n評価：\n方針：" }
];

const PREFIX = /^\s*[(（]?([SOAPsoap])[)）:：]/u;

// 定型文の区分。決めてあればそれ、無ければ本文の頭（「S)」など）か差し込む欄から決める。決まらなければ ""（その他）。
export function phraseSoap(phrase = {}) {
  if (phrase.soap === "none") return "";
  if (["S", "O", "A", "P"].includes(phrase.soap)) return phrase.soap;
  const fromTarget = PHRASE_TARGET_SOAP[phrase.target];
  if (fromTarget) return fromTarget;
  const match = PREFIX.exec(String(phrase.text || ""));
  return match ? match[1].toUpperCase() : "";
}

// 有効な定型文を S・O・A・P・その他の順に分ける（空の区分は出さない）。filter に区分を渡すとその区分だけ。
export function groupPhrasesBySoap(phrases = [], filter = null) {
  const active = phrases.filter((item) => item.active !== false);
  return SOAP_KEYS
    .filter((key) => filter === null || filter === key)
    .map((key) => ({ key, label: SOAP_GROUP_LABELS[key], items: active.filter((item) => phraseSoap(item) === key) }))
    .filter((group) => group.items.length);
}

// 絞り込みのチップ（すべて + 定型文のある区分）
export function soapFilterOptions(phrases = []) {
  const active = phrases.filter((item) => item.active !== false);
  return [
    { value: null, label: "すべて", count: active.length },
    ...SOAP_KEYS.map((key) => ({ value: key, label: key || "その他", count: active.filter((item) => phraseSoap(item) === key).length })).filter((option) => option.count > 0)
  ];
}

const trimEnd = (text) => String(text || "").replace(/\r\n?/gu, "\n").replace(/\s+$/u, "");

// 主訴・所見が記載の型のまま（何も書き足していない）か
export function isUntouchedTemplate(text, templates = []) {
  const current = trimEnd(text);
  return Boolean(current) && templates.some((item) => trimEnd(item?.text) === current);
}

// 前回の主訴・所見を写すとき、型のままの欄は空とみなして置き換える（型の下に前回の文が足されないように）。
// 写す文が無いとき・書き足してあるときはそのまま。
export function clearUntouchedTemplate(content, incomingText, templates = []) {
  if (!trimEnd(incomingText) || !isUntouchedTemplate(content?.findingsText, templates)) return content;
  return { ...content, findingsText: "" };
}

// 複写の前に、型のままの主訴・所見を空にする（主訴・所見を写す複写だけ。処方・オーダーだけの複写では触らない）
const TEXT_COPY_KINDS = new Set(["left", "all", "text"]);
export function copyBaseContent(content, sourceContent, kind, templates = []) {
  return TEXT_COPY_KINDS.has(kind) ? clearUntouchedTemplate(content, sourceContent?.findingsText, templates) : content;
}

// カルテの「型を入れる」の候補。このカルテの担当医の型 → 自分の型 → ほかの医師の型の順。
export function orderChartTemplates(templates = [], { encounterMemberId = "", selfMemberId = "", names = {} } = {}) {
  const rank = (item) => (item.memberId === encounterMemberId ? 0 : item.memberId === selfMemberId ? 1 : 2);
  return templates
    .filter((item) => String(item?.text || "").trim())
    .map((item) => ({ ...item, name: names[item.memberId] || "医師" }))
    .sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name, "ja"));
}
