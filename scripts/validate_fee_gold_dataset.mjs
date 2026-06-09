#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const expectedCaseCount = 300;
const dataPath = path.join(repoRoot, "data/tests/fee-gold/cases/seed-300/fee-chart-gold-seed-300.json");
const schemaPath = path.join(repoRoot, "data/tests/fee-gold/schema/fee-chart-gold.schema.json");
const masterDbPath = path.join(repoRoot, "python/data/master/standard-master.sqlite");
const runEngine = args.has("--engine");

const data = readJson(dataPath);
readJson(schemaPath);

const errors = [];
const warnings = [];
const caseIds = new Set();

if (data.schemaVersion !== "fee-chart-gold.case-set.v1") {
  errors.push(`dataset schemaVersion is invalid: ${data.schemaVersion}`);
}
if (!Array.isArray(data.cases)) {
  errors.push("dataset cases must be an array");
} else if (data.cases.length !== expectedCaseCount) {
  errors.push(`dataset must contain ${expectedCaseCount} cases, found ${data.cases.length}`);
}
if (data.datasetId !== "fee-chart-gold-seed-300") {
  errors.push(`datasetId must be fee-chart-gold-seed-300, found ${data.datasetId}`);
}

for (const item of data.cases || []) {
  const id = item.caseId || "<missing-caseId>";
  if (caseIds.has(id)) {
    errors.push(`${id}: duplicate caseId`);
  }
  caseIds.add(id);

  for (const field of [
    "caseId",
    "difficulty",
    "title",
    "status",
    "qualityLabel",
    "reviewPolicy",
    "targetBillingFacts",
    "claimContextGold",
    "expectedCalculation",
    "expectedExtraction",
    "chartVariants",
    "evidence"
  ]) {
    if (!(field in item)) {
      errors.push(`${id}: missing ${field}`);
    }
  }

  if (![1, 2, 3].includes(item.difficulty)) {
    errors.push(`${id}: invalid difficulty ${item.difficulty}`);
  }

  const assertion = item.expectedCalculation?.assertionLevel;
  if (![
    "exact",
    "candidate_presence",
    "review_required",
    "unsupported_expected",
    "safety",
    "split_required"
  ].includes(assertion)) {
    errors.push(`${id}: invalid assertionLevel ${assertion}`);
  }

  if (item.reviewPolicy?.calculationAssertion !== assertion) {
    errors.push(`${id}: reviewPolicy.calculationAssertion must match expectedCalculation.assertionLevel`);
  }

  if (item.reviewPolicy?.officeReviewed !== false && item.status !== "office_reviewed" && item.status !== "ci_enabled") {
    errors.push(`${id}: officeReviewed must remain false unless status is office_reviewed/ci_enabled`);
  }
  if (item.reviewPolicy?.productionGoldAllowed !== false && item.status !== "ci_enabled") {
    errors.push(`${id}: productionGoldAllowed must remain false unless status is ci_enabled`);
  }

  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const targets = item.targetBillingFacts?.billingTargets || [];
  const claimEncounter = item.claimContextGold?.encounter;
  const targetEncounter = item.targetBillingFacts?.encounter;
  if (claimEncounter && targetEncounter?.setting) {
    const expectedSetting = claimEncounter.is_outpatient === false ? "inpatient" : "outpatient";
    if (targetEncounter.setting !== expectedSetting) {
      errors.push(`${id}: targetBillingFacts.encounter.setting ${targetEncounter.setting} does not match claimContextGold setting ${expectedSetting}`);
    }
  }
  const patientAge = Number(item.targetBillingFacts?.patient?.age);
  const readableText = [
    item.title,
    ...Object.values(item.chartVariants?.soap || {}).flat()
  ].join(" ");
  if (/小児|乳幼児|\d歳児/.test(readableText) && Number.isFinite(patientAge) && patientAge > 15) {
    errors.push(`${id}: pediatric wording but patient age is ${patientAge}`);
  }
  for (const target of targets) {
    const code = String(target.code || "");
    const name = String(target.name || "");
    const hasEvidence = evidence.some((entry) => {
      if (code) return String(entry.code || "") === code;
      return entry.type === "unsupported_policy" && String(entry.name || "") === name;
    });
    if (!hasEvidence) {
      errors.push(`${id}: missing evidence for billing target ${code || name}`);
    }
    if (target.totalPoints !== undefined && (target.source === "drug_master" || String(target.code || "").startsWith("6"))) {
      const drugErrors = validateDrugLine(target, `${id}: billing target ${code || name}`);
      errors.push(...drugErrors);
    }
  }

  for (const entry of evidence) {
    if (entry.type === "drug_master") {
      errors.push(...validateDrugLine(entry, `${id}: evidence ${entry.code || entry.name || "<unknown drug>"}`));
    }
  }

  if (assertion === "exact") {
    if (!item.claimContextGold) {
      errors.push(`${id}: exact case requires claimContextGold`);
    }
    if (item.status !== "master_verified" && item.status !== "office_reviewed" && item.status !== "ci_enabled") {
      errors.push(`${id}: exact case should be at least master_verified`);
    }
    if (item.qualityLabel !== "verified") {
      errors.push(`${id}: exact case should use qualityLabel=verified before office review`);
    }
    if (item.reviewPolicy?.ciEligible !== true) {
      errors.push(`${id}: exact case should be ciEligible`);
    }
    if (!item.engineVerification?.expectedMatched) {
      errors.push(`${id}: exact case missing successful engineVerification`);
    }

    const sum = targets.reduce((acc, target) => {
      if (typeof target.totalPoints === "number") return acc + target.totalPoints;
      return acc + Number(target.points || 0) * Number(target.quantity || 1);
    }, 0);
    if (Number(sum) !== Number(item.expectedCalculation?.totalPoints)) {
      errors.push(`${id}: billingTargets total ${sum} != expectedCalculation.totalPoints ${item.expectedCalculation?.totalPoints}`);
    }

    const targetCodes = targets.map((target) => String(target.code || "")).filter(Boolean);
    const targetNames = targets.map((target) => String(target.name || ""));
    const feeKind = item.claimContextGold?.outpatient_basic?.fee_kind;
    if (feeKind === "initial" && !targetNames.some((name) => name.includes("初診料") || name.includes("外来診療料"))) {
      errors.push(`${id}: outpatient_basic.fee_kind=initial but no initial/basic outpatient fee target was generated`);
    }
    if (feeKind === "revisit" && !targetNames.some((name) => name.includes("再診料") || name.includes("外来診療料"))) {
      errors.push(`${id}: outpatient_basic.fee_kind=revisit but no revisit/basic outpatient fee target was generated`);
    }
    if (targetNames.some((name) => name.includes("乳幼児加算") || name.includes("小児科外来診療料") || name.includes("小児抗菌薬")) && Number.isFinite(patientAge) && patientAge >= 6) {
      errors.push(`${id}: pediatric add-on/basic target exists but patient age is ${patientAge}`);
    }
    for (const code of item.expectedCalculation?.candidateCodes || []) {
      if (!targetCodes.includes(String(code))) {
        errors.push(`${id}: expected candidate code ${code} missing from billingTargets`);
      }
    }
  } else if (item.status === "master_verified") {
    warnings.push(`${id}: non-exact case is marked master_verified`);
  }
}

if (runEngine) {
  for (const item of data.cases.filter((entry) => entry.expectedCalculation?.assertionLevel === "exact")) {
    const payload = {
      db_path: masterDbPath,
      session: {
        feeSessionId: item.caseId,
        serviceDate: item.claimContextGold?.encounter?.service_date,
        setting: item.claimContextGold?.encounter?.is_outpatient === false ? "inpatient" : "outpatient",
        claimContext: item.claimContextGold
      },
      input: {}
    };
    const result = spawnSync("python3", ["-m", "medical_fee_calculation.api"], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: path.join(repoRoot, "python")
      }
    });
    if (result.status !== 0) {
      errors.push(`${item.caseId}: engine execution failed: ${result.stderr.trim() || result.stdout.trim()}`);
      continue;
    }
    const calculation = JSON.parse(result.stdout).calculationResult;
    const expected = item.expectedCalculation;
    if (Number(calculation.totalPoints) !== Number(expected.totalPoints)) {
      errors.push(`${item.caseId}: engine total ${calculation.totalPoints} != expected ${expected.totalPoints}`);
    }
    if (calculation.engineStatus !== expected.engineStatus) {
      errors.push(`${item.caseId}: engine status ${calculation.engineStatus} != expected ${expected.engineStatus}`);
    }
    const actualCodes = new Set((calculation.candidateCodes || []).map(String));
    for (const code of expected.candidateCodes || []) {
      if (!actualCodes.has(String(code))) {
        errors.push(`${item.caseId}: engine candidate code missing ${code}`);
      }
    }
  }
}

const difficultyCounts = countBy(data.cases || [], (item) => item.difficulty);
const assertionCounts = countBy(data.cases || [], (item) => item.expectedCalculation?.assertionLevel);
const statusCounts = countBy(data.cases || [], (item) => item.status);
const exactCount = Number(assertionCounts.exact || 0);
const reviewCount = Number(assertionCounts.candidate_presence || 0) + Number(assertionCounts.review_required || 0);
const safetyCount = Number(data.cases?.length || 0) - exactCount - reviewCount;

if (exactCount !== 150) {
  errors.push(`dataset must contain 150 exact cases, found ${exactCount}`);
}
if (reviewCount !== 100) {
  errors.push(`dataset must contain 100 extraction/review cases, found ${reviewCount}`);
}
if (safetyCount !== 50) {
  errors.push(`dataset must contain 50 safety/unsupported cases, found ${safetyCount}`);
}

console.log(JSON.stringify({
  datasetId: data.datasetId,
  cases: data.cases?.length || 0,
  difficultyCounts,
  assertionCounts,
  assertionGroups: {
    exact: exactCount,
    extractionOrReview: reviewCount,
    safetyOrUnsupported: safetyCount
  },
  statusCounts,
  runEngine,
  warnings,
  errors
}, null, 2));

if (errors.length > 0) {
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function countBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = String(fn(item));
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function validateDrugLine(row, label) {
  const drugErrors = [];
  const quantity = Number(row.quantity || 0);
  const totalPoints = Number(row.totalPoints);
  if (quantity > 1) {
    if (!Number.isFinite(totalPoints)) {
      drugErrors.push(`${label}: drug line with quantity > 1 must include totalPoints`);
    }
    if (row.unitAmountYen === undefined) {
      drugErrors.push(`${label}: drug line with quantity > 1 must include unitAmountYen`);
    }
    if (row.totalDrugPriceYen === undefined) {
      drugErrors.push(`${label}: drug line with quantity > 1 must include totalDrugPriceYen`);
    }
    if (!row.rounding) {
      drugErrors.push(`${label}: drug line with quantity > 1 must document rounding`);
    }
  }

  if (row.unitAmountYen !== undefined && row.points !== undefined) {
    const expectedUnitPoints = Number(row.unitAmountYen) / 10;
    if (Math.abs(Number(row.points) - expectedUnitPoints) > 0.001) {
      drugErrors.push(`${label}: drug points ${row.points} must represent unit points ${expectedUnitPoints}, not rounded line total`);
    }
  }
  if (quantity > 0 && row.unitAmountYen !== undefined && row.totalDrugPriceYen !== undefined) {
    const expectedDrugPrice = Number((Number(row.unitAmountYen) * quantity).toFixed(1));
    if (Math.abs(Number(row.totalDrugPriceYen) - expectedDrugPrice) > 0.001) {
      drugErrors.push(`${label}: totalDrugPriceYen ${row.totalDrugPriceYen} != unitAmountYen * quantity ${expectedDrugPrice}`);
    }
  }
  return drugErrors;
}
