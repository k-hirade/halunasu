// 施設管理（replicate-2 で増やした項目）・利用者管理・経営データ集計の、画面から切り離した小さな関数と定数。

// ───────── 医療機関情報（デジカルの編集画面の項目順: 名前・フリガナ・コード・代表者・郵便番号・住所・電話・FAX・院内院外・適格事業者番号） ─────────
export const FACILITY_EDIT_FIELDS = [
  { key: "name", label: "医療機関名", max: 100 },
  { key: "nameKana", label: "フリガナ（医療機関）", max: 100, placeholder: "カタカナ" },
  { key: "medicalInstitutionCode", label: "医療機関コード", max: 20, inputMode: "numeric", placeholder: "10桁" },
  { key: "representative", label: "代表者名", max: 100 },
  { key: "representativeKana", label: "フリガナ（代表者）", max: 100, placeholder: "カタカナ" },
  { key: "founder", label: "開設者", max: 100 },
  { key: "administrator", label: "管理者", max: 100 },
  { key: "email", label: "メールアドレス", max: 200, type: "email" },
  { key: "postalCode", label: "郵便番号", max: 10, inputMode: "numeric", placeholder: "123-4567" },
  { key: "address", label: "住所", max: 200, placeholder: "都道府県から 1 行で" },
  { key: "phone", label: "電話番号", max: 30, inputMode: "tel", type: "tel" },
  { key: "fax", label: "FAX番号", max: 30, inputMode: "tel", type: "tel" },
  { key: "prescriptionRoute", label: "院内・院外", options: [["", "未設定"], ["outside", "院外"], ["inside", "院内"]] },
  { key: "invoiceRegistrationNumber", label: "適格事業者番号", max: 20, placeholder: "T から始まる14文字" }
];
export const PRESCRIPTION_ROUTE_LABELS = { outside: "院外", inside: "院内" };

export function facilityDisplayValue(key, value) {
  if (key === "prescriptionRoute") return PRESCRIPTION_ROUTE_LABELS[value] || "";
  return value || "";
}

// ───────── 利用者管理 ─────────
// デジカルの役割（医師・医師以外の医療従事者・受付）を、眼科の役割に置き換えた選択肢。施設管理権限は眼科の admin。
export const USER_ROLE_OPTIONS = [
  ["doctor", "医師"],
  ["orthoptist", "視能訓練士"],
  ["nurse", "看護師"],
  ["medical_clerk", "医療事務・受付"],
  ["viewer", "閲覧のみ"]
];
const ROLE_KEYS = new Set(USER_ROLE_OPTIONS.map(([value]) => value));

export function eyeRolesOf(member, productId = "eye") {
  return Array.isArray(member?.productRoles?.[productId]) ? member.productRoles[productId] : [];
}

// 役割（複数可）と施設管理権限から、眼科の productRoles を作る（ほかの製品の役割と、ここに無い眼科の役割はそのまま残す）。
export function nextProductRoles(member, { roles = [], admin }, productId = "eye") {
  const others = Object.fromEntries(Object.entries(member?.productRoles || {}).filter(([key]) => key !== productId));
  const kept = eyeRolesOf(member, productId).filter((item) => item !== "admin" && !ROLE_KEYS.has(item));
  const chosen = USER_ROLE_OPTIONS.map(([value]) => value).filter((value) => roles.includes(value));
  return { ...others, [productId]: [...new Set([...chosen, ...kept, ...(admin ? ["admin"] : [])])] };
}

// 仮のパスワード（14 文字。紛らわしい文字は使わない）。利用者に伝え、ログイン後に変えてもらう。
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export function temporaryPassword(random = defaultRandom) {
  const bytes = random(14);
  let text = "";
  for (let index = 0; index < 14; index += 1) text += PASSWORD_ALPHABET[bytes[index] % PASSWORD_ALPHABET.length];
  // 英大文字・英小文字・数字を必ず含める
  if (!/[A-Z]/u.test(text)) text = `K${text.slice(1)}`;
  if (!/[a-z]/u.test(text)) text = `${text.slice(0, 1)}m${text.slice(2)}`;
  if (!/\d/u.test(text)) text = `${text.slice(0, -1)}7`;
  return text;
}

function defaultRandom(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export const LOGIN_ID_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/u;

// ───────── 経営データ集計 CSV ─────────
export function csvText(rows) {
  const cell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    // 数式として読まれないよう、先頭が = + - @ の文字列は ' を付ける（CSV インジェクション対策）
    const safe = /^[=+\-@\t\r]/u.test(text) && !/^-?\d+(\.\d+)?$/u.test(text) ? `'${text}` : text;
    return /[",\n\r]/u.test(safe) ? `"${safe.replaceAll("\"", "\"\"")}"` : safe;
  };
  // Excel で文字化けしないよう BOM を付ける
  return `﻿${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function dailyReportRows(report) {
  return [
    ["日付", "予約", "来院", "初診", "再診ほか", "予約なし来院", "取消", "不在"],
    ...report.days.map((day) => [day.date, day.booked, day.arrived, day.initial, day.revisit, day.walkIn, day.cancelled, day.absent]),
    ["合計", report.totals.booked, report.totals.arrived, report.totals.initial, report.totals.revisit, report.totals.walkIn, report.totals.cancelled, report.totals.absent]
  ];
}

export function monthlyReportRows(report) {
  return [
    ["月", "来院", "初診", "再診ほか", "取消", "不在", "来院のあった日数"],
    ...report.months.map((month) => [month.month, month.arrived, month.initial, month.revisit, month.cancelled, month.absent, month.openDays])
  ];
}

export function visitReportRows(report, { doctors = {}, includeMemo = false } = {}) {
  return [
    ["日付", "受付番号", "予約時刻", "受付時刻", "患者番号", "氏名", "目的", "予約なし", "状態", "診療科", "医師", ...(includeMemo ? ["受付メモ"] : [])],
    ...report.visits.map((visit) => [
      visit.date, visit.queueNumber, visit.time, japanTime(visit.checkedInAt), visit.patientNumber, visit.patientName, visit.purpose,
      visit.walkIn ? "○" : "", visit.status, visit.department, doctors[visit.doctorMemberId] || "", ...(includeMemo ? [visit.receptionMemo || ""] : [])
    ])
  ];
}

function japanTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

// 期間の日数（両端を含む）
export function rangeDays(from, to) {
  if (!from || !to) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

export function monthRange(today) {
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

// ───────── 文書雛形 ─────────
export const TEMPLATE_PLACEHOLDERS = ["患者氏名", "フリガナ", "生年月日", "年齢", "性別", "傷病名", "処方", "視力", "眼圧", "所見", "主訴", "方針", "アレルギー", "既往歴", "受診日", "発行日", "医療機関名", "医師名"];
export const DOC_TYPE_LABELS = { referral: "紹介状", reply: "返書", certificate: "診断書", other: "その他" };

// ───────── 受付ラベル・患者マーク・診療時間 ─────────
// 患者マークの色（受付の画面の rc-mark と同じ名前）
export const MARK_TONE_OPTIONS = [["teal", "青緑"], ["blue", "青"], ["green", "緑"], ["amber", "黄"], ["red", "赤"], ["neutral", "灰"]];
export const WEEKDAY_LABELS = [["mon", "月"], ["tue", "火"], ["wed", "水"], ["thu", "木"], ["fri", "金"], ["sat", "土"], ["sun", "日"], ["holiday", "祝"]];
export const SLOT_MINUTE_OPTIONS = [10, 15, 20, 30, 60];

export function hoursText(ranges = []) {
  return ranges.length ? ranges.map((range) => `${range.from}〜${range.to}`).join("・") : "休診";
}

// 何も入れていないかどうか（受付の画面などが既定の動きに戻すときに使う）
export function hasClinicHours(hours) {
  return Boolean(hours?.days && Object.values(hours.days).some((ranges) => ranges.length));
}

// 一覧の中で ID の重ならない新しい行を作るときの仮の ID（保存時にサーバーが本当の ID を付ける）
export function newRowKey() {
  return `new_${Math.random().toString(36).slice(2, 10)}`;
}

// 送る前に、仮の ID（new_）を外す
export function stripNewIds(items, idKey) {
  return items.map((item) => (String(item[idKey] || "").startsWith("new_") ? { ...item, [idKey]: "" } : item));
}

// ───────── 文書: 項目ごとの入力 ─────────
// 最初の【見出し】より前（前文）だけを置き換える。見出しより後ろには触れない。
export function setPreamble(body, text) {
  const lines = String(body || "").split("\n");
  const first = lines.findIndex((line) => /^【[^】\n]+】/u.test(line));
  const rest = first < 0 ? [] : lines.slice(first);
  const next = String(text || "").replace(/\s+$/u, "");
  return [...(next ? next.split("\n") : []), ...(next && rest.length ? [""] : []), ...rest].join("\n");
}
