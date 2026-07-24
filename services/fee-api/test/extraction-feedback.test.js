import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoForbiddenExtractionFeedbackFields,
  buildCalculationFeedbackEvents,
  buildReviewDecisionFeedbackEvents,
  captureExtractionFeedback,
  extractionFeedbackReadiness,
  validateExtractionFeedbackEvent
} from "../src/extraction-feedback.js";
import { MemoryFeeStore } from "../src/store/memory-store.js";

const COLLECT_ENV = {
  FEE_EXTRACTION_FEEDBACK_MODE: "collect",
  FEE_EXTRACTION_FEEDBACK_HMAC_SECRET: "unit-test-only-hmac-secret",
  FEE_EXTRACTION_FEEDBACK_HMAC_KEY_VERSION: "test-v1"
};

test("WX4 feedback readiness is off by default and requires an HMAC secret", () => {
  assert.deepEqual(extractionFeedbackReadiness({}), {
    mode: "off",
    ready: true,
    secretConfigured: false,
    hmacKeyVersion: "v1",
    reason: null
  });
  assert.equal(extractionFeedbackReadiness({
    FEE_EXTRACTION_FEEDBACK_MODE: "collect"
  }).ready, false);
  assert.equal(extractionFeedbackReadiness(COLLECT_ENV).ready, true);
});

test("WX4 review feedback stores only structured HMAC-correlated signals", () => {
  const events = buildReviewDecisionFeedbackEvents({
    orgId: "org_test",
    feeSessionId: "fee_session_1001",
    feeSession: {
      setting: "outpatient",
      departmentSnapshot: { specialty: "皮膚科" }
    },
    reviewItems: [{
      reviewItemId: "review_1",
      candidateProposal: {
        source: "whitebox_linker",
        confidence: 0.94,
        candidateLine: {
          code: "140000610",
          orderType: "procedure",
          extractionSource: "encoder"
        }
      }
    }],
    decisions: [{
      reviewItemId: "review_1",
      status: "rejected",
      rejectReason: "extraction_wrong"
    }],
    env: COLLECT_ENV,
    now: new Date("2026-07-24T00:00:00.000Z")
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].learningEligible, true);
  assert.equal(events[0].rejectReason, "extraction_wrong");
  assert.equal(events[0].specialty, "皮膚科");
  assert.match(events[0].sessionKeyHmac, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(events[0]).includes("fee_session_1001"), false);
  assert.doesNotThrow(() => assertNoForbiddenExtractionFeedbackFields(events[0]));
});

test("WX4 non-extraction rejection remains reportable but is not a training label", () => {
  const [event] = buildReviewDecisionFeedbackEvents({
    orgId: "org_test",
    feeSessionId: "fee_session_1",
    reviewItems: [{
      reviewItemId: "review_1",
      candidateProposal: {
        source: "whitebox_linker",
        candidateLine: {
          code: "114057970",
          orderType: "procedure",
          extractionSource: "encoder"
        }
      }
    }],
    decisions: [{
      reviewItemId: "review_1",
      status: "rejected",
      rejectReason: "facility_standard_missing"
    }],
    env: COLLECT_ENV
  });
  assert.equal(event.outcome, "rejected");
  assert.equal(event.learningEligible, false);
});

test("WX4 calculation feedback preserves disagreement axes without raw text", () => {
  const events = buildCalculationFeedbackEvents({
    orgId: "org_test",
    feeSessionId: "fee_session_1",
    clinicalMetrics: {
      whiteboxExtraction: {
        shadowComparison: {
          encoderOnlyCodes: ["140000610"],
          llmOnlyCodes: ["160000410"]
        },
        contextDisagreementCount: 1,
        contextDisagreementAxes: ["action_status", "provider_ownership"]
      },
      emptyExtractionGuard: { triggered: true },
      lineReviewRetryCount: 1
    },
    calculationKey: "calc_1",
    env: COLLECT_ENV
  });

  assert.equal(events.length, 5);
  const contextEvent = events.find((event) => event.eventType === "context_disagreement");
  assert.deepEqual(contextEvent.failureFeatureTags, [
    "wrong_context_axis:action_status",
    "wrong_context_axis:provider_ownership"
  ]);
  assert.equal(events.some((event) => event.failureFeatureTags.includes("span_miss")), true);
  assert.doesNotThrow(() => events.forEach(validateExtractionFeedbackEvent));
});

test("WX4 validation rejects prohibited identifiers and raw clinical fields", () => {
  assert.throws(
    () => assertNoForbiddenExtractionFeedbackFields({
      eventType: "review_decision",
      patientId: "1001"
    }),
    /forbidden feedback field/u
  );
  assert.throws(
    () => assertNoForbiddenExtractionFeedbackFields({
      nested: { clinicalText: "S: ..." }
    }),
    /forbidden feedback field/u
  );
});

test("WX4 capture is disabled by default and persists validated events in collect mode", async () => {
  const store = new MemoryFeeStore();
  const events = buildCalculationFeedbackEvents({
    orgId: "org_test",
    feeSessionId: "fee_session_1",
    clinicalMetrics: {
      whiteboxExtraction: {
        shadowComparison: { encoderOnlyCodes: ["140000610"] }
      }
    },
    env: COLLECT_ENV
  });
  const disabled = await captureExtractionFeedback({ feeStore: store, events, env: {} });
  assert.equal(disabled.status, "disabled");
  const captured = await captureExtractionFeedback({
    feeStore: store,
    events,
    env: COLLECT_ENV
  });
  assert.equal(captured.status, "complete");
  assert.equal(captured.storedCount, 1);
  assert.equal(store.listExtractionFeedbackEvents("org_test").length, 1);
});
