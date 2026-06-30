// 再算定差分診断: フロント共有ヘルパ(取込・整形・出力)。

export function isStgFeeEnvironment() {
  if (typeof window === "undefined") {
    return false;
  }
  const config = window.__HALUNASU_FEE_CONFIG__ || {};
  const env = String(config.halunasuEnv || "").trim().toLowerCase();
  const host = String(window.location.hostname || "").toLowerCase();
  return env === "stg"
    || host === "fee.stg.halunasu.com"
    || host === "halunasu-fee-stg.netlify.app"
    || host.endsWith("--halunasu-fee-stg.netlify.app");
}

export const BASELINE_COLUMN_FIELDS = [
  ["patient_id", "患者ID列"],
  ["code", "コード列"],
  ["name", "名称列"],
  ["points", "点数列"],
  ["count", "回数列"],
  ["claim_month", "請求月列"],
  ["medical_institution_code", "医療機関コード列"]
];

export const BASELINE_UKE_FIELDS = [
  ["line_code_index", "明細コード位置"],
  ["line_points_index", "明細点数位置"],
  ["line_count_index", "明細回数位置"],
  ["re_name_index", "RE氏名位置"],
  ["ho_points_index", "HO請求点数位置"],
  ["ho_days_index", "HO診療実日数位置"]
];

export const BASELINE_DIFF_CATEGORY_ORDER = { missing_candidate: 0, needs_review: 1, consider: 2 };

export function emptyBaselineDiffOptions() {
  return {
    columnMap: { patient_id: "", claim_month: "", medical_institution_code: "", code: "", name: "", points: "", count: "" },
    ukeLayout: { line_code_index: "", line_points_index: "", line_count_index: "", re_name_index: "", ho_points_index: "", ho_days_index: "" },
    knownUnsupportedText: "",
    codeMapText: ""
  };
}

export function splitCodeList(text) {
  return [...new Set(String(text || "").split(/[\s,、\n]+/u).map((item) => item.trim()).filter(Boolean))];
}

export function parseCodeMap(text) {
  const map = {};
  for (const line of String(text || "").split(/\n+/u)) {
    const cells = line.split(/[=\t,]/u).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 2) {
      map[cells[0]] = cells[1];
    }
  }
  return map;
}

export function compactColumnMap(columnMap = {}) {
  const out = {};
  for (const [logical, actual] of Object.entries(columnMap)) {
    if (String(actual || "").trim()) {
      out[logical] = String(actual).trim();
    }
  }
  return out;
}

export function compactUkeLayout(ukeLayout = {}) {
  const out = {};
  for (const [key, value] of Object.entries(ukeLayout)) {
    const trimmed = String(value ?? "").trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
      out[key] = Number(trimmed);
    }
  }
  return out;
}

// 実レセはShift_JIS/cp932が多いため、文字コードはサーバ(Python adapter)側で判定させる。
// File を base64 化して content_base64 + encoding=auto で送る。
export async function fileToBase64(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function buildBaselineDiffRequest(file, { claimMonth, options }) {
  const baselineFormat = /\.uke$/iu.test(file.name || "") ? "uke" : "csv";
  const body = {
    claimMonth,
    baselineFormat,
    baselineContentBase64: await fileToBase64(file),
    baselineEncoding: "auto"
  };
  const knownUnsupportedCodes = splitCodeList(options.knownUnsupportedText);
  if (knownUnsupportedCodes.length) {
    body.knownUnsupportedCodes = knownUnsupportedCodes;
  }
  const codeMap = parseCodeMap(options.codeMapText);
  if (Object.keys(codeMap).length) {
    body.codeMap = codeMap;
  }
  if (baselineFormat === "csv") {
    const columnMap = compactColumnMap(options.columnMap);
    if (Object.keys(columnMap).length) {
      body.columnMap = columnMap;
    }
  }
  if (baselineFormat === "uke") {
    const ukeLayout = compactUkeLayout(options.ukeLayout);
    if (Object.keys(ukeLayout).length) {
      body.ukeLayout = ukeLayout;
    }
  }
  return body;
}

export async function buildRecalculationDiffRequest(baselineFile, recalculationFile, { claimMonth, options }) {
  const body = await buildBaselineDiffRequest(baselineFile, { claimMonth, options });
  body.calculationPayloadFormat = /\.(jsonl|ndjson)$/iu.test(recalculationFile.name || "") ? "jsonl" : "json";
  body.calculationPayloadContentBase64 = await fileToBase64(recalculationFile);
  return body;
}

export function baselineDiffRows(result) {
  const rows = (result?.diagnoses || []).flatMap((diagnosis) => (diagnosis.findings || []).map((finding) => ({ patientId: diagnosis.patientId, ...finding })));
  rows.sort((a, b) => (BASELINE_DIFF_CATEGORY_ORDER[a.category] - BASELINE_DIFF_CATEGORY_ORDER[b.category]) || (Number(b.points || 0) - Number(a.points || 0)));
  return rows;
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function baselineDiffToCsv(result) {
  const clean = (value) => String(value ?? "").replace(/[",\n]/gu, " ");
  const lines = ["患者,分類,コード,名称,点数,概算影響額(円),理由"];
  for (const row of baselineDiffRows(result)) {
    lines.push([clean(row.patientId), clean(row.categoryLabel), clean(row.code), clean(row.name), Number(row.points || 0), Number(row.estimatedYen || 0), clean(row.reason)].join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function baselineDiffToHtml(result) {
  const summary = result?.summary || {};
  const rowsHtml = baselineDiffRows(result).map((row) => (
    `<tr class="c-${row.category}"><td>${escapeHtmlText(row.patientId)}</td>`
    + `<td class="cat">${escapeHtmlText(row.categoryLabel)}</td>`
    + `<td>${escapeHtmlText(row.code)}</td>`
    + `<td>${escapeHtmlText(row.name)}</td>`
    + `<td class="num">${Number(row.points || 0).toLocaleString()}</td>`
    + `<td class="num">${Number(row.estimatedYen || 0).toLocaleString()}</td>`
    + `<td>${escapeHtmlText(row.reason)}</td></tr>`
  )).join("") || '<tr><td colspan="7">差分はありません。</td></tr>';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>レセプト差分診断レポート</title>
<style>body{font-family:'Noto Sans JP',system-ui,sans-serif;color:#111827;margin:24px;font-size:13px}
h1{font-size:1.3rem;margin:0 0 6px}.note{color:#475467;font-size:12px;margin:2px 0}
table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border-top:1px solid #e4e7ec;padding:7px 8px;text-align:left}
th{color:#64748b;font-size:11px}td.num{text-align:right;white-space:nowrap}td.cat{font-weight:800}
tr.c-missing_candidate td.cat{color:#1d4ed8}tr.c-needs_review td.cat{color:#b42318}tr.c-consider td.cat{color:#475467}
@media print{body{margin:0}}</style></head><body>
<h1>レセプト差分診断レポート（${escapeHtmlText(result?.claimMonth || "")}）</h1>
<p class="note">差分はすべて要確認です。実施事実・算定要件・施設基準・病名を確認のうえ判断してください。</p>
<p class="note">概算影響額は点数×10円・総医療費ベースの概算です（負担按分なし）。算定もれ候補 ${Number(summary.missingCandidateCount || 0)}件 / 約${Number(summary.missingCandidateEstimatedYen || 0).toLocaleString()}円 ・ 要確認 ${Number(summary.needsReviewCount || 0)}件 ・ 検討 ${Number(summary.considerCount || 0)}件</p>
<table><thead><tr><th>患者</th><th>分類</th><th>コード</th><th>名称</th><th>点数</th><th>概算影響額(円)</th><th>理由</th></tr></thead><tbody>${rowsHtml}</tbody></table>
</body></html>`;
}

export function downloadTextFile(filename, text, mime) {
  if (typeof document === "undefined") {
    return;
  }
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
