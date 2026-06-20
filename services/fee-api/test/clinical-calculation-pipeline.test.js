import assert from "node:assert/strict";
import { test } from "node:test";

import {
  billingIntentsFromCanonicalClinicalFacts,
  calculationEventsFromCanonicalFacts,
  normalizeBillingIntents
} from "../src/clinical-calculation-pipeline.js";

test("builds billing intents only from verified eligible canonical facts", () => {
  const intents = billingIntentsFromCanonicalClinicalFacts([{
    factId: "fact_lab_1",
    status: "eligible_for_master_search",
    verification: { status: "verified" },
    eventType: "lab",
    conceptId: "lab:crp",
    clinicalName: "CRP",
    evidenceRefs: [{ lineId: "O-1", quote: "CRP 0.8" }]
  }, {
    factId: "fact_review_1",
    status: "review_required",
    verification: { status: "verified" },
    eventType: "lab",
    conceptId: "lab:hba1c",
    clinicalName: "HbA1c"
  }, {
    factId: "fact_blocked_1",
    status: "eligible_for_master_search",
    verification: { status: "blocked" },
    eventType: "imaging",
    conceptId: "imaging:ct",
    clinicalName: "CT"
  }]);

  assert.equal(intents.length, 1);
  assert.equal(intents[0].sourceFactId, "fact_lab_1");
  assert.equal(intents[0].intentType, "lab_test");
  assert.equal(intents[0].conceptId, "lab:crp");
});

test("deduplicates billing intents by id, source fact, and intent type", () => {
  const intents = normalizeBillingIntents([{
    billingIntentId: "intent_1",
    sourceFactId: "fact_1",
    intentType: "lab_test"
  }, {
    billingIntentId: "intent_1",
    sourceFactId: "fact_1",
    intentType: "lab_test"
  }, {
    billingIntentId: "intent_2",
    sourceFactId: "",
    intentType: "lab_test"
  }]);

  assert.deepEqual(intents, [{
    billingIntentId: "intent_1",
    sourceFactId: "fact_1",
    intentType: "lab_test"
  }]);
});

test("builds calculation events from all canonical facts while attaching billing intents only to eligible facts", () => {
  const facts = [{
    factId: "fact_lab_1",
    clinicalEventId: "ce_lab_1",
    status: "eligible_for_master_search",
    verification: { status: "verified", reasons: [] },
    eventType: "lab",
    billingDomain: "standard_lab",
    conceptId: "lab:crp",
    clinicalName: "CRP",
    actionStatus: "performed",
    temporalRelation: "current_visit",
    sourceOrigin: "own_clinic_record",
    providerOwnership: "own_clinic",
    resultAssertion: "numeric",
    evidenceRefs: [{ lineId: "O-001", quote: "CRP 0.8" }],
    searchQueries: ["ＣＲＰ"]
  }, {
    factId: "fact_review_1",
    clinicalEventId: "ce_review_1",
    status: "review_required",
    verification: { status: "verified", reasons: [] },
    eventType: "management",
    billingDomain: "standard_management",
    conceptId: "standard_management:monthly_duplicate",
    clinicalName: "同日重複確認",
    actionStatus: "considered",
    temporalRelation: "current_visit",
    sourceOrigin: "own_clinic_record",
    providerOwnership: "own_clinic",
    resultAssertion: "not_applicable",
    evidenceRefs: [{ lineId: "A-001", quote: "同日重複確認が必要。" }],
    reviewReason: "同日重複確認"
  }];
  const intents = billingIntentsFromCanonicalClinicalFacts(facts);
  const events = calculationEventsFromCanonicalFacts({ facts, billingIntents: intents });

  assert.equal(events.length, 2);
  assert.equal(events[0].sourceFactId, "fact_lab_1");
  assert.equal(events[0].sourceBillingIntentId, intents[0].billingIntentId);
  assert.deepEqual(events[0].evidence_line_ids, ["O-001"]);
  assert.deepEqual(events[0].search_queries, ["ＣＲＰ", "CRP"]);
  assert.equal(events[1].sourceFactId, "fact_review_1");
  assert.equal(events[1].sourceBillingIntentId, undefined);
  assert.equal(events[1].review_reason, "同日重複確認");
});
