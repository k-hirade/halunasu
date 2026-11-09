import { inflateRawSync } from "node:zlib";

// 支払基金（現 医療情報基盤・診療報酬審査支払機構）の基本マスター（Shift_JIS の CSV）を読む。
// 取り込みスクリプト（scripts/build_eye_masters.mjs）とテストから使う。列の番号は 1 始まりで書く（公開されている
// レイアウト表と同じ数え方）。必要な列だけを取り、廃止日を過ぎた行は落とす。

export const MASTER_TYPES = Object.freeze(["drug", "disease", "modifier", "procedure"]);

// 公開ページと、そのページで探すファイル名の形（最新のものがページの先頭にある）。
export const MASTER_SOURCES = Object.freeze({
  procedure: { page: "kihonmasta_01.html", file: /s_ALL\d{8}\.zip/u, label: "医科診療行為マスター" },
  drug: { page: "kihonmasta_04.html", file: /y_ALL\d{8}\.zip/u, label: "医薬品マスター" },
  disease: { page: "kihonmasta_07.html", file: /b_\d{8}\.zip/u, label: "傷病名マスター" },
  modifier: { page: "kihonmasta_08.html", file: /z_\d{8}\.zip/u, label: "修飾語マスター" }
});
export const MASTER_BASE_URL = "https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/";

const OPEN_END = "99999999";

export function decodeShiftJis(bytes) {
  return new TextDecoder("shift_jis").decode(bytes);
}

// 引用符つきの CSV（"a","b"）。引用符の中のカンマ・改行・二重の引用符にも対応する。
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ZIP の中身（格納・deflate のみ）を取り出す。外部コマンドに頼らないための最小限の実装。
export function readZipEntries(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip: broken central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("latin1");
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip: broken local header");
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`zip: unsupported compression method ${method}`);
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("zip: end of central directory not found");
}

// 半角カナ → 全角などの表記ゆれをそろえる（NFKC）。カナ・単位にだけ使い、名称は公表されたまま持つ（検索側で正規化する）。
export function toWide(text) {
  return String(text || "").normalize("NFKC").trim();
}

function col(row, number) {
  return String(row[number - 1] ?? "").trim();
}

function isCurrent(abolishedOn, today) {
  return !abolishedOn || abolishedOn === OPEN_END || abolishedOn === "00000000" || abolishedOn > today;
}

function number(text) {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== "" && value !== null && value !== undefined && value !== false));
}

// 医薬品マスター。剤形（列 28）: 1 内用薬・3 その他・4 注射薬・6 外用薬・8 歯科用薬剤。
// 眼科用（eye）: 薬価基準コード（列 32）が 131（眼科用剤）で始まるか、名称に「点眼」「眼軟膏」「眼科」を含むもの。
export function drugRecord(row, today) {
  if (col(row, 2) !== "Y" || !isCurrent(col(row, 31), today)) return null;
  const name = col(row, 5);
  const yj = col(row, 32);
  const formCode = col(row, 28);
  const form = { 1: "internal", 3: "other", 4: "injection", 6: "external", 8: "dental" }[formCode] || "other";
  const eye = yj.startsWith("131") || /点眼|眼軟膏|眼科/u.test(name);
  const kind = form === "injection"
    ? "injection"
    : form === "internal"
      ? "oral"
      : form === "external" && eye && /軟膏/u.test(name)
        ? "eye_ointment"
        : form === "external" && eye
          ? "eye_drop"
          : "other";
  return compact({
    code: col(row, 3),
    name,
    kana: toWide(col(row, 7)),
    unit: toWide(col(row, 10)),
    price: number(col(row, 12)),
    form,
    kind,
    eye,
    yj,
    generic: col(row, 38).replace(/^【般】/u, "")
  });
}

// 傷病名マスター。ICD-10（列 16。なければ列 14）が H00〜H59 のものを眼科の病名（eye）とする。
export function diseaseRecord(row, today) {
  if (col(row, 2) !== "B" || !isCurrent(col(row, 24), today)) return null;
  const icd10 = col(row, 16) || col(row, 14);
  return compact({
    code: col(row, 3),
    name: col(row, 6),
    kana: toWide(col(row, 10)),
    icd10,
    eye: /^H[0-5]\d/u.test(icd10)
  });
}

// 修飾語マスター。区分（列 19）が A8 で始まるものは接尾語（病名の後ろに付く。例「の疑い」）、ほかは接頭語。
export function modifierRecord(row, today) {
  if (col(row, 2) !== "Z" || !isCurrent(col(row, 16), today)) return null;
  const group = col(row, 19);
  return compact({
    code: col(row, 3),
    name: col(row, 7),
    kana: toWide(col(row, 10)),
    position: group.startsWith("A8") || col(row, 3).startsWith("8") ? "suffix" : "prefix"
  });
}

// 医科診療行為マスター。点数識別（列 11）が 3 なら点数、1 なら金額（円）。区分（列 85 の章 ＋ 列 92 の区分番号）。
// 眼科の行為（eye）: 眼科学的検査 D255〜D282、眼の処置 J086〜J091、眼の手術 K200〜K284。
export function procedureRecord(row, today) {
  if (col(row, 2) !== "S" || !isCurrent(col(row, 88), today)) return null;
  const chapter = col(row, 85);
  const sectionNumber = col(row, 92);
  const section = chapter && /^\d{3}$/u.test(sectionNumber) ? `${chapter}${sectionNumber}` : "";
  const value = number(col(row, 12));
  const name = col(row, 5);
  const longName = col(row, 113);
  return compact({
    code: col(row, 3),
    name,
    longName: longName && longName !== name ? longName : "",
    kana: toWide(col(row, 7)),
    unit: toWide(col(row, 10)),
    points: col(row, 11) === "3" ? value : null,
    yen: col(row, 11) === "1" ? value : null,
    section,
    eye: isEyeSection(section)
  });
}

function isEyeSection(section) {
  const match = /^([A-Z])(\d{3})$/u.exec(section);
  if (!match) return false;
  const numberPart = Number(match[2]);
  if (match[1] === "D") return numberPart >= 255 && numberPart <= 282;
  if (match[1] === "J") return numberPart >= 86 && numberPart <= 91;
  if (match[1] === "K") return numberPart >= 200 && numberPart <= 284;
  return false;
}

const RECORD_BUILDERS = { drug: drugRecord, disease: diseaseRecord, modifier: modifierRecord, procedure: procedureRecord };

// CSV の本文（文字列）から、検索用のレコードの配列を作る。コードの重複は後の行で上書きする。
export function parseMasterText(type, text, { today = todayYmd() } = {}) {
  const build = RECORD_BUILDERS[type];
  if (!build) throw new Error(`unknown master type: ${type}`);
  const byCode = new Map();
  for (const row of parseCsv(text)) {
    const record = build(row, today);
    if (record?.code && record.name) byCode.set(record.code, record);
  }
  return [...byCode.values()];
}

export function todayYmd(date = new Date()) {
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/gu, "");
}

// 公開ページの HTML から、最新のファイルの URL を探す。
export function findMasterFileUrl(html, type, pageUrl) {
  const source = MASTER_SOURCES[type];
  for (const match of String(html).matchAll(/href="([^"]+)"/gu)) {
    if (source.file.test(match[1])) return new URL(match[1], pageUrl).toString();
  }
  return "";
}
