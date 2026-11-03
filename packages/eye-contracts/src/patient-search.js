// 患者検索・患者登録で使う文字と日付の整形（ブラウザと eye-api の両方で使う純関数）。

// ひらがな（ぁ〜ゖ、ゝゞ）をカタカナにする。漢字・英数字・カタカナはそのまま。
export function toKatakana(value = "") {
  return String(value ?? "").replace(/[ぁ-ゖゝゞ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

// カタカナ（ァ〜ヶ、ヽヾ）をひらがなにする。登録時にひらがなで入ったフリガナを探すために使う。
export function toHiragana(value = "") {
  return String(value ?? "").replace(/[ァ-ヶヽヾ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

// 登録するフリガナの形をそろえる: 半角カナ → 全角（NFKC）、ひらがな → カタカナ、空白は 1 つ。
export function normalizeKanaName(value = "") {
  return toKatakana(String(value ?? "").normalize("NFKC")).replace(/\s+/gu, " ").trim();
}

// 検索語の候補。保存済みのフリガナがカタカナでもひらがなでも当たるよう、両方の形を返す。
export function patientSearchVariants(value = "") {
  const base = String(value ?? "").normalize("NFKC").trim();
  if (!base) return [];
  return [...new Set([base, toKatakana(base), toHiragana(base)])];
}

const ERAS = [
  { key: "R", name: "令和", offset: 2018, from: "2019-05-01", to: "9999-12-31" },
  { key: "H", name: "平成", offset: 1988, from: "1989-01-08", to: "2019-04-30" },
  { key: "S", name: "昭和", offset: 1925, from: "1926-12-25", to: "1989-01-07" },
  { key: "T", name: "大正", offset: 1911, from: "1912-07-30", to: "1926-12-24" },
  { key: "M", name: "明治", offset: 1867, from: "1868-01-25", to: "1912-07-29" }
];
const ERA_BY_TOKEN = new Map(ERAS.flatMap((era) => [[era.key, era], [era.name, era]]));

// 生年月日として読める入力なら YYYY-MM-DD を返す。読めなければ ""。
// 受け付ける形: 19500304 / 1950/3/4 / 1950-03-04 / 1950.3.4 / 1950年3月4日 / S25.3.4 / 昭和25年3月4日 / 令和元年5月1日
// 6 桁（500304）は世紀が決まらないので受け付けない。
export function parseBirthDateQuery(value = "") {
  const text = String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, "");
  if (!text) return "";
  let match = /^(\d{4})(\d{2})(\d{2})$/u.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/u.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(明治|大正|昭和|平成|令和|[MTSHRmtshr])(\d{1,2}|元)[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/u.exec(text);
  if (match) {
    const era = ERA_BY_TOKEN.get(match[1].toUpperCase()) || ERA_BY_TOKEN.get(match[1]);
    const eraYear = match[2] === "元" ? 1 : Number(match[2]);
    if (!era || eraYear < 1) return "";
    const iso = validDate(era.offset + eraYear, Number(match[3]), Number(match[4]));
    return iso && iso >= era.from && iso <= era.to ? iso : "";
  }
  return "";
}

// 和暦の短い表記（S25.3.4）。明治より前・不正な日付は ""。
export function formatBirthDateJp(iso = "") {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(iso ?? ""));
  if (!parts) return "";
  const era = eraOf(iso);
  if (!era) return "";
  return `${era.key}${Number(parts[1]) - era.offset}.${Number(parts[2])}.${Number(parts[3])}`;
}

// 和暦の年（昭和25年 / 令和元年）。
export function eraYearLabel(iso = "") {
  const parts = /^(\d{4})-\d{2}-\d{2}$/u.exec(String(iso ?? ""));
  const era = parts ? eraOf(iso) : null;
  if (!era) return "";
  const year = Number(parts[1]) - era.offset;
  return `${era.name}${year === 1 ? "元" : year}年`;
}

function eraOf(iso) {
  return ERAS.find((era) => iso >= era.from && iso <= era.to) || null;
}

function validDate(year, month, day) {
  if (year < 1868 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
