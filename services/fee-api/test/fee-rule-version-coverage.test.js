import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFeeRuleVersionCoverageToPreparation } from "../src/fee-rule-version-coverage.js";

test("adds one explicit review issue when the service date predates the rule version", () => {
  const result = applyFeeRuleVersionCoverageToPreparation({
    reviewIssues: [],
    reviewWarnings: []
  }, {
    serviceDate: "2026-05-31"
  });

  assert.equal(result.metrics.feeRuleVersionCoverage.status, "unavailable");
  assert.equal(result.reviewIssues.length, 1);
  assert.equal(result.reviewIssues[0].issueCode, "fee_rule_version_unavailable");
  assert.match(result.reviewIssues[0].messageForStaff, /適用可能な点数表・ルール版がありません/u);
  assert.equal(result.reviewWarnings.length, 1);
});

test("does not add a warning when the rule version covers the service date", () => {
  const result = applyFeeRuleVersionCoverageToPreparation({
    reviewIssues: [],
    reviewWarnings: []
  }, {
    serviceDate: "2026-06-01"
  });

  assert.equal(result.metrics.feeRuleVersionCoverage.status, "available");
  assert.deepEqual(result.reviewIssues, []);
  assert.deepEqual(result.reviewWarnings, []);
});

test("uses the master lookup date for current-master repricing", () => {
  const result = applyFeeRuleVersionCoverageToPreparation({
    reviewIssues: [],
    reviewWarnings: []
  }, {
    serviceDate: "2025-01-15",
    pricingContext: {
      mode: "current_master",
      masterLookupDate: "2026-06-15",
      historicalReproduction: false
    }
  });

  assert.equal(result.metrics.feeRuleVersionCoverage.status, "available");
  assert.equal(result.metrics.feeRuleVersionCoverage.originalServiceDate, "2025-01-15");
  assert.equal(result.metrics.feeRuleVersionCoverage.pricingMode, "current_master");
  assert.equal(result.metrics.feeRuleVersionCoverage.historicalReproduction, false);
  assert.deepEqual(result.reviewIssues, []);
});
