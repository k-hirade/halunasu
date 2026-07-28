import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectAuxiliaryExtractionConflicts,
  findUncoveredAuxiliarySpans,
  mergeAuxiliaryRecheckFacts,
  normalizeExtractionCoverageOptions,
  planExtractionRecovery
} from "../src/extraction-coverage-recheck.js";

const LINES = [
  { lineId: "O-001", section: "O", text: "O: 胸部X線を実施。" },
  { lineId: "P-001", section: "P", text: "P: 創傷処置を実施。" }
];

function signal({
  lineId = "O-001",
  category = "imaging",
  charStart = 3,
  charEnd = 6,
  confidence = 0.9
} = {}) {
  return {
    lineId,
    clauseId: `${lineId}-C01`,
    category,
    charStart,
    charEnd,
    confidence,
    artifactThreshold: 0.5,
    normalizedTextHash: "safe-hash"
  };
}

test("facility allowlist denial disables extraction coverage", () => {
  assert.deepEqual(
    normalizeExtractionCoverageOptions({
      mode: "verify",
      facilityAllowed: false,
      maxLines: 99,
      maxSpans: 99,
      timeoutMs: 1
    }),
    {
      mode: "off",
      configuredMode: "verify",
      facilityAllowed: false,
      disabledReason: "facility_not_allowlisted",
      maxLines: 16,
      maxSpans: 32,
      timeoutMs: 100
    }
  );
});

test("auxiliary conflicts are reported without replacing the initial disposition", () => {
  const initialEvent = {
    type: "procedure",
    name: "創傷処置",
    action_status: "performed",
    temporal_relation: "current_visit",
    provider_ownership: "own_clinic",
    evidence_line_ids: ["P-001"]
  };
  const recheckEvent = {
    ...initialEvent,
    action_status: "planned",
    temporal_relation: "future"
  };
  const conflicts = detectAuxiliaryExtractionConflicts([initialEvent], [recheckEvent]);
  const merged = mergeAuxiliaryRecheckFacts(
    { clinical_events: [initialEvent] },
    { clinical_events: [recheckEvent] }
  );

  assert.equal(conflicts.length, 1);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.facts.clinical_events.length, 1);
  assert.equal(merged.facts.clinical_events[0].action_status, "performed");
});

test("coverage comparison is line-scoped and identifies only missing spans", () => {
  const result = findUncoveredAuxiliarySpans({
    lines: LINES,
    signals: [
      signal(),
      signal({
        lineId: "P-001",
        category: "procedure",
        charStart: 3,
        charEnd: 7
      })
    ],
    facts: {
      clinical_events: [{
        name: "胸部X線撮影",
        evidence_line_ids: ["O-001"]
      }],
      line_review: [
        { line_id: "O-001", line_role: "performed" },
        { line_id: "P-001", line_role: "performed" }
      ]
    }
  });

  assert.equal(result.coveredSignals.length, 1);
  assert.equal(result.coveredSignals[0].lineId, "O-001");
  assert.equal(result.gapSignals.length, 1);
  assert.equal(result.gapSignals[0].lineId, "P-001");
  assert.equal(result.gapSignals[0].detectedPhrase, "創傷処置");
});

test("event evidence covers an equivalent span even when the event name differs", () => {
  const text = "P: 次回来院時にHbA1c検査と尿検査を実施する予定。";
  const phrase = "尿検査";
  const charStart = [...text].join("").indexOf(phrase);
  const result = findUncoveredAuxiliarySpans({
    lines: [{
      lineId: "P-001",
      section: "P",
      text
    }],
    signals: [signal({
      lineId: "P-001",
      category: "lab",
      charStart,
      charEnd: charStart + [...phrase].length
    })],
    facts: {
      clinical_events: [{
        name: "尿一般検査",
        action_status: "planned",
        temporal_relation: "future",
        evidence: "次回来院時にHbA1c検査と尿検査を実施する予定。",
        evidence_line_ids: ["P-001"]
      }]
    }
  });

  assert.equal(result.coveredSignals.length, 1);
  assert.equal(result.gapSignals.length, 0);
});

test("recovery planning enforces line and span limits", () => {
  const gapSignals = [
    signal({ lineId: "O-001", confidence: 0.8 }),
    signal({
      lineId: "P-001",
      category: "procedure",
      charStart: 3,
      charEnd: 7,
      confidence: 0.9
    })
  ].map((entry, index) => ({
    ...entry,
    detectedPhrase: index === 0 ? "胸部X線" : "創傷処置"
  }));
  const plan = planExtractionRecovery({
    lines: LINES,
    missingLineIds: ["O-001"],
    gapSignals,
    maxLines: 1,
    maxSpans: 1
  });

  assert.equal(plan.needed, true);
  assert.deepEqual(plan.lineIds, ["O-001"]);
  assert.equal(plan.selectedSignals.length, 0);
  assert.equal(plan.omittedLineCount, 1);
  assert.equal(plan.omittedSpanCount, 2);
});

test("auxiliary merge is monotonic and preserves initial visit facts", () => {
  const initial = {
    visit_type: { kind: "revisit" },
    visit_facts: { outside_prescription_issued: "no" },
    diagnoses: [{ name: "高血圧症" }],
    standing_mentions: [{
      line_id: "P-001",
      target: "在宅酸素療法",
      status: "continued"
    }],
    line_review: [{ line_id: "P-001", line_role: "none" }],
    clinical_events: [{
      type: "imaging",
      name: "胸部X線",
      action_status: "performed",
      evidence_line_ids: ["O-001"]
    }]
  };
  const merged = mergeAuxiliaryRecheckFacts(initial, {
    visit_type: { kind: "first_visit" },
    visit_facts: { outside_prescription_issued: "yes" },
    diagnoses: [{ name: "糖尿病" }],
    standing_mentions: [{
      line_id: "P-001",
      target: "人工呼吸器管理",
      status: "continued"
    }],
    line_review: [{ line_id: "P-001", line_role: "performed" }],
    clinical_events: [{
      type: "procedure",
      name: "創傷処置",
      action_status: "performed",
      evidence_line_ids: ["P-001"]
    }]
  });

  assert.deepEqual(merged.facts.visit_type, initial.visit_type);
  assert.deepEqual(merged.facts.visit_facts, initial.visit_facts);
  assert.deepEqual(merged.facts.diagnoses, initial.diagnoses);
  assert.deepEqual(merged.facts.standing_mentions, initial.standing_mentions);
  assert.deepEqual(merged.facts.line_review, [{
    line_id: "P-001",
    line_role: "performed"
  }]);
  assert.equal(merged.recoveredClinicalEventCount, 1);
  assert.equal(merged.facts.clinical_events.length, 2);
  assert.equal(
    merged.facts.clinical_events[1].extraction_source,
    "openai_auxiliary_recheck"
  );
});

test("initial excluded fact wins over a contradictory current recheck", () => {
  const excluded = {
    type: "procedure",
    name: "創傷処置",
    action_status: "past",
    temporal_relation: "past",
    provider_ownership: "own_clinic",
    evidence_line_ids: ["P-001"]
  };
  const rechecked = {
    ...excluded,
    action_status: "performed",
    temporal_relation: "current_visit"
  };

  const merged = mergeAuxiliaryRecheckFacts(
    {
      clinical_events: [],
      excluded_events: [excluded]
    },
    {
      clinical_events: [rechecked],
      excluded_events: []
    }
  );

  assert.equal(merged.conflicts.length, 1);
  assert.equal(
    merged.conflicts[0].reason,
    "initial_excluded_recheck_current"
  );
  assert.deepEqual(merged.facts.clinical_events, []);
  assert.deepEqual(merged.facts.excluded_events, [excluded]);
  assert.equal(merged.recoveredClinicalEventCount, 0);
});

test("internally contradictory auxiliary facts are not promoted", () => {
  const performed = {
    type: "imaging",
    name: "胸部X線",
    action_status: "performed",
    temporal_relation: "current_visit",
    provider_ownership: "own_clinic",
    evidence_line_ids: ["O-001"]
  };
  const excluded = {
    ...performed,
    action_status: "not_performed"
  };

  const merged = mergeAuxiliaryRecheckFacts(
    { clinical_events: [], excluded_events: [] },
    {
      clinical_events: [performed],
      excluded_events: [excluded]
    }
  );

  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].reason, "recheck_internal_conflict");
  assert.deepEqual(merged.facts.clinical_events, []);
  assert.deepEqual(merged.facts.excluded_events, []);
});
