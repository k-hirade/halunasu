#!/usr/bin/env node
// 支払基金（現 医療情報基盤・診療報酬審査支払機構）の基本マスターを取り込み、眼科カルテの検索用 JSON を作る。
//
//   node scripts/build_eye_masters.mjs                     # 公開ページから最新のファイルを取得して作る
//   node scripts/build_eye_masters.mjs --source-dir <dir>  # 手元に落としたファイル（zip・csv・txt）から作る
//   node scripts/build_eye_masters.mjs --today 20261109    # 廃止日の判定に使う日（既定は今日・日本時間）
//
// 取得元: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/ （ログイン不要の公開ページ。
// 医科診療行為・医薬品・傷病名・修飾語の 4 種類）。マスターはレセプト電算処理のために公開されているもので、
// サイトの利用条件（文書・画像の無断転載の禁止）に従い、取り込んだ JSON は院内の検索にだけ使い、再配布しない。
// 出力: services/eye-api/data/masters/{drug,disease,modifier,procedure}.json と meta.json。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MASTER_BASE_URL,
  MASTER_SOURCES,
  MASTER_TYPES,
  decodeShiftJis,
  findMasterFileUrl,
  parseMasterText,
  readZipEntries,
  todayYmd
} from "../services/eye-api/src/master-parse.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, "services/eye-api/data/masters");
const FILE_PREFIX = { procedure: /^s_/u, drug: /^y_/u, disease: /^b_/u, modifier: /^z_/u };

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, sourceDir: "", today: todayYmd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") options.out = resolve(argv[++index]);
    else if (arg === "--source-dir") options.sourceDir = resolve(argv[++index]);
    else if (arg === "--today") options.today = argv[++index];
    else if (arg === "--help") {
      console.log("usage: node scripts/build_eye_masters.mjs [--source-dir dir] [--out dir] [--today YYYYMMDD]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d{8}$/u.test(options.today)) throw new Error("--today must be YYYYMMDD");
  return options;
}

async function fetchBuffer(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "halunasu-eye-master-build/1.0" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return { buffer: Buffer.from(await response.arrayBuffer()), finalUrl: response.url || url };
}

// zip なら中の最初の csv/txt、そうでなければそのまま Shift_JIS として読む。
function textOf(fileName, buffer) {
  if (/\.zip$/iu.test(fileName)) {
    const entry = readZipEntries(buffer).find((item) => /\.(csv|txt)$/iu.test(item.name));
    if (!entry) throw new Error(`${fileName}: no csv/txt inside`);
    return { text: decodeShiftJis(entry.data), inner: entry.name };
  }
  return { text: decodeShiftJis(buffer), inner: "" };
}

async function loadFromWeb(type) {
  const pageUrl = new URL(MASTER_SOURCES[type].page, MASTER_BASE_URL).toString();
  const page = await fetchBuffer(pageUrl);
  const fileUrl = findMasterFileUrl(page.buffer.toString("utf8"), type, page.finalUrl);
  if (!fileUrl) throw new Error(`${MASTER_SOURCES[type].label}: file link not found on ${page.finalUrl}`);
  const file = await fetchBuffer(fileUrl);
  const fileName = fileUrl.split("/").pop();
  return { ...textOf(fileName, file.buffer), source: fileUrl, fileName };
}

function loadFromDir(type, dir) {
  const candidates = readdirSync(dir).filter((name) => FILE_PREFIX[type].test(name) && /\.(zip|csv|txt)$/iu.test(name)).sort().reverse();
  if (!candidates.length) throw new Error(`${MASTER_SOURCES[type].label}: no ${FILE_PREFIX[type]}* file in ${dir}`);
  const fileName = candidates[0];
  return { ...textOf(fileName, readFileSync(join(dir, fileName))), source: join(dir, fileName), fileName };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });
  const meta = { generatedAt: new Date().toISOString(), today: options.today, publisher: "医療情報基盤・診療報酬審査支払機構（旧 社会保険診療報酬支払基金）", page: MASTER_BASE_URL, masters: {} };
  let totalBytes = 0;
  for (const type of MASTER_TYPES) {
    const loaded = options.sourceDir ? loadFromDir(type, options.sourceDir) : await loadFromWeb(type);
    const records = parseMasterText(type, loaded.text, { today: options.today });
    if (!records.length) throw new Error(`${MASTER_SOURCES[type].label}: no records parsed`);
    const json = `${JSON.stringify(records)}\n`;
    writeFileSync(join(options.out, `${type}.json`), json);
    totalBytes += Buffer.byteLength(json);
    meta.masters[type] = { label: MASTER_SOURCES[type].label, file: loaded.fileName, inner: loaded.inner, source: options.sourceDir ? loaded.fileName : loaded.source, count: records.length, bytes: Buffer.byteLength(json) };
    console.log(`${type}: ${records.length} records (${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB) from ${loaded.fileName}`);
  }
  writeFileSync(join(options.out, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`total ${(totalBytes / 1024 / 1024).toFixed(2)} MB -> ${options.out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
