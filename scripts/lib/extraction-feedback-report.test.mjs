import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExtractionFeedbackReport,
  renderExtractionFeedbackMarkdown
} from "../report_extraction_feedback.mjs";

test("WX4 weekly report aggregates specialty-category holes and rejection patterns", () => {
  const report = buildExtractionFeedbackReport([
    feedbackEvent({
      code: "140000610",
      specialty: "皮膚科",
      category: "procedure",
      confidence: 0.9,
      outcome: "approved",
      learningEligible: true,
      failureFeatureTags: ["quantity_area_expression"]
    }),
    feedbackEvent({
      code: "140000610",
      specialty: "皮膚科",
      category: "procedure",
      confidence: 0.9,
      outcome: "rejected",
      rejectReason: "extraction_wrong",
      learningEligible: true,
      failureFeatureTags: ["quantity_area_expression", "wrong_code"]
    }),
    feedbackEvent({
      code: "114057970",
      specialty: "在宅",
      category: "management",
      confidence: 0.8,
      outcome: "rejected",
      rejectReason: "facility_standard_missing",
      learningEligible: false
    })
  ], {
    generatedAt: "2026-07-24T00:00:00.000Z",
    since: "2026-07-17T00:00:00.000Z",
    until: "2026-07-24T00:00:00.000Z"
  });

  assert.equal(report.eventCount, 3);
  assert.equal(report.learningEligibleCount, 2);
  assert.deepEqual(report.holesTopN[0], {
    specialty: "皮膚科",
    category: "procedure",
    count: 2,
    featureTags: [
      ["quantity_area_expression", 2],
      ["wrong_code", 1]
    ]
  });
  assert.equal(report.rejectedPatternsTopN[0].code, "114057970");
  assert.equal(report.rejectedPatternsTopN[0].rejectionRate, 1);
  assert.equal(report.confidenceCalibration[0].decisionCount, 2);
  assert.equal(report.confidenceCalibration[0].observedAccuracy, 0.5);

  const markdown = renderExtractionFeedbackMarkdown(report);
  assert.match(markdown, /皮膚科/u);
  assert.match(markdown, /quantity_area_expression/u);
  assert.doesNotMatch(markdown, /patientId|clinicalText|sessionKeyHmac/u);
});

function feedbackEvent(overrides = {}) {
  return {
    eventType: "review_decision",
    code: "unresolved",
    category: "unknown",
    specialty: "unknown",
    confidence: null,
    route: "encoder",
    outcome: "observed",
    rejectReason: null,
    failureFeatureTags: [],
    learningEligible: false,
    ...overrides
  };
}
