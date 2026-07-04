#!/usr/bin/env node
// 導入前 売上改善診断ツールキットのデモ（当日提示用・E2Eスモーク兼用）。
// 匿名サンプル → 匿名化(P-1) → 取込(P-2) → デモ点検マスタ → 診断レポート(P-3) を一気通貫で実行し、
// 期待される指摘が出ることを検証する（外部送信なし・全処理ローカル）。
//
//   node scripts/run_clinic_demo.mjs [--out <dir>] [--keep]

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = path.join(ROOT, "samples", "nishiyama-demo");
const PYTHON = process.env.FEE_PYTHON_BIN || "python3";
const PYTHONPATH = process.env.FEE_PYTHONPATH || path.join(ROOT, "python");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) { args[key] = argv[i + 1]; i += 1; }
      else { args[key] = true; }
    }
  }
  return args;
}

function py(module, moduleArgs) {
  const result = spawnSync(PYTHON, ["-m", module, ...moduleArgs], {
    cwd: ROOT, env: { ...process.env, PYTHONPATH }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${module} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function seedDemoMaster(db) {
  const result = spawnSync(PYTHON, [path.join(ROOT, "scripts", "seed_clinic_demo_master.py"), "--db", db], {
    cwd: ROOT, env: { ...process.env, PYTHONPATH }, encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`seed_clinic_demo_master failed:\n${result.stderr || result.stdout}`);
  }
}

function nodeScript(script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: ROOT, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const workDir = args.out ? path.resolve(String(args.out)) : mkdtempSync(path.join(tmpdir(), "clinic-demo-"));
  mkdirSync(workDir, { recursive: true });
  const deidDir = path.join(workDir, "deid");
  const claims = path.join(workDir, "claims.jsonl");
  const db = path.join(workDir, "demo-master.sqlite");
  const html = path.join(workDir, "report.html");
  const csv = path.join(workDir, "report.csv");

  console.log("① 匿名化(P-1) …");
  py("medical_fee_calculation.deidentify", [
    "--config", path.join(SAMPLE, "deid-config.json"),
    "--input", path.join(SAMPLE, "raw"),
    "--output", deidDir
  ]);

  console.log("② 断片データ取込(P-2) …");
  py("medical_fee_calculation.clinic_intake", [
    "--map", path.join(SAMPLE, "intake-map.json"),
    "--input", deidDir,
    "--output", claims
  ]);

  console.log("③ デモ点検マスタ生成 …");
  seedDemoMaster(db);

  console.log("④ 診断レポート生成(P-3) …");
  const out = nodeScript(path.join(ROOT, "scripts", "build_clinic_diagnosis_report.mjs"), [
    "--claims", claims, "--db", db,
    "--out-html", html, "--out-csv", csv,
    "--title", "売上改善診断レポート（デモ）", "--subtitle", "西山病院（匿名サンプル）"
  ]);
  process.stdout.write(out);

  // --- E2Eスモーク: 期待する指摘が出ているか検証（HTML/CSV本文で確認） ---
  const csvText = readFileSync(csv, "utf8");
  const htmlText = readFileSync(html, "utf8");
  const checks = [
    ["検体検査判断料", "判断料もれ(MI-002)"],
    ["処方料", "処方料もれ(MI-004)"],
    ["適応傷病名が記録されていません", "適応なし(IY-001)"],
    ["禁忌傷病名", "禁忌(IY-003)"],
    ["併用禁忌", "併用禁忌(IY-004)"],
    ["按分なし", "誠実表現の注記"]
  ];
  const missing = checks.filter(([needle]) => !htmlText.includes(needle) && !csvText.includes(needle));
  console.log(`\nレポート: ${html}`);
  if (missing.length) {
    console.error("スモーク失敗: 期待した指摘が見つかりません → " + missing.map((m) => m[1]).join(", "));
    process.exitCode = 1;
  } else {
    console.log("スモーク成功: 判断料もれ / 処方料もれ / 適応なし / 禁忌 / 併用禁忌 を検出");
  }

  if (!args.keep && !args.out) {
    rmSync(workDir, { recursive: true, force: true });
  }
}

run();
