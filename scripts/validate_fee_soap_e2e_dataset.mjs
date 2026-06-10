#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { caseTypeAudit, caseTypeSignature } from "./fee_soap_case_type_signature.mjs";

const repoRoot = process.cwd();
const datasetPath = "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json";
const expectedCount = 800;
const minChartChars = 600;

const data = readJson(datasetPath);
const errors = [];
const assertionCounts = {};
const qualityCounts = {};
const statusCounts = {};
const difficultyCounts = {};
let caseTypeSummary = null;

if (data.datasetId !== "fee-soap-e2e-cases") {
  errors.push(`datasetId must be fee-soap-e2e-cases, found ${data.datasetId}`);
}
if (data.cases?.length !== expectedCount) {
  errors.push(`cases count ${data.cases?.length} != ${expectedCount}`);
}
if (!data.evaluationPolicy?.requiredBillingSignals) {
  errors.push("evaluationPolicy.requiredBillingSignals is missing");
}

const ids = new Set();
for (const item of data.cases || []) {
  const id = item.caseId;
  if (ids.has(id)) {
    errors.push(`${id}: duplicate caseId`);
  }
  ids.add(id);

  for (const key of [
    "sourceCaseId",
    "sourceTitle",
    "title",
    "difficultyLevel",
    "calculationDifficulty",
    "patient",
    "encounter",
    "chart",
    "caseTypeAxes",
    "caseTypeSignature",
    "status",
    "qualityLabel",
    "expectedExtraction",
    "expectedClaimContext",
    "expectedCalculation",
    "billingTargets",
    "evidence",
    "sourceReviewPolicy",
    "reviewPolicy"
  ]) {
    if (item[key] === undefined) {
      errors.push(`${id}: ${key} is missing`);
    }
  }

  if (!item.caseTypeAxes || typeof item.caseTypeAxes !== "object" || Array.isArray(item.caseTypeAxes)) {
    errors.push(`${id}: caseTypeAxes must be an object`);
  } else {
    const recomputedSignature = caseTypeSignature(item);
    if (item.caseTypeSignature !== recomputedSignature) {
      errors.push(`${id}: caseTypeSignature is stale or invalid`);
    }
  }

  for (const section of ["S", "O", "A", "P"]) {
    const rows = item.chart?.soap?.[section];
    if (!Array.isArray(rows) || rows.length === 0) {
      errors.push(`${id}: SOAP ${section} is missing`);
    }
  }

  const chartText = ["S", "O", "A", "P"].flatMap((section) => item.chart?.soap?.[section] || []).join("\n");
  if (chartText.length < minChartChars) {
    errors.push(`${id}: chart text is too short (${chartText.length} chars)`);
  }
  if (/E2E|テスト|抽出/.test(chartText)) {
    errors.push(`${id}: chart text contains test metadata`);
  }

  const extraction = item.expectedExtraction;
  if (!extraction) {
    errors.push(`${id}: expectedExtraction is missing`);
  } else {
    for (const key of ["requiredDiagnoses", "requiredReviewTopics", "forbiddenCandidates", "requiredBillingSignals"]) {
      if (!Array.isArray(extraction[key])) {
        errors.push(`${id}: expectedExtraction.${key} must be an array`);
      }
    }
    const forbiddenCandidates = extraction.forbiddenCandidates || [];
    const forbiddenWithConfirmed = forbiddenCandidates.filter((value) => /\bconfirmed\b/i.test(String(value)));
    if (forbiddenWithConfirmed.length) {
      errors.push(`${id}: forbiddenCandidates must not use raw confirmed status labels (${forbiddenWithConfirmed.join(", ")})`);
    }
    const signalExpectations = extraction.signalExpectations;
    if (!signalExpectations) {
      errors.push(`${id}: signalExpectations is missing`);
    } else {
      for (const key of ["literalInChart", "derivedFromContext"]) {
        if (!Array.isArray(signalExpectations[key])) {
          errors.push(`${id}: signalExpectations.${key} must be an array`);
        }
      }
      const literalImageSignals = (signalExpectations.literalInChart || [])
        .map((item) => item.label)
        .filter((label) => /ＣＴ撮影|CT撮影|単純撮影|写真診断|デジタル撮影/.test(label));
      if (literalImageSignals.length) {
        errors.push(`${id}: image-derived signals must not be literalInChart (${literalImageSignals.join(", ")})`);
      }
    }
  }

  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    errors.push(`${id}: evidence is missing`);
  }
  if (["review_required", "safety", "unsupported_expected", "split_required"].includes(item.expectedCalculation?.assertionLevel) && (item.billingTargets || []).length > 0) {
    if (!Array.isArray(item.expectedExtraction?.forbiddenCandidates) || item.expectedExtraction.forbiddenCandidates.length === 0) {
      errors.push(`${id}: ${item.expectedCalculation.assertionLevel} case with billingTargets must declare forbiddenCandidates`);
    }
  }
  if (!["master_verified", "draft", "office_reviewed", "ci_enabled"].includes(item.status)) {
    errors.push(`${id}: unsupported status ${item.status}`);
  }
  if (!["verified", "needs_office_review", "unsupported_expected", "regression_only"].includes(item.qualityLabel)) {
    errors.push(`${id}: unsupported qualityLabel ${item.qualityLabel}`);
  }
  if (item.expectedCalculation?.assertionLevel === "exact" && item.status !== "master_verified") {
    errors.push(`${id}: exact case must use status=master_verified`);
  }
  if (item.expectedCalculation?.assertionLevel === "exact" && item.qualityLabel !== "verified") {
    errors.push(`${id}: exact case must use qualityLabel=verified`);
  }
  if (item.expectedCalculation?.assertionLevel === "exact") {
    if (/dpc/i.test(id) && item.expectedClaimContext?.inpatient_basic) {
      errors.push(`${id}: exact DPC-labeled case must not assert inpatient_basic fee-for-service billing`);
    }
    const collisions = forbiddenBillingCollisions(item);
    if (collisions.length) {
      errors.push(`${id}: exact case has forbiddenCandidates that collide with billed targets (${collisions.join(", ")})`);
    }
  }

  assertionCounts[item.expectedCalculation?.assertionLevel] = (assertionCounts[item.expectedCalculation?.assertionLevel] || 0) + 1;
  qualityCounts[item.qualityLabel] = (qualityCounts[item.qualityLabel] || 0) + 1;
  statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
  difficultyCounts[item.difficultyLevel] = (difficultyCounts[item.difficultyLevel] || 0) + 1;
}

const charCounts = (data.cases || []).map((item) => ["S", "O", "A", "P"].flatMap((section) => item.chart?.soap?.[section] || []).join("\n").length);
caseTypeSummary = caseTypeAudit(data.cases || []);
if (caseTypeSummary.uniqueCaseTypeSignatures !== expectedCount) {
  errors.push(`caseTypeSignature unique count ${caseTypeSummary.uniqueCaseTypeSignatures} != ${expectedCount}`);
}
if (caseTypeSummary.duplicateCaseTypeSignatureGroups > 0) {
  errors.push(`caseTypeSignature duplicate groups ${caseTypeSummary.duplicateCaseTypeSignatureGroups}`);
}

const summary = {
  datasetId: data.datasetId,
  path: datasetPath,
  cases: data.cases?.length || 0,
  assertionCounts,
  qualityCounts,
  statusCounts,
  difficultyCounts,
  minChars: Math.min(...charCounts),
  avgChars: Math.round(charCounts.reduce((sum, value) => sum + value, 0) / charCounts.length),
  maxChars: Math.max(...charCounts),
  caseTypeSummary: {
    uniqueCaseTypeSignatures: caseTypeSummary.uniqueCaseTypeSignatures,
    duplicateCaseTypeSignatureGroups: caseTypeSummary.duplicateCaseTypeSignatureGroups,
    uniqueBaseSignatures: caseTypeSummary.uniqueBaseSignatures,
    duplicateBaseSignatureGroups: caseTypeSummary.duplicateBaseSignatureGroups
  }
};

const minimumAssertionCounts = {
  exact: 250,
  review_required: 300,
  safety: 50,
  unsupported_expected: 100,
  split_required: 10
};
for (const [level, minimum] of Object.entries(minimumAssertionCounts)) {
  if ((assertionCounts[level] || 0) < minimum) {
    errors.push(`assertionCounts.${level} ${assertionCounts[level] || 0} < ${minimum}`);
  }
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors, summary }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, summary }, null, 2));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function forbiddenBillingCollisions(item) {
  const forbidden = item.expectedExtraction?.forbiddenCandidates || [];
  const targetCodes = new Set([
    ...(item.billingTargets || []).map((target) => String(target.code || "")).filter(Boolean),
    ...(item.expectedCalculation?.candidateCodes || []).map(String)
  ]);
  const targetNames = (item.billingTargets || [])
    .map((target) => normalizeLabel(target.name))
    .filter(Boolean);
  const collisions = [];
  for (const rawForbidden of forbidden) {
    const forbiddenText = normalizeLabel(rawForbidden);
    if (!forbiddenText) continue;
    const codeMatch = forbiddenText.match(/^コード(\d{6,})$/);
    if (targetCodes.has(String(rawForbidden)) || (codeMatch && targetCodes.has(codeMatch[1]))) {
      collisions.push(String(rawForbidden));
      continue;
    }
    const forbiddenLabel = forbiddenText
      .replace(/の自動確定$/u, "")
      .replace(/出来高確定$/u, "")
      .replace(/^条件未確認の/u, "")
      .replace(/の施設基準未確認$/u, "");
    if (forbiddenLabel.length >= 4 && targetNames.some((name) => name.includes(forbiddenLabel) || forbiddenLabel.includes(name))) {
      collisions.push(String(rawForbidden));
    }
  }
  return collisions;
}

function normalizeLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim();
}
