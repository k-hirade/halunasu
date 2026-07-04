#!/usr/bin/env node
// 正規化claim(JSONL, P-2出力) → 決定論点検 → 売上改善診断レポート(HTML+CSV)。
// 適応/禁忌/併用と判断料メタは Python(checks_api) をオフラインで叩いて解決する（外部送信なし）。
//
// 使い方:
//   node scripts/build_clinic_diagnosis_report.mjs \
//     --claims out/claims.jsonl --db master_data/master.sqlite \
//     --out-html out/report.html --out-csv out/report.csv \
//     [--title "売上改善診断レポート"] [--subtitle "西山病院(匿名)"]

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClinicDiagnosisReport,
  clinicDiagnosisReportToHtml,
  clinicDiagnosisReportToCsv,
  claimCheckLookupCodes
} from "../packages/fee-core/src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith("--")) {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function runChecksApi(op, payload, { db, pythonBin, pythonPath }) {
  const input = JSON.stringify({ ...payload, op, db_path: db });
  const result = spawnSync(pythonBin, ["-m", "medical_fee_calculation.checks_api"], {
    input,
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: pythonPath },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`checks_api ${op} failed: ${(result.stderr || "").trim() || result.status}`);
  }
  return JSON.parse(result.stdout);
}

function loadClaims(claimsPath) {
  return readFileSync(claimsPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.claims || !args.db) {
    console.error("usage: --claims <jsonl> --db <master.sqlite> [--out-html f] [--out-csv f] [--title t] [--subtitle s]");
    process.exit(2);
  }
  const pythonBin = args["python-bin"] || process.env.FEE_PYTHON_BIN || "python3";
  const pythonPath = args["python-path"] || process.env.FEE_PYTHONPATH || path.join(ROOT, "python");
  const claims = loadClaims(args.claims);

  // 1) 病名コード化(名称のみの病名 → 傷病名コード＋疑いフラグ)
  const missingNames = [...new Set(
    claims.flatMap((c) => (c.diseases || []).filter((d) => !d.code && d.name).map((d) => d.name))
  )];
  let resolved = {};
  if (missingNames.length) {
    resolved = runChecksApi("resolve_diseases", { names: missingNames }, { db: args.db, pythonBin, pythonPath }).resolved || {};
  }
  for (const claim of claims) {
    for (const disease of claim.diseases || []) {
      if (disease.code || !disease.name) continue;
      const hit = resolved[disease.name];
      if (hit && hit.code && (hit.matchType === "exact" || hit.matchType === "partial")) {
        disease.code = hit.code;
        disease.suspected = Boolean(disease.suspected) || Boolean(hit.suspected);
      }
    }
  }

  // 2) 適応/禁忌/併用/判断料メタを一括解決(全claimのコードをまとめて1回)
  const drugCodes = new Set();
  const actCodes = new Set();
  const diseaseCodes = new Set();
  for (const claim of claims) {
    const codes = claimCheckLookupCodes(claim);
    codes.drug_codes.forEach((c) => drugCodes.add(c));
    codes.act_codes.forEach((c) => actCodes.add(c));
    codes.disease_codes.forEach((c) => diseaseCodes.add(c));
  }
  const lookup = runChecksApi("check_lookup", {
    drug_codes: [...drugCodes],
    act_codes: [...actCodes],
    disease_codes: [...diseaseCodes]
  }, { db: args.db, pythonBin, pythonPath });
  const procedureMeta = lookup.procedureMeta || {};

  // 3) レポート生成
  const report = buildClinicDiagnosisReport(claims, { lookup, procedureMeta });
  const title = args.title || "売上改善診断レポート";
  const subtitle = args.subtitle || "";

  if (args["out-html"]) {
    writeFileSync(args["out-html"], clinicDiagnosisReportToHtml(report, { title, subtitle }), "utf8");
    console.log(`HTML: ${args["out-html"]}`);
  }
  if (args["out-csv"]) {
    writeFileSync(args["out-csv"], clinicDiagnosisReportToCsv(report), "utf8");
    console.log(`CSV : ${args["out-csv"]}`);
  }
  const s = report.summary;
  console.log(`対象 ${s.patientCount}患者/${s.claimCount}レセ｜算定もれ候補 ${s.billingMissCount}｜査定リスク ${s.assessmentRiskCount}｜要修正 ${s.errorCount}`);
}

main();
