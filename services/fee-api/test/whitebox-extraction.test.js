import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aggregateLineContext,
  buildLinkerCandidateLayer,
  contextConsensus,
  contextRoleFromAxes,
  determineWhiteboxVisitFacts,
  prepareWhiteboxExtraction,
  whiteboxEncounterSetting,
  whiteboxRuntimeModes,
  whiteboxThresholds
} from "../src/whitebox-extraction.js";
import {
  mergeClinicalFactsSamples,
  reconcileLineReview
} from "../src/clinical-calculation-input.js";

const CURRENT_AXES = {
  actionStatus: { value: "performed", confidence: 0.99, abstained: false },
  temporalRelation: { value: "current_visit", confidence: 0.99, abstained: false },
  sourceOrigin: { value: "own_clinic_record", confidence: 0.99, abstained: false },
  providerOwnership: { value: "own_clinic", confidence: 0.99, abstained: false },
  standingStatus: { value: "none", confidence: 0.99, abstained: false }
};

test("whitebox modes are fail-safe off for missing and invalid values", () => {
  assert.deepEqual(whiteboxRuntimeModes({}), {
    linker: "off",
    context: "off",
    span: "off"
  });
  assert.deepEqual(whiteboxRuntimeModes({
    FEE_LINKER_MODE: "propose",
    FEE_CONTEXT_CLASSIFIER_MODE: "assist",
    FEE_SPAN_DETECTOR_MODE: "route"
  }), {
    linker: "propose",
    context: "assist",
    span: "route"
  });
  assert.equal(whiteboxRuntimeModes({ FEE_SPAN_DETECTOR_MODE: "unsafe" }).span, "off");
});

test("WX1 threshold configuration applies setting, specialty, then exact cell overrides", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fee-whitebox-thresholds-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const thresholdPath = join(directory, "routing-thresholds.json");
  writeFileSync(thresholdPath, JSON.stringify({
    schemaVersion: 1,
    version: "thresholds-v1",
    defaults: {
      spanConfidence: 0.9,
      contextConfidence: 0.9,
      linkerHighScore: 0.92,
      linkerReviewScore: 0.8,
      linkerMargin: 0.05,
      relevanceConfidence: 0.95
    },
    cells: {
      "*|home_visit": { spanConfidence: 0.94 },
      "皮膚科|*": { contextConfidence: 0.96 },
      "皮膚科|home_visit": { linkerHighScore: 0.97 }
    }
  }));

  const thresholds = whiteboxThresholds(
    { FEE_WHITEBOX_THRESHOLDS_PATH: thresholdPath },
    { specialty: " 皮膚科 ", encounterSetting: "HOME_VISIT" }
  );
  assert.equal(thresholds.spanConfidence, 0.94);
  assert.equal(thresholds.contextConfidence, 0.96);
  assert.equal(thresholds.linkerHighScore, 0.97);
  assert.deepEqual(thresholds.thresholdCells, [
    "defaults",
    "*|home_visit",
    "皮膚科|*",
    "皮膚科|home_visit"
  ]);
  assert.match(thresholds.version, /^thresholds-v1:cells=/);
});

test("whitebox uses a dedicated telephone cell for outpatient telephone revisits", async () => {
  assert.equal(whiteboxEncounterSetting({
    setting: "outpatient",
    encounterDetails: {
      visitKind: "telephone_revisit",
      visitKindSource: "user"
    }
  }), "telephone");
  assert.equal(whiteboxEncounterSetting({ setting: "home_visit" }), "home_visit");

  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: { lines: [] },
    session: {
      setting: "outpatient",
      encounterDetails: {
        visitKind: "telephone_revisit",
        visitKindSource: "user"
      }
    },
    env: shadowEnv()
  });

  assert.equal(result.status, "shadow");
  assert.equal(result.metrics.eligible, true);
  assert.equal(result.metrics.encounterSetting, "telephone");
});

test("WX3 truth table excludes non-performed, past, and external context", () => {
  assert.equal(contextRoleFromAxes({
    ...CURRENT_AXES,
    actionStatus: { value: "not_performed", confidence: 0.99, abstained: false }
  }).role, "excluded");
  assert.equal(contextRoleFromAxes({
    ...CURRENT_AXES,
    temporalRelation: { value: "past", confidence: 0.99, abstained: false }
  }).role, "excluded");
  assert.equal(contextRoleFromAxes({
    ...CURRENT_AXES,
    sourceOrigin: { value: "patient_reported", confidence: 0.99, abstained: false }
  }).role, "excluded");
});

test("WX3 abstain and same-day ambiguity are owned by the LLM", () => {
  assert.equal(contextRoleFromAxes({
    ...CURRENT_AXES,
    actionStatus: { value: "performed", confidence: 0.99, abstained: true }
  }).role, "llm");
  assert.equal(contextRoleFromAxes({
    ...CURRENT_AXES,
    temporalRelation: { value: "same_day_but_unknown", confidence: 0.99, abstained: false }
  }).role, "llm");
  assert.equal(aggregateLineContext([
    { role: "performed" },
    { role: "llm" }
  ]).role, "llm");
});

test("WX3 calibrated non-abstained axes are not rejected by a second default threshold", () => {
  const lowConfidenceAxes = Object.fromEntries(Object.entries(CURRENT_AXES)
    .map(([axis, result]) => [axis, {
      ...result,
      confidence: 0.61,
      abstained: false
    }]));
  assert.equal(contextRoleFromAxes(lowConfidenceAxes).role, "performed");
  assert.equal(contextRoleFromAxes(lowConfidenceAxes, 0.9).role, "llm");
});

test("WX3 classifier and deterministic predicate disagreement downgrades safely", () => {
  assert.deepEqual(contextConsensus({
    classifierRole: "performed",
    predicateRole: "excluded"
  }), {
    role: "excluded",
    disagreement: true,
    reasonCodes: ["classifier_predicate_disagreement_safe_downgrade"]
  });
});

test("WX3 deterministic exclusion remains safe when the classifier abstains", () => {
  assert.deepEqual(contextConsensus({
    classifierRole: "llm",
    predicateRole: "excluded"
  }), {
    role: "excluded",
    disagreement: true,
    reasonCodes: ["predicate_safe_exclusion"]
  });
});

test("WX3 treats a current-visit predicate as compatible with a standing span", () => {
  assert.deepEqual(contextConsensus({
    classifierRole: "standing",
    predicateRole: "performed"
  }), {
    role: "standing",
    disagreement: false,
    reasonCodes: ["current_visit_predicate_compatible_with_standing"]
  });
});

test("WX1 routes only high-confidence span, link, and context through encoder", async () => {
  const preprocessing = {
    lines: [{
      lineId: "O-001",
      text: "創傷処置を施行。",
      section: "O",
      cues: { currentVisit: true }
    }]
  };
  const calculator = completeWhiteboxCalculator();
  const result = await prepareWhiteboxExtraction({
    feeCalculator: calculator,
    preprocessing,
    session: { setting: "outpatient", serviceDate: "2026-07-24" },
    env: routeEnv()
  });

  assert.equal(result.status, "route_ready");
  assert.equal(result.lineRoutes[0].route, "encoder");
  assert.equal(result.llmLines.length, 0);
  assert.equal(result.encoderFacts.clinical_events.length, 1);
  assert.equal(result.encoderFacts.clinical_events[0].extractionSource, "encoder");
  assert.equal(result.encoderFacts.clinical_events[0].status, "candidate");
  assert.equal(result.encoderFacts.clinical_events[0].reviewRequired, true);
  assert.equal(result.metrics.shadowEncoderLineCount, 1);
  assert.equal(result.metrics.shadowRoutableLineRatio, 1);
  assert.equal(result.metrics.spanBearingLineCount, 1);
  assert.equal(result.metrics.confidenceSummary.span.count, 1);
  assert.equal(result.metrics.confidenceSummary.linkerTopScore.p50, 0.98);
  assert.equal(
    result.metrics.confidenceSummary.contextAxes.actionStatus.p50,
    0.99
  );
  assert.deepEqual(result.metrics.routeReasonCounts, { performed_span: 1 });
  assert.deepEqual(result.metrics.contextClassifier, {
    calls: 1,
    evaluatedSpans: 1,
    overrides: 0,
    disagreements: 0,
    disagreementAxes: [],
    abstainedSpans: 0,
    uncertainAxisCounts: {},
    modelVersion: "context-v1",
    status: "complete"
  });
});

test("WX3 metrics count abstained spans by uncertain axis", async () => {
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator({
      contextAxesBySpanId: {
        span_1: {
          ...CURRENT_AXES,
          temporalRelation: {
            value: "current_visit",
            confidence: 0.2,
            abstained: true
          },
          providerOwnership: {
            value: "own_clinic",
            confidence: 0.3,
            abstained: true
          }
        }
      }
    }),
    preprocessing: {
      lines: [{
        lineId: "O-001",
        text: "創傷処置を施行。",
        section: "O",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient", serviceDate: "2026-07-24" },
    env: shadowEnv()
  });

  assert.equal(result.metrics.contextClassifier.abstainedSpans, 1);
  assert.deepEqual(result.metrics.contextClassifier.uncertainAxisCounts, {
    providerOwnership: 1,
    temporalRelation: 1
  });
  assert.deepEqual(result.metrics.routeReasonCounts, {
    llm_owns_whole_line: 1
  });
});

test("WX3 mixed performed and standing spans keep only the performed event", async () => {
  const spanResults = [{
    lineId: "O-001",
    relevance: "relevant",
    relevanceConfidence: 0.99,
    spans: [
      span("span_suction", "O-001", "吸引", "procedure", 0, 2),
      span("span_management", "O-001", "管理を継続", "management", 6, 12)
    ]
  }];
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator({
      spanResults,
      linkResults: [
        linkedCandidate("140009410", "喀痰吸引", "procedure"),
        linkedCandidate("113009910", "呼吸心拍監視", "procedure")
      ],
      contextAxesBySpanId: {
        span_suction: CURRENT_AXES,
        span_management: {
          ...CURRENT_AXES,
          actionStatus: { value: "unknown", confidence: 0.99, abstained: false },
          standingStatus: { value: "continued", confidence: 0.99, abstained: false }
        }
      }
    }),
    preprocessing: {
      lines: [{
        lineId: "O-001",
        text: "吸引を実施し、管理を継続した。",
        section: "O",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient", serviceDate: "2026-07-24" },
    env: routeEnv()
  });

  assert.equal(result.status, "route_ready");
  assert.equal(result.lineRoutes[0].lineRole, "performed");
  assert.deepEqual(
    result.encoderFacts.clinical_events.map((event) => event.name),
    ["喀痰吸引"]
  );
  assert.deepEqual(result.encoderFacts.standing_mentions, []);
  assert.deepEqual(result.encoderFacts.line_review, [{
    line_id: "O-001",
    line_role: "performed"
  }]);
});

test("WX1 encoder and LLM routes preserve the complete v15 fact contract", async () => {
  const lines = [
    {
      lineId: "O-001",
      text: "創傷処置を施行。",
      section: "O",
      cues: { currentVisit: true }
    },
    {
      lineId: "P-001",
      text: "今後の治療方針を相談した。",
      section: "P",
      cues: {}
    }
  ];
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: { lines },
    session: { setting: "outpatient", serviceDate: "2026-07-24" },
    env: routeEnv()
  });

  assert.equal(result.status, "route_ready");
  assert.deepEqual(result.llmLines.map((line) => line.lineId), ["P-001"]);
  assert.deepEqual(result.encoderFacts.line_review, [{
    line_id: "O-001",
    line_role: "performed"
  }]);
  assert.equal(result.encoderFacts.clinical_events[0].status, "candidate");
  assert.equal(result.encoderFacts.clinical_events[0].reviewRequired, true);
  assert.deepEqual(
    result.encoderFacts.clinical_events[0].evidence_line_ids,
    ["O-001"]
  );

  const merged = mergeClinicalFactsSamples([
    result.encoderFacts,
    {
      clinical_events: [],
      standing_mentions: [],
      line_review: [{ line_id: "P-001", line_role: "none" }]
    }
  ]);
  const reconciliation = reconcileLineReview(
    merged,
    lines.map((line) => line.lineId)
  );
  assert.deepEqual(reconciliation.missingIds, []);
  assert.deepEqual(reconciliation.unknownIds, []);
  assert.deepEqual(reconciliation.duplicateIds, []);
  assert.deepEqual(reconciliation.normalizedLineReview, [
    { line_id: "O-001", line_role: "performed" },
    { line_id: "P-001", line_role: "none" }
  ]);
  const validLineIds = new Set(lines.map((line) => line.lineId));
  for (const event of merged.clinical_events) {
    assert.ok(event.evidence_line_ids.length > 0);
    assert.ok(event.evidence_line_ids.every((lineId) => validLineIds.has(lineId)));
  }
});

test("WX3 keeps past span axes while routing a current span on the same line", async () => {
  const spanResults = [{
    lineId: "O-001",
    relevance: "relevant",
    relevanceConfidence: 0.99,
    spans: [
      span("span_ct", "O-001", "前回CT", "imaging", 0, 4),
      span("span_blood", "O-001", "採血", "lab", 12, 14)
    ]
  }];
  const pastAxes = {
    ...CURRENT_AXES,
    temporalRelation: { value: "past", confidence: 0.99, abstained: false }
  };
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator({
      spanResults,
      linkResults: [
        linkedCandidate("170020010", "CT撮影", "procedure"),
        linkedCandidate("160022510", "血液採取（静脈）", "procedure")
      ],
      contextAxesBySpanId: {
        span_ct: pastAxes,
        span_blood: CURRENT_AXES
      }
    }),
    preprocessing: {
      lines: [{
        lineId: "O-001",
        text: "前回CTを確認し、本日は採血を実施。",
        section: "O",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient", serviceDate: "2026-07-24" },
    env: routeEnv()
  });

  assert.equal(result.lineRoutes[0].lineRole, "performed");
  assert.deepEqual(
    result.encoderFacts.clinical_events.map((event) => event.name),
    ["血液採取（静脈）"]
  );
  assert.equal(result.encoderFacts.excluded_events.length, 1);
  assert.equal(result.encoderFacts.excluded_events[0].name, "CT撮影");
  assert.equal(result.encoderFacts.excluded_events[0].status, "history");
  assert.equal(
    result.encoderFacts.excluded_events[0]._whiteboxAxes.temporalRelation.value,
    "past"
  );
});

test("WX1 sends a non-trivial spanless line and the whole mixed line to LLM", async () => {
  const calculator = completeWhiteboxCalculator({
    spanResults: [{
      lineId: "P-001",
      relevance: "abstain",
      relevanceConfidence: 0.2,
      spans: []
    }]
  });
  const result = await prepareWhiteboxExtraction({
    feeCalculator: calculator,
    preprocessing: {
      lines: [{
        lineId: "P-001",
        text: "症状を確認し今後の治療方針を相談した。",
        section: "P",
        cues: {}
      }]
    },
    session: { setting: "outpatient" },
    env: routeEnv()
  });

  assert.equal(result.lineRoutes[0].route, "llm");
  assert.deepEqual(result.lineRoutes[0].reasonCodes, ["span_missing_nontrivial_line"]);
});

test("WX1 never activates for inpatient encounters", async () => {
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: { lines: [] },
    session: { setting: "inpatient" },
    env: routeEnv()
  });
  assert.equal(result.status, "ineligible");
});

test("WX1 falls back all lines to LLM when a whitebox worker is unavailable", async () => {
  const calculator = completeWhiteboxCalculator();
  calculator.detectSpans = async () => {
    throw new Error("worker unavailable");
  };
  const lines = [{
    lineId: "O-001",
    text: "創傷処置を施行。",
    section: "O",
    cues: { currentVisit: true }
  }];
  const result = await prepareWhiteboxExtraction({
    feeCalculator: calculator,
    preprocessing: { lines },
    session: { setting: "outpatient" },
    env: routeEnv()
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.degraded, true);
  assert.deepEqual(result.llmLines, lines);
  assert.deepEqual(result.encoderFacts.clinical_events, []);
});

test("three-lane shadow is healthy when every artifact returns a complete envelope", async () => {
  const lines = [{
    lineId: "O-001",
    text: "創傷処置を施行。",
    section: "O",
    cues: { currentVisit: true }
  }];
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: { lines },
    session: { setting: "outpatient" },
    env: shadowEnv()
  });

  assert.equal(result.status, "shadow");
  assert.equal(result.degraded, false);
  assert.equal(result.metrics.degraded, false);
  assert.deepEqual(result.metrics.degradedReasons, []);
  assert.equal(result.metrics.shadowEncoderLineCount, 1);
  assert.equal(result.metrics.spanBearingLineCount, 1);
  assert.equal(result.metrics.shadowEncoderSpanBearingLineCount, 1);
  assert.equal(result.metrics.spanBearingRoutableLineRatio, 1);
  assert.equal(result.metrics.encoderLineCount, 0);
  assert.deepEqual(result.llmLines, lines);
});

test("three-lane shadow reports an unavailable linker as degraded", async () => {
  const calculator = completeWhiteboxCalculator();
  calculator.linkSpans = async () => ({
    status: "index_unavailable",
    results: [],
    reason: "index missing"
  });
  const result = await prepareWhiteboxExtraction({
    feeCalculator: calculator,
    preprocessing: {
      lines: [{
        lineId: "O-001",
        text: "創傷処置を施行。",
        section: "O",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient" },
    env: shadowEnv()
  });

  assert.equal(result.status, "shadow");
  assert.equal(result.degraded, true);
  assert.deepEqual(result.metrics.degradedReasons, ["linker_unavailable"]);
});

test("three-lane shadow with no detected spans is not a model failure", async () => {
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator({
      spanResults: [{
        lineId: "S-001",
        relevance: "irrelevant",
        relevanceConfidence: 0.99,
        spans: []
      }]
    }),
    preprocessing: {
      lines: [{
        lineId: "S-001",
        text: "症状は安定。",
        section: "S",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient" },
    env: shadowEnv()
  });

  assert.equal(result.degraded, false);
  assert.deepEqual(result.metrics.degradedReasons, []);
});

test("three-lane extractor identity is stable for lines with and without spans", async () => {
  const env = shadowEnv();
  const withSpan = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: {
      lines: [{
        lineId: "O-001",
        text: "創傷処置を施行。",
        section: "O",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient" },
    env
  });
  const withoutSpan = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator({
      spanResults: [{
        lineId: "S-001",
        relevance: "irrelevant",
        relevanceConfidence: 0.99,
        spans: []
      }]
    }),
    preprocessing: {
      lines: [{
        lineId: "S-001",
        text: "症状は安定。",
        section: "S",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient" },
    env
  });

  assert.equal(withSpan.extractorVersion, withoutSpan.extractorVersion);
  assert.equal(withSpan.metrics.extractorVersion, withoutSpan.metrics.extractorVersion);
  assert.equal(withSpan.metrics.spanDetectorArtifactVersion, "span-artifact-v1");
  assert.equal(withSpan.metrics.linkerArtifactVersion, "link-artifact-v1");
  assert.equal(withSpan.metrics.contextClassifierArtifactVersion, "context-artifact-v1");
});

test("WX1 invalid threshold configuration cannot activate encoder routing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fee-whitebox-thresholds-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const thresholdPath = join(directory, "routing-thresholds.json");
  writeFileSync(thresholdPath, JSON.stringify({
    schemaVersion: 1,
    cells: {
      "皮膚科|outpatient": { spanConfidence: 2 }
    }
  }));
  const lines = [{
    lineId: "O-001",
    text: "創傷処置を施行。",
    section: "O",
    cues: { currentVisit: true }
  }];
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: { lines },
    session: {
      setting: "outpatient",
      departmentSnapshot: { specialty: "皮膚科" }
    },
    env: {
      ...routeEnv(),
      FEE_WHITEBOX_THRESHOLDS_PATH: thresholdPath
    }
  });

  assert.equal(result.status, "shadow");
  assert.equal(result.degraded, true);
  assert.deepEqual(result.llmLines, lines);
  assert.equal(result.metrics.degradedReasons.includes("threshold_config_invalid"), true);
  assert.deepEqual(result.metrics.thresholdCells, ["invalid_config_fallback"]);
});

test("WX3 metrics count classifier-only overrides and predicate disagreements", async () => {
  const spanResults = [
    {
      lineId: "O-001",
      relevance: "relevant",
      relevanceConfidence: 0.99,
      spans: [span("span_override", "O-001", "採血", "lab", 0, 2)]
    },
    {
      lineId: "O-002",
      relevance: "relevant",
      relevanceConfidence: 0.99,
      spans: [span("span_disagree", "O-002", "CT", "imaging", 3, 5)]
    }
  ];
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator({
      spanResults,
      linkResults: [
        linkedCandidate("160022510", "血液採取（静脈）", "procedure"),
        linkedCandidate("170020010", "CT撮影", "procedure")
      ]
    }),
    preprocessing: {
      lines: [
        {
          lineId: "O-001",
          text: "採血を実施。",
          section: "O",
          cues: {}
        },
        {
          lineId: "O-002",
          text: "前回のCTを確認。",
          section: "O",
          cues: { pastOrExternal: true }
        }
      ]
    },
    session: { setting: "outpatient" },
    env: routeEnv()
  });

  assert.equal(result.metrics.contextClassifier.calls, 1);
  assert.equal(result.metrics.contextClassifier.evaluatedSpans, 2);
  assert.equal(result.metrics.contextClassifier.overrides, 1);
  assert.equal(result.metrics.contextClassifier.disagreements, 1);
  assert.deepEqual(result.metrics.contextClassifier.disagreementAxes, [
    "source_origin",
    "temporal_relation"
  ]);
});

test("WX1 encoder routing is deterministic across 100 runs", async () => {
  const input = {
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: {
      lines: [{
        lineId: "O-001",
        text: "創傷処置を施行。",
        section: "O",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient", serviceDate: "2026-07-24" },
    env: routeEnv()
  };
  const first = stableWhiteboxResult(await prepareWhiteboxExtraction(input));
  for (let index = 1; index < 100; index += 1) {
    assert.deepEqual(
      stableWhiteboxResult(await prepareWhiteboxExtraction(input)),
      first
    );
  }
});

test("WX1 derives explicit current-visit prescription facts without an LLM", async () => {
  const result = await prepareWhiteboxExtraction({
    feeCalculator: completeWhiteboxCalculator(),
    preprocessing: {
      lines: [{
        lineId: "P-001",
        text: "院外処方箋を発行した。",
        section: "P",
        cues: { currentVisit: true }
      }]
    },
    session: { setting: "outpatient" },
    env: routeEnv()
  });
  assert.equal(result.status, "route_ready");
  assert.equal(result.llmLines.length, 1);
  assert.deepEqual(result.lineRoutes[0].reasonCodes, ["span_missing_nontrivial_line"]);
  assert.equal(result.encoderFacts.visit_facts.outside_prescription_issued, "yes");
  assert.equal(result.metrics.visitFacts.source, "deterministic_text");
  assert.equal(result.metrics.degradedReasons.includes("visit_facts_sensitive_change"), false);
});

test("WX1 sends ambiguous, conflicting, and past prescription facts to the full LLM", () => {
  const ambiguous = determineWhiteboxVisitFacts({
    lines: [{
      lineId: "P-001",
      text: "処方箋について患者と相談した。",
      cues: { currentVisit: true }
    }]
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.ambiguousLineIds, ["P-001"]);

  const conflicting = determineWhiteboxVisitFacts({
    lines: [{
      lineId: "P-002",
      text: "院外処方箋を発行したが、院内処方へ変更した。",
      cues: { currentVisit: true }
    }]
  });
  assert.equal(conflicting.status, "ambiguous");

  const past = determineWhiteboxVisitFacts({
    lines: [{
      lineId: "S-001",
      text: "前回は院外処方箋を発行した。",
      cues: { pastOrExternal: true }
    }]
  });
  assert.equal(past.status, "ambiguous");
});

test("WX1 uses structured prescription facts and detects text conflicts", () => {
  const structured = determineWhiteboxVisitFacts({
    lines: [],
    session: {
      calculationOptions: {
        medication: {
          delivery_kind: "in_house",
          generic_name_prescription_add_on: false
        }
      }
    }
  });
  assert.equal(structured.status, "complete");
  assert.equal(structured.source, "structured_session");
  assert.deepEqual(structured.facts, {
    outside_prescription_issued: "no",
    generic_name_prescription: "no",
    prescription_evidence: ""
  });

  const conflict = determineWhiteboxVisitFacts({
    lines: [{
      lineId: "P-001",
      text: "院外処方箋を発行した。",
      cues: { currentVisit: true }
    }],
    session: {
      calculationOptions: {
        medication: { delivery_kind: "in_house" }
      }
    }
  });
  assert.equal(conflict.status, "ambiguous");
});

test("WX2 uses score and margin for proposal versus code-set review", async () => {
  const calculator = {
    async linkSpans() {
      return {
        status: "complete",
        indexVersion: "link-v1",
        results: [
          {
            margin: 0.08,
            candidates: [{
              code: "140000610",
              name: "創傷処置",
              kind: "procedure",
              score: 0.96,
              categoryMatched: true,
              points: 52
            }]
          },
          {
            margin: 0.01,
            candidates: [
              {
                code: "113001810",
                name: "特定疾患療養管理料",
                kind: "procedure",
                score: 0.94,
                categoryMatched: true,
                points: 225
              },
              {
                code: "113001910",
                name: "特定疾患療養管理料",
                kind: "procedure",
                score: 0.93,
                categoryMatched: true,
                points: 147
              }
            ]
          }
        ]
      };
    }
  };
  const result = await buildLinkerCandidateLayer({
    feeCalculator: calculator,
    events: [
      { clinicalEventId: "event_1", name: "創部を処置", type: "procedure" },
      { clinicalEventId: "event_2", name: "特疾管理", type: "management" }
    ],
    env: { FEE_LINKER_MODE: "propose" }
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].candidateLine.reviewRequired, true);
  assert.equal(result.proposals[0].candidateLine.extractionSource, "encoder");
  assert.equal(result.reviewIssues.length, 1);
  assert.deepEqual(result.reviewIssues[0].codeCandidates, ["113001810", "113001910"]);
});

function routeEnv() {
  return {
    FEE_LINKER_MODE: "propose",
    FEE_CONTEXT_CLASSIFIER_MODE: "assist",
    FEE_SPAN_DETECTOR_MODE: "route"
  };
}

function shadowEnv() {
  return {
    FEE_LINKER_MODE: "shadow",
    FEE_CONTEXT_CLASSIFIER_MODE: "shadow",
    FEE_SPAN_DETECTOR_MODE: "shadow",
    FEE_LINKER_MANIFEST_PATH: "/app/python/data/whitebox/linker-v1/manifest.json",
    FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH: "/app/python/data/whitebox/context-v1/manifest.json",
    FEE_SPAN_DETECTOR_MANIFEST_PATH: "/app/python/data/whitebox/span-v1/manifest.json"
  };
}

function completeWhiteboxCalculator(options = {}) {
  const spanResults = options.spanResults || [{
    lineId: "O-001",
    relevance: "relevant",
    relevanceConfidence: 0.99,
    spans: [{
      spanId: "span_1",
      lineId: "O-001",
      charStart: 0,
      charEnd: 4,
      text: "創傷処置",
      category: "procedure",
      confidence: 0.99
    }]
  }];
  return {
    async detectSpans() {
      return {
        status: "complete",
        extractorVersion: "span-v1",
        artifactVersion: "span-artifact-v1",
        results: spanResults
      };
    },
    async linkSpans() {
      return {
        status: "complete",
        indexVersion: "link-v1",
        artifactVersion: "link-artifact-v1",
        results: options.linkResults || spanResults.flatMap((row) => row.spans).map(() => (
          linkedCandidate("140000610", "創傷処置（１００ｃｍ２未満）", "procedure")
        ))
      };
    },
    async classifyContext({ items }) {
      return {
        status: "complete",
        modelVersion: "context-v1",
        artifactVersion: "context-artifact-v1",
        results: items.map((item) => ({
          lineId: item.lineId,
          spanId: item.spanId,
          text: item.text,
          axes: options.contextAxesBySpanId?.[item.spanId] || CURRENT_AXES
        }))
      };
    }
  };
}

function span(spanId, lineId, text, category, charStart, charEnd) {
  return {
    spanId,
    lineId,
    charStart,
    charEnd,
    text,
    category,
    confidence: 0.99
  };
}

function linkedCandidate(code, name, kind) {
  return {
    text: name,
    margin: 0.1,
    candidates: [{
      code,
      name,
      kind,
      score: 0.98,
      categoryMatched: true,
      points: 52
    }]
  };
}

function stableWhiteboxResult(result) {
  return {
    status: result.status,
    degraded: result.degraded,
    extractorVersion: result.extractorVersion,
    lineRoutes: result.lineRoutes,
    llmLines: result.llmLines,
    encoderFacts: result.encoderFacts,
    encoderShadowFacts: result.encoderShadowFacts
  };
}
