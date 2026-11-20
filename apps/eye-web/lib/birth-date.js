// 生年月日の入力（和暦・西暦）を読む（画面から切り離した純粋な関数）。
// 受け付ける形（数字は全角でもよい・元号の英字は大文字小文字どちらでも）:
//   和暦: S50.1.1 / S50/1/1 / S50-1-1 / S500101 / 昭和50年1月1日 / 令和元年5月1日 / H1.1.8 / R6.4.1 / T15.12.24 / M45.7.29
//   西暦: 19750101 / 1975/1/1 / 1975-01-01 / 1975.1.1 / 1975年1月1日
// 元号の境目も確かめる（平成は 1989-01-08 から、昭和64年は 1月7日まで、令和は 2019-05-01 から など）。

export const ERAS = Object.freeze([
  { key: "R", name: "令和", offset: 2018, from: "2019-05-01", to: "9999-12-31" },
  { key: "H", name: "平成", offset: 1988, from: "1989-01-08", to: "2019-04-30" },
  { key: "S", name: "昭和", offset: 1925, from: "1926-12-25", to: "1989-01-07" },
  { key: "T", name: "大正", offset: 1911, from: "1912-07-30", to: "1926-12-24" },
  { key: "M", name: "明治", offset: 1867, from: "1868-01-25", to: "1912-07-29" }
]);
const ERA_BY_TOKEN = new Map(ERAS.flatMap((era) => [[era.key, era], [era.name, era]]));
const EXAMPLE = "例: S50.1.1、昭和50年1月1日、19750101";

// 戻り値: { iso, error }。空なら { iso: "", error: "" }。読めたら iso（YYYY-MM-DD）、読めなければ error（画面に出す文）。
// today（YYYY-MM-DD）を渡すと、それより後の日付は誤りにする。
export function parseBirthDateInput(value, { today = "" } = {}) {
  const text = String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, "");
  if (!text) return { iso: "", error: "" };
  const parts = splitInput(text);
  if (!parts) return { iso: "", error: `読めません（${EXAMPLE}）` };
  const { era, eraYear, month, day } = parts;
  const year = era ? era.offset + eraYear : parts.year;
  if (era && eraYear < 1) return { iso: "", error: `${era.name}は元年（1年）からです` };
  if (month < 1 || month > 12) return { iso: "", error: "月は1〜12で入れてください" };
  const iso = validDate(year, month, day);
  if (!iso) return { iso: "", error: `${month}月${day}日はありません` };
  if (era && (iso < era.from || iso > era.to)) {
    return { iso: "", error: `${era.name}${eraYearText(eraYear)}年${month}月${day}日はありません（${era.name}は${rangeText(era)}）` };
  }
  if (!era && iso < ERAS.at(-1).from) return { iso: "", error: "明治より前の日付は入れられません" };
  if (today && iso > today) return { iso: "", error: "今日より後の日付です" };
  return { iso, error: "" };
}

// 「1975年1月1日（昭和50年）」。読めない日付は ""。
export function birthDateLabel(iso) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(iso ?? ""));
  if (!parts) return "";
  const era = eraOf(iso);
  const western = `${Number(parts[1])}年${Number(parts[2])}月${Number(parts[3])}日`;
  return era ? `${western}（${era.name}${eraYearText(Number(parts[1]) - era.offset)}年）` : western;
}

// 入力欄に出す短い和暦（S50.1.1）。明治より前は西暦（1860/1/1）。
export function birthDateShort(iso) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(iso ?? ""));
  if (!parts) return "";
  const era = eraOf(iso);
  const tail = `${Number(parts[2])}.${Number(parts[3])}`;
  return era ? `${era.key}${Number(parts[1]) - era.offset}.${tail}` : `${Number(parts[1])}/${Number(parts[2])}/${Number(parts[3])}`;
}

function splitInput(text) {
  let match = /^(\d{4})(\d{2})(\d{2})$/u.exec(text);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/u.exec(text);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(明治|大正|昭和|平成|令和|[MTSHRmtshr])\.?(\d{1,2}|元)[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/u.exec(text);
  if (match) return eraParts(match[1], match[2], match[3], match[4]);
  // 元号＋6 桁（S500101）
  match = /^(明治|大正|昭和|平成|令和|[MTSHRmtshr])(\d{2})(\d{2})(\d{2})$/u.exec(text);
  if (match) return eraParts(match[1], match[2], match[3], match[4]);
  return null;
}

function eraParts(token, eraYear, month, day) {
  const era = ERA_BY_TOKEN.get(token.toUpperCase()) || ERA_BY_TOKEN.get(token);
  if (!era) return null;
  return { era, eraYear: eraYear === "元" ? 1 : Number(eraYear), month: Number(month), day: Number(day) };
}

function eraOf(iso) {
  return ERAS.find((era) => iso >= era.from && iso <= era.to) || null;
}

function eraYearText(year) {
  return year === 1 ? "元" : String(year);
}

function rangeText(era) {
  const [fy, fm, fd] = era.from.split("-").map(Number);
  if (era.to.startsWith("9999")) return `${fy}年${fm}月${fd}日から`;
  const [ty, tm, td] = era.to.split("-").map(Number);
  return `${fy}年${fm}月${fd}日〜${ty}年${tm}月${td}日`;
}

function validDate(year, month, day) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
