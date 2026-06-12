#!/usr/bin/env node
// v2 1000ケース算定ゴールドblueprintの検証器。
// SOAP本文は検証しない。blueprint段階で、期待算定・レビューtopic・施設fixture・一意性を検証する。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blueprintPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/gold-blueprints.json");
const matrixPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/coverage-matrix-v2.json");
const fixturesPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/facility-fixtures.json");

const data = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8")).fixtures || {};

const errors = [];
const warnings = [];
const blueprints = data.blueprints || [];

const REQUIRED_ASSERTIONS = ["exact", "review_required", "safety", "unsupported_expected", "split_required"];
const REVIEW_LIKE = new Set(["review_required", "safety", "unsupported_expected", "split_required"]);

function fail(blueprintId, error) {
  errors.push({ blueprintId, error });
}

function warn(blueprintId, warning) {
  warnings.push({ blueprintId, warning });
}

if (blueprints.length !== matrix.totalCases) {
  fail("(dataset)", `expected ${matrix.totalCases} blueprints, got ${blueprints.length}`);
}

const byAssertion = {};
const ids = new Set();
const caseTypeKeys = new Set();
const exactPointShapes = new Set();
const authored = [];

for (const item of blueprints) {
  const id = item.blueprintId || "(missing id)";
  if (!item.blueprintId) fail(id, "missing blueprintId");
  if (ids.has(item.blueprintId)) fail(id, "duplicate blueprintId");
  ids.add(item.blueprintId);

  for (const key of [
    "status",
    "caseTypeKey",
    "title",
    "department",
    "billingDomains",
    "assertionLevel",
    "facilityFixtureKey",
    "patientProfile",
    "encounter",
    "expectedExtraction",
    "expectedClaimContext",
    "expectedCalculation",
    "requiredClinicalAnchors",
    "chartAuthoringState",
    "reviewPolicy"
  ]) {
    if (item[key] === undefined) fail(id, `missing field: ${key}`);
  }

  if (caseTypeKeys.has(item.caseTypeKey)) fail(id, "duplicate caseTypeKey");
  caseTypeKeys.add(item.caseTypeKey);

  if (!fixtures[item.facilityFixtureKey]) fail(id, `unknown facilityFixtureKey: ${item.facilityFixtureKey}`);
  if (!REQUIRED_ASSERTIONS.includes(item.assertionLevel)) fail(id, `unknown assertionLevel: ${item.assertionLevel}`);
  byAssertion[item.assertionLevel] = (byAssertion[item.assertionLevel] || 0) + 1;

  if (!Array.isArray(item.billingDomains) || item.billingDomains.length === 0) fail(id, "billingDomains must be non-empty");
  if (!Array.isArray(item.requiredClinicalAnchors) || item.requiredClinicalAnchors.length === 0) fail(id, "requiredClinicalAnchors must be non-empty");

  if (item.reviewPolicy?.productionGoldAllowed !== false) fail(id, "productionGoldAllowed must be false");
  if (item.reviewPolicy?.medicalOfficeReviewed !== false) fail(id, "medicalOfficeReviewed must be false");

  const expected = item.expectedCalculation || {};
  if (expected.assertionLevel !== item.assertionLevel) fail(id, "expectedCalculation.assertionLevel mismatch");

  if (item.assertionLevel === "exact") {
    if (typeof expected.totalPoints !== "number" || expected.totalPoints <= 0) fail(id, "exact blueprint must have positive totalPoints");
    if (!Array.isArray(expected.candidateCodes) || expected.candidateCodes.length === 0) fail(id, "exact blueprint must have candidateCodes");
    if (expected.engineStatus !== "completed") fail(id, "exact blueprint must expect completed engineStatus");
    exactPointShapes.add(`${expected.totalPoints}:${expected.candidateCodes.join(",")}`);
    if (item.expectedExtraction?.requiredReviewTopics?.length) {
      warn(id, "exact blueprint has requiredReviewTopics; confirm this is intentional");
    }
  } else if (REVIEW_LIKE.has(item.assertionLevel)) {
    if (expected.engineStatus !== "needs_review") fail(id, `${item.assertionLevel} blueprint must expect needs_review`);
    if (expected.totalPoints !== null) fail(id, `${item.assertionLevel} blueprint must not claim exact totalPoints`);
    const topics = item.expectedExtraction?.requiredReviewTopics || [];
    const forbidden = item.expectedExtraction?.forbiddenCandidates || [];
    if (topics.length === 0 && !(item.assertionLevel === "safety" && forbidden.length > 0)) {
      fail(id, `${item.assertionLevel} blueprint must have requiredReviewTopics`);
    }
  }

  if (item.status === "chart_authored") authored.push(item.blueprintId);
}

for (const assertion of Object.keys(matrix.assertionMix || {})) {
  const got = byAssertion[assertion] || 0;
  const want = matrix.assertionMix[assertion];
  if (got !== want) fail("(dataset)", `assertionMix mismatch for ${assertion}: expected ${want}, got ${got}`);
}

if ((byAssertion.exact || 0) > 0 && exactPointShapes.size < 10) {
  warnings.push({ blueprintId: "(dataset)", warning: `exact point/code shapes are low variety: ${exactPointShapes.size}` });
}

const statusCounts = {};
for (const item of blueprints) statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;

const ok = errors.length === 0;
console.log(JSON.stringify({
  ok,
  blueprintPath: path.relative(repoRoot, blueprintPath),
  blueprints: blueprints.length,
  authoredCharts: authored.length,
  pendingCharts: blueprints.length - authored.length,
  assertionMix: byAssertion,
  statusCounts,
  exactPointShapes: exactPointShapes.size,
  errors: errors.slice(0, 50),
  errorCount: errors.length,
  warnings: warnings.slice(0, 20),
  warningCount: warnings.length
}, null, 2));

if (!ok) process.exitCode = 1;
