import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaimRiskReviewIssues } from "../src/claim-risk-knowledge.js";

test("buildClaimRiskReviewIssues detects laterality mismatch between diagnosis and imaging", () => {
  const issues = buildClaimRiskReviewIssues({
    feeSessionId: "fee_1",
    diagnoses: [{ name: "右膝関節症" }]
  }, {
    clinicalEvents: [{
      clinicalEventId: "event_1",
      name: "左膝X線撮影",
      eventType: "imaging",
      body_site: "左膝"
    }],
    lineItems: []
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].issueCode, "claim_risk_laterality_mismatch");
  assert.equal(issues[0].assessmentRisk.denialType, "A/B査定");
  assert.equal(issues[0].bodyLateralityCheck.diagnosisLaterality[0], "right");
  assert.equal(issues[0].bodyLateralityCheck.targetLaterality[0], "left");
});

test("buildClaimRiskReviewIssues detects body site mismatch between diagnosis and procedure", () => {
  const issues = buildClaimRiskReviewIssues({
    feeSessionId: "fee_1",
    diagnoses: [{ name: "胸部打撲" }]
  }, {
    clinicalEvents: [{
      clinicalEventId: "event_2",
      name: "右足創傷処置",
      eventType: "procedure",
      body_site: "右足"
    }],
    lineItems: []
  });

  assert.equal(issues.some((issue) => issue.issueCode === "claim_risk_body_site_mismatch"), true);
});
