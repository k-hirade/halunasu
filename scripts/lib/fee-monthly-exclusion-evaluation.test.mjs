import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMonthlyExclusionResolutionPlan,
  sanitizeMonthlyExclusion,
  sanitizeMonthlyExportResponse,
  summarizeMonthlyExclusionRuns
} from "./fee-monthly-exclusion-evaluation.mjs";

const simpleConflict = {
  conflictId: "mex_1",
  componentSize: 2,
  complex: false,
  scope: "same_day",
  scopeKey: "2026-07-01",
  pairKey: "same_day:100:200",
  ruleFingerprint: "fp-1",
  codeA: "100",
  codeB: "200",
  resolution: "auto_winner",
  defaultAction: "acknowledge_auto",
  allowedActions: ["acknowledge_auto", "reject_both"],
  status: "unresolved",
  blockingExport: true,
  blockedOccurrenceIds: ["occ-1"]
};

test("sanitizes monthly exclusion without occurrence identifiers or clinical payloads", () => {
  const result = sanitizeMonthlyExclusion({
    exclusionMode: "enforce",
    exclusionConstraintsStatus: "complete",
    unresolvedExclusionCount: 1,
    blockedLines: [
      { code: "100", clinicalText: "secret" },
      { code: "100", clinicalText: "secret duplicate" }
    ],
    exclusionConflicts: [simpleConflict]
  });
  assert.equal(result.unresolvedConflictCount, 1);
  assert.equal(result.blockedLineCount, 2);
  assert.deepEqual(result.blockedCodes, ["100"]);
  assert.equal(result.conflicts[0].blockedOccurrenceCount, 1);
  assert.equal(Object.hasOwn(result.conflicts[0], "occurrenceIds"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("builds only safe two-code resolution mutations", () => {
  const result = buildMonthlyExclusionResolutionPlan({
    conflicts: [
      simpleConflict,
      { ...simpleConflict, conflictId: "mex_2", complex: true },
      { ...simpleConflict, conflictId: "mex_3", status: "resolved", action: "acknowledge_auto" },
      { ...simpleConflict, conflictId: "mex_4", resolution: "unsupported_rule_kind", defaultAction: null }
    ]
  });
  assert.equal(result.plannedCount, 1);
  assert.equal(result.complexSkippedCount, 1);
  assert.equal(result.alreadyResolvedCount, 1);
  assert.equal(result.unsupportedSkippedCount, 1);
  assert.deepEqual(result.plan[0], {
    pairKey: "same_day:100:200",
    scopeKey: "2026-07-01",
    ruleFingerprint: "fp-1",
    resolution: "auto_winner",
    action: "acknowledge_auto"
  });
});

test("records only export metadata, content hash, and forbidden-code checks", () => {
  const result = sanitizeMonthlyExportResponse({
    statusCode: 200,
    durationMs: 12.5,
    rawBody: "RE,1",
    responseHeaders: { "content-type": "text/csv" }
  }, {
    forbiddenCodes: ["140003810"]
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.byteLength, 4);
  assert.equal(result.sha256.length, 64);
  assert.equal(result.allForbiddenCodesAbsent, true);
  assert.deepEqual(result.forbiddenCodeChecks, [{
    code: "140003810",
    present: false
  }]);
  assert.equal(Object.hasOwn(result, "rawBody"), false);
});

test("detects a blocked fee code without persisting the export body", () => {
  const result = sanitizeMonthlyExportResponse({
    statusCode: 200,
    rawBody: "SI,140003810,1",
    responseHeaders: { "content-type": "text/plain" }
  }, {
    forbiddenCodes: ["140003810"]
  });
  assert.equal(result.allForbiddenCodesAbsent, false);
  assert.equal(result.forbiddenCodeChecks[0].present, true);
  assert.equal(JSON.stringify(result).includes("SI,140003810,1"), false);
});

test("summarizes resolution and export outcomes", () => {
  const summary = summarizeMonthlyExclusionRuns([{
    monthlyExclusionResolution: {
      requestedAction: "default",
      before: { conflictCount: 1, unresolvedConflictCount: 1 },
      plan: { plannedCount: 1, complexSkippedCount: 0, unsupportedSkippedCount: 0 },
      resolvedCount: 1,
      failedCount: 0,
      skippedUnsupportedCount: 0,
      after: { unresolvedConflictCount: 0 },
      exports: {
        before: { csv: { statusCode: 409 }, uke: { statusCode: 409 } },
        after: {
          csv: { statusCode: 200, allForbiddenCodesAbsent: true },
          uke: { statusCode: 200, allForbiddenCodesAbsent: true }
        }
      }
    }
  }]);
  assert.equal(summary.allPlannedResolutionsSucceeded, true);
  assert.equal(summary.allAfterExportsExcludeBlockedCodes, true);
  assert.deepEqual(summary.csvStatusAfter, [200]);
});
