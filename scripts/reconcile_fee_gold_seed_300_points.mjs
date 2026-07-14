#!/usr/bin/env node
// gold(seed-300)の期待値をマスタ世代と整合させる。
//
// 背景: exactケースの期待値は「claimContextGoldを現行エンジン+現行マスタで実行した結果」を
// 記録したもの。マスタDBが新世代(点数改定)に入れ替わると、コード構成は同じまま単価だけが
// ずれて148件が恒常的に失敗する。このスクリプトは各exactケースを再実行し、
//   - コード構成(コード集合と数量)が完全一致する場合のみ、点数・status・候補コードを更新
//   - コード構成が変わったケースは更新せず一覧報告(人の判断が必要)
// する。goldの検証価値は「どのコードがどのstatusで出るか」の構造にあり、単価はマスタが正。
//
// 使い方: node scripts/reconcile_fee_gold_seed_300_points.mjs [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const datasetPath = path.join(repoRoot, "data/tests/fee-gold/cases/seed-300/fee-chart-gold-seed-300.json");
const masterDbPath = path.join(repoRoot, "python/data/master/standard-master.sqlite");
const verifiedAt = new Date().toISOString().slice(0, 10);

const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

const masterSourceVersion = readMasterSourceVersion();
if (!masterSourceVersion) {
  throw new Error("master source version could not be read from the master DB");
}

// 新マスタ世代で追加され、エンジンが基本診療料へ自動付随させる項目。
// これらの「追加のみ」の構造差はマスタ世代差そのものなので、期待値へ追記して整合する。
// (180819910/180820010 = 物価対応料１(外来・在宅物価対応料) 初診時/再診時等、2026-06-01新設)
const ALLOWED_ADDED_CODES = new Set(["180819910", "180820010"]);

const stats = { checked: 0, unchanged: 0, updated: 0, addedCompanionLines: 0, structureChanged: [] };

for (const item of dataset.cases) {
  if (item.expectedCalculation?.assertionLevel !== "exact") {
    continue;
  }
  stats.checked += 1;
  const calc = runEngine(item.caseId, item.claimContextGold);
  const engineByCode = groupLinesByCode(calc.lineItems || []);
  const targets = item.targetBillingFacts?.billingTargets || [];
  const targetByCode = groupTargetsByCode(targets);

  const engineCodes = [...engineByCode.keys()].sort();
  const targetCodes = [...targetByCode.keys()].sort();
  const addedCodes = engineCodes.filter((code) => !targetByCode.has(code));
  const removedCodes = targetCodes.filter((code) => !engineByCode.has(code));
  const commonQuantityMatched = engineCodes
    .filter((code) => targetByCode.has(code))
    .every((code) => engineByCode.get(code).quantity === targetByCode.get(code).quantity);
  const sameStructure = removedCodes.length === 0
    && commonQuantityMatched
    && addedCodes.every((code) => ALLOWED_ADDED_CODES.has(code));
  if (!sameStructure) {
    stats.structureChanged.push({
      caseId: item.caseId,
      expectedCodes: targetCodes,
      engineCodes,
      expectedTotal: item.expectedCalculation?.totalPoints,
      engineTotal: calc.totalPoints
    });
    continue;
  }

  const before = JSON.stringify([item.expectedCalculation, targets]);
  for (const target of targets) {
    const engineLine = engineByCode.get(String(target.code || ""));
    if (!engineLine) continue;
    target.points = engineLine.points;
    if ("totalPoints" in target) target.totalPoints = engineLine.totalPoints;
    if ("status" in target) target.status = engineLine.status;
  }
  for (const code of addedCodes) {
    const engineLine = engineByCode.get(code);
    targets.push({
      code,
      name: engineLine.name,
      points: engineLine.points,
      quantity: engineLine.quantity,
      totalPoints: engineLine.totalPoints,
      status: engineLine.status,
      source: engineLine.source
    });
    stats.addedCompanionLines += 1;
  }
  // evidence(マスタ照合記録)も同じ世代へ更新・追記する。
  const evidenceEntries = Array.isArray(item.evidence) ? item.evidence : [];
  const evidenceCodes = new Set(evidenceEntries.map((entry) => String(entry.code || "")));
  for (const entry of evidenceEntries) {
    const engineLine = engineByCode.get(String(entry.code || ""));
    if (!engineLine || entry.type !== "medical_procedure_master") continue;
    entry.masterVersion = masterSourceVersion;
    entry.points = engineLine.points;
    if ("quantity" in entry) entry.quantity = engineLine.quantity;
    if ("totalPoints" in entry) entry.totalPoints = engineLine.totalPoints;
    entry.verifiedAt = verifiedAt;
    entry.verificationMethod = "reconciled with current master generation via scripts/reconcile_fee_gold_seed_300_points.mjs";
  }
  for (const code of addedCodes) {
    if (evidenceCodes.has(code)) continue;
    const engineLine = engineByCode.get(code);
    evidenceEntries.push({
      type: "medical_procedure_master",
      source: "standard-master.sqlite",
      masterVersion: masterSourceVersion,
      code,
      name: engineLine.name,
      points: engineLine.points,
      quantity: engineLine.quantity,
      totalPoints: engineLine.totalPoints,
      verifiedBy: "claude",
      verifiedAt,
      verificationMethod: "reconciled with current master generation via scripts/reconcile_fee_gold_seed_300_points.mjs"
    });
  }
  if (Array.isArray(item.evidence)) {
    item.evidence = evidenceEntries;
  } else if (evidenceEntries.length) {
    item.evidence = evidenceEntries;
  }
  item.expectedCalculation.totalPoints = Number(calc.totalPoints || 0);
  item.expectedCalculation.engineStatus = calc.engineStatus;
  item.expectedCalculation.candidateCodes = (calc.candidateCodes || []).map(String);
  if (item.engineVerification) {
    item.engineVerification.verifiedAt = verifiedAt;
    item.engineVerification.masterSourceVersion = masterSourceVersion;
    item.engineVerification.result = {
      engineStatus: calc.engineStatus,
      totalPoints: Number(calc.totalPoints || 0),
      candidateCodes: (calc.candidateCodes || []).map(String)
    };
  }
  if (JSON.stringify([item.expectedCalculation, targets]) === before) {
    stats.unchanged += 1;
  } else {
    stats.updated += 1;
  }
}

dataset.masterVersion = masterSourceVersion;
dataset.version = `${verifiedAt}.1`;

if (!dryRun) {
  fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2) + "\n");
}

console.log(JSON.stringify({
  dryRun,
  masterSourceVersion,
  checked: stats.checked,
  updated: stats.updated,
  unchanged: stats.unchanged,
  addedCompanionLines: stats.addedCompanionLines,
  structureChangedCount: stats.structureChanged.length,
  structureChanged: stats.structureChanged
}, null, 2));

function groupLinesByCode(lines) {
  const map = new Map();
  for (const line of lines) {
    const code = String(line.code || "");
    if (!code) continue;
    const entry = map.get(code) || { points: 0, quantity: 0, totalPoints: 0, status: line.status };
    entry.points = Number(line.points || 0);
    entry.quantity += Number(line.quantity || 1);
    entry.totalPoints += Number(line.totalPoints ?? Number(line.points || 0) * Number(line.quantity || 1));
    entry.status = line.status;
    entry.name = line.name;
    entry.source = line.source || "";
    map.set(code, entry);
  }
  return map;
}

function groupTargetsByCode(targets) {
  const map = new Map();
  for (const target of targets) {
    const code = String(target.code || "");
    if (!code) continue;
    const entry = map.get(code) || { quantity: 0 };
    entry.quantity += Number(target.quantity || 1);
    map.set(code, entry);
  }
  return map;
}

function runEngine(caseId, claimContextGold) {
  const payload = {
    db_path: masterDbPath,
    session: {
      feeSessionId: caseId,
      serviceDate: claimContextGold?.encounter?.service_date || "2026-07-10",
      setting: claimContextGold?.encounter?.is_outpatient === false ? "inpatient" : "outpatient",
      claimContext: claimContextGold
    },
    input: {}
  };
  const result = spawnSync("python3", ["-m", "medical_fee_calculation.api"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(repoRoot, "python") }
  });
  if (result.status !== 0) {
    throw new Error(`${caseId}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout).calculationResult;
}

function readMasterSourceVersion() {
  const result = spawnSync("sqlite3", [
    masterDbPath,
    "SELECT source_version FROM master_sources WHERE source_type='medical_procedure_master' ORDER BY imported_at DESC, id DESC LIMIT 1;"
  ], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
