#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultCasesPath = path.join(repoRoot, "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json");
const casesPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultCasesPath;

const REVIEW_ONLY_CODES = new Map([
  ["160208510", "鼻腔・咽頭拭い液採取"]
]);

const AUTO_DERIVED_CODES = new Map([
  ["160095710", "Ｂ－Ｖ"]
]);

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const rows = Array.isArray(cases) ? cases : Object.values(cases || {}).flat();

const conflicts = [];
const counts = {
  totalCases: 0,
  reviewOnlyCodeConflicts: 0,
  reviewOnlyTextMentions: 0,
  autoDerivedCodeMentions: 0
};

for (const testCase of rows) {
  if (!testCase || typeof testCase !== "object") continue;
  counts.totalCases += 1;
  const id = testCase.id || testCase.caseId || testCase.slug || testCase.title || `case_${counts.totalCases}`;
  const expectedCodes = collectExpectedCodes(testCase);
  const text = JSON.stringify(testCase);

  for (const [code, name] of REVIEW_ONLY_CODES) {
    if (expectedCodes.has(code)) {
      counts.reviewOnlyCodeConflicts += 1;
      conflicts.push({ id, code, name, reason: "review_only_code_in_expected_claim" });
    }
    if (text.includes(name) || /鼻咽頭ぬぐい|鼻腔ぬぐい|咽頭ぬぐい|スワブ/u.test(text)) {
      counts.reviewOnlyTextMentions += 1;
    }
  }

  for (const code of AUTO_DERIVED_CODES.keys()) {
    if (expectedCodes.has(code)) {
      counts.autoDerivedCodeMentions += 1;
    }
  }
}

const result = {
  casesPath,
  policy: {
    reviewOnlyCodes: Object.fromEntries(REVIEW_ONLY_CODES),
    autoDerivedCodes: Object.fromEntries(AUTO_DERIVED_CODES)
  },
  counts,
  conflicts
};

console.log(JSON.stringify(result, null, 2));

if (conflicts.length) {
  process.exitCode = 1;
}

function collectExpectedCodes(value, result = new Set()) {
  if (!value || typeof value !== "object") {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExpectedCodes(item, result);
    return result;
  }

  const keyCandidates = ["code", "masterCode", "standardCode", "expectedCode"];
  for (const key of keyCandidates) {
    const code = String(value[key] || "").trim();
    if (/^\d{9}$/.test(code)) {
      result.add(code);
    }
  }

  for (const key of [
    "requiredCodes",
    "expectedCodes",
    "candidateCodes",
    "forbiddenCodes",
    "expectedCandidateCodes",
    "requiredCandidateCodes"
  ]) {
    for (const code of Array.isArray(value[key]) ? value[key] : []) {
      const normalized = String(code || "").trim();
      if (/^\d{9}$/.test(normalized)) {
        result.add(normalized);
      }
    }
  }

  for (const nested of Object.values(value)) {
    collectExpectedCodes(nested, result);
  }
  return result;
}
