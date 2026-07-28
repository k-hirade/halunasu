import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  assessWhiteboxEvaluationEligibility,
  buildWhiteboxShadowExecutions,
  buildWhiteboxShadowSessionInput,
  requiredWhiteboxCells,
  resolveWhiteboxDepartments,
  selectWhiteboxDiagnosticSample,
  selectWhiteboxShadowCases,
  selectWhiteboxPromotionCases,
  summarizeWhiteboxCaseAudits,
  summarizeWhiteboxDeterminism,
  summarizeWhiteboxRouting,
  whiteboxDepartmentInput,
  whiteboxDeterminismFingerprint,
  whiteboxDeterminismSnapshot,
  whiteboxShadowCaseAudit
} from "./fee-whitebox-shadow-matrix.mjs";

const policy = {
  requiredSpecialties: ["internal_medicine", "pediatrics"],
  requiredEncounterSettings: ["outpatient", "telephone"],
  telemetry: { minimumRunsPerCell: 1 }
};

test("shadow matrix selection excludes holdout and requires every policy cell", () => {
  const cases = [];
  for (const specialty of policy.requiredSpecialties) {
    for (const encounterSetting of policy.requiredEncounterSettings) {
      cases.push({
        caseId: `${specialty}-${encounterSetting}-dev`,
        specialty,
        encounterSetting,
        split: "development",
        synthetic: true,
        annotationStatus: "reviewed",
        clinicalText: "S）確認。\nO）採血を実施。"
      });
      cases.push({
        caseId: `${specialty}-${encounterSetting}-holdout`,
        specialty,
        encounterSetting,
        split: "holdout",
        synthetic: true,
        annotationStatus: "reviewed",
        clinicalText: "holdout"
      });
    }
  }
  const selected = selectWhiteboxShadowCases({
    schemaVersion: "fee-specialty-matrix-cases-v1",
    cases
  }, policy);

  assert.equal(requiredWhiteboxCells(policy).length, 4);
  assert.equal(selected.length, 4);
  assert.equal(selected.some((item) => item.split === "holdout"), false);
});

test("diagnostic sample balances specialties and encounter settings", () => {
  const samplePolicy = {
    requiredSpecialties: [
      "internal_medicine",
      "pediatrics",
      "dermatology",
      "orthopedics",
      "psychiatry",
      "ophthalmology",
      "otolaryngology",
      "surgery",
    ],
    requiredEncounterSettings: [
      "outpatient",
      "home_visit",
      "house_call",
      "telephone",
    ],
  };
  const selected = requiredWhiteboxCells(samplePolicy).map((cell) => ({
    caseId: `${cell.specialty}-${cell.encounterSetting}`,
    specialty: cell.specialty,
    encounterSetting: cell.encounterSetting,
    measurementCell: cell.cell,
  }));

  const sampled = selectWhiteboxDiagnosticSample(selected, samplePolicy, {
    cellLimit: 8,
  });

  assert.equal(sampled.length, 8);
  assert.equal(new Set(sampled.map((item) => item.specialty)).size, 8);
  assert.deepEqual(
    Object.fromEntries(
      samplePolicy.requiredEncounterSettings.map((setting) => [
        setting,
        sampled.filter((item) => item.encounterSetting === setting).length,
      ])
    ),
    {
      outpatient: 2,
      home_visit: 2,
      house_call: 2,
      telephone: 2,
    }
  );
  assert.throws(
    () => selectWhiteboxDiagnosticSample(selected, samplePolicy, {
      cellLimit: 33,
    }),
    /at most 32/u
  );
});

test("shadow session represents telephone as outpatient plus telephone visit kind", () => {
  const input = buildWhiteboxShadowSessionInput({
    caseId: "telephone-1",
    specialty: "internal_medicine",
    encounterSetting: "telephone",
    clinicalText: "S）本人より電話。"
  }, {
    facilityId: "fac_1",
    departmentId: "dep_1",
    runId: "run_1",
    serviceDate: "2026-07-25"
  });

  assert.equal(input.setting, "outpatient");
  assert.deepEqual(input.encounterDetails, {
    visitKind: "telephone_revisit",
    visitKindSource: "user"
  });
  assert.equal(input.sourceSystem, "fee_whitebox_shadow_stg:run_1");
});

test("shadow execution plan repeats one identical control per policy cell", () => {
  const selected = [
    { caseId: "a-1", specialty: "internal_medicine", encounterSetting: "outpatient" },
    { caseId: "a-2", specialty: "internal_medicine", encounterSetting: "outpatient" },
    { caseId: "b-1", specialty: "surgery", encounterSetting: "home_visit" }
  ].map((item) => ({
    ...item,
    measurementCell: `${item.specialty}|${item.encounterSetting}`
  }));
  const plan = buildWhiteboxShadowExecutions(selected, { controlRepeats: 3 });
  assert.equal(plan.controlGroupCount, 2);
  assert.equal(plan.expectedCalculationCount, 7);
  assert.deepEqual(
    plan.executions.map((item) => [
      item.caseId,
      item.runKind,
      item.controlAttempt || null
    ]),
    [
      ["a-1", "measurement", 1],
      ["a-1", "determinism_control", 2],
      ["a-1", "determinism_control", 3],
      ["a-2", "measurement", null],
      ["b-1", "measurement", 1],
      ["b-1", "determinism_control", 2],
      ["b-1", "determinism_control", 3]
    ]
  );
});

test("promotion selection requires holdout line and span coverage per cell", () => {
  const promotionPolicy = {
    requiredSpecialties: ["internal_medicine"],
    requiredEncounterSettings: ["outpatient"],
    telemetry: { minimumRunsPerCell: 2 },
    adjudication: {
      minimumReviewedLinesPerCell: 4,
      minimumReviewedSpansPerCell: 3
    }
  };
  const holdoutCase = (caseId, spanCount) => ({
    caseId,
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    split: "holdout",
    synthetic: true,
    annotationStatus: "reviewed",
    holdoutProvenance: {
      source: "human_reviewed"
    },
    reviewPolicy: {
      expectedSpansReviewed: true,
      reviewedBy: "reviewer-1",
      reviewedAt: "2026-07-26"
    },
    clinicalText: "S）確認。\nO）検査を実施。",
    expectedSpans: Array.from({ length: spanCount }, (_, index) => ({
      code: `code-${caseId}-${index}`
    }))
  });
  const dataset = {
    schemaVersion: "fee-specialty-matrix-cases-v1",
    cases: [holdoutCase("h-1", 1), holdoutCase("h-2", 2)]
  };
  assert.equal(selectWhiteboxPromotionCases(dataset, promotionPolicy).length, 2);
  assert.throws(
    () => selectWhiteboxPromotionCases({
      ...dataset,
      cases: dataset.cases.slice(0, 1)
    }, promotionPolicy),
    /holdout coverage is insufficient/u
  );
  assert.throws(
    () => selectWhiteboxPromotionCases({
      ...dataset,
      cases: dataset.cases.map((item) => ({
        ...item,
        holdoutProvenance: { source: "separate_generator" }
      }))
    }, promotionPolicy),
    /holdout coverage is insufficient/u
  );
});

test("department resolver never rewrites an unrelated department", () => {
  const resolved = resolveWhiteboxDepartments([
    {
      departmentId: "dep_general",
      facilityId: "fac_1",
      specialty: "",
      status: "active"
    },
    {
      departmentId: "dep_internal",
      facilityId: "fac_1",
      specialty: "internal_medicine",
      code: "WX01",
      status: "active"
    }
  ], {
    facilityId: "fac_1",
    specialties: ["internal_medicine", "pediatrics"]
  });

  assert.deepEqual(resolved.bySpecialty, { internal_medicine: "dep_internal" });
  assert.deepEqual(resolved.missing, ["pediatrics"]);
  assert.equal(whiteboxDepartmentInput("pediatrics", "fac_1").specialty, "pediatrics");
});

test("machine precheck compares encoder codes without claiming human adjudication", () => {
  const audit = whiteboxShadowCaseAudit({
    caseId: "case-1",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    clinicalText: "S）安定。\nO）採血を実施。",
    expectedSpans: [
      {
        text: "採血",
        charStart: 8,
        charEnd: 10,
        category: "lab",
        code: "160022510",
        actionStatus: "performed",
        temporalRelation: "current_visit",
        sourceOrigin: "own_clinic_record",
        providerOwnership: "own_clinic"
      },
      {
        code: "170020010",
        actionStatus: "performed",
        temporalRelation: "past",
        sourceOrigin: "own_clinic_record",
        providerOwnership: "own_clinic"
      }
    ]
  }, {
    feeSession: {
      calculationResult: {
        clinicalExtraction: {
          trace: [
            {
              stage: "whitebox_router",
              gateDiagnostics: [{
                lineId: "O-001",
                lineIndex: 2,
                spanId: "span-blood",
                spanTextSha256: crypto.createHash("sha256").update("採血").digest("hex"),
                charStart: 2,
                charEnd: 4,
                category: "lab",
                strict: {
                  jointEligible: true,
                  blockerReasonCodes: []
                },
                shadow: {
                  jointEligible: true,
                  blockerReasonCodes: []
                },
                semanticCandidates: [{ code: "160022510", rank: 1 }],
                shadowCandidates: [{ code: "160022510", rank: 1 }]
              }]
            },
            {
              stage: "whitebox_shadow_comparison",
              matchedCodes: ["160022510"],
              encoderOnlyCodes: ["999999999"],
              llmOnlyCodes: []
            }
          ]
        }
      }
    }
  });

  assert.deepEqual(audit.expectedCurrentOwnCodes, ["160022510"]);
  assert.deepEqual(audit.encoderTruePositiveCodes, ["160022510"]);
  assert.deepEqual(audit.encoderFalsePositiveCodes, ["999999999"]);
  assert.deepEqual(audit.encoderFalseNegativeCodes, []);
  assert.equal(audit.reviewStatus, "machine_precheck_only");
  const summary = summarizeWhiteboxCaseAudits(
    [audit]
  )["internal_medicine|outpatient"];
  assert.deepEqual(
    {
      runCount: summary.runCount,
      reviewedLineCount: summary.reviewedLineCount,
      reviewedSpanCount: summary.reviewedSpanCount,
      encoderTruePositiveCodeCount: summary.encoderTruePositiveCodeCount,
      encoderFalsePositiveCodeCount: summary.encoderFalsePositiveCodeCount,
      encoderFalseNegativeCodeCount: summary.encoderFalseNegativeCodeCount,
      expectedSpanCount: summary.expectedSpanCount,
      exactBoundaryMatchCount: summary.exactBoundaryMatchCount,
      overlapMatchCount: summary.overlapMatchCount,
      expectedCurrentOwnSpanCount: summary.expectedCurrentOwnSpanCount,
      detectedCurrentOwnSpanCount: summary.detectedCurrentOwnSpanCount,
      expectedSemanticTop1Count: summary.expectedSemanticTop1Count,
      strictJointEligibleCount: summary.strictJointEligibleCount,
      shadowJointEligibleCount: summary.shadowJointEligibleCount,
      expectedSafeExclusionSpanCount: summary.expectedSafeExclusionSpanCount
    },
    {
      runCount: 1,
      reviewedLineCount: 2,
      reviewedSpanCount: 2,
      encoderTruePositiveCodeCount: 1,
      encoderFalsePositiveCodeCount: 1,
      encoderFalseNegativeCodeCount: 0,
      expectedSpanCount: 2,
      exactBoundaryMatchCount: 1,
      overlapMatchCount: 1,
      expectedCurrentOwnSpanCount: 1,
      detectedCurrentOwnSpanCount: 1,
      expectedSemanticTop1Count: 1,
      strictJointEligibleCount: 1,
      shadowJointEligibleCount: 1,
      expectedSafeExclusionSpanCount: 1
    }
  );
  assert.deepEqual(summary.strictBlockerCounts, {});
  assert.deepEqual(summary.shadowBlockerCounts, {});
  assert.deepEqual(summary.allStrictBlockerCounts, { span_not_detected: 1 });
  assert.deepEqual(summary.safeExclusionStrictBlockerCounts, {
    span_not_detected: 1
  });
  assert.deepEqual(summary.retrievalClassificationCounts, {
    exact_code_top1: 1
  });
  assert.equal(summary.strictExpectedFamilyIdentifiedCount, 0);
  assert.equal(summary.calibration.coveredCount, 0);
  assert.equal(summary.calibration.thresholdUpdateEligible, false);
});

test("machine precheck distinguishes an underspecified family from an exact code", () => {
  const text = "P）アムロジピンOD錠2.5mgを処方。";
  const spanText = "アムロジピンOD錠2.5mg";
  const charStart = text.indexOf(spanText);
  const audit = whiteboxShadowCaseAudit({
    caseId: "family-only",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    clinicalText: text,
    expectedSpans: [{
      text: spanText,
      charStart,
      charEnd: charStart + spanText.length,
      category: "medication",
      code: "621931301",
      actionStatus: "performed",
      temporalRelation: "current_visit",
      sourceOrigin: "own_clinic_record",
      providerOwnership: "own_clinic"
    }]
  }, {
    feeSession: {
      calculationResult: {
        clinicalExtraction: {
          trace: [{
            stage: "whitebox_router",
            gateDiagnostics: [{
              lineId: "P-001",
              lineIndex: 1,
              spanId: "span-drug",
              spanTextSha256: crypto
                .createHash("sha256")
                .update(spanText)
                .digest("hex"),
              charStart: 2,
              charEnd: 2 + spanText.length,
              category: "medication",
              confidence: 0.98,
              strict: {
                jointEligible: false,
                familyIdentified: true,
                resolution: "family_only",
                linkerMargin: 0.001,
                linkerFamilyMargin: 0.2,
                linkerFamilyMembers: [
                  { code: "620007817" },
                  { code: "621931301" }
                ],
                blockerReasonCodes: []
              },
              shadow: {
                jointEligible: false,
                familyIdentified: true,
                resolution: "family_only",
                linkerMargin: 0.001,
                linkerFamilyMargin: 0.2,
                linkerFamilyMembers: [
                  { code: "620007817" },
                  { code: "621931301" }
                ],
                blockerReasonCodes: []
              },
              semanticCandidates: [{
                code: "620007817",
                rank: 1,
                score: 0.98
              }],
              shadowCandidates: [{
                code: "620007817",
                rank: 1,
                score: 0.98
              }]
            }]
          }]
        }
      }
    }
  });
  const summary = summarizeWhiteboxCaseAudits(
    [audit]
  )["internal_medicine|outpatient"];

  assert.equal(summary.expectedCurrentOwnSpanCount, 1);
  assert.equal(summary.expectedSemanticTop1Count, 0);
  assert.equal(summary.strictExpectedFamilyIdentifiedCount, 1);
  assert.equal(summary.shadowExpectedFamilyIdentifiedCount, 1);
  assert.equal(summary.strictJointEligibleCount, 0);
  assert.deepEqual(summary.retrievalClassificationCounts, {
    underspecified_family: 1
  });
  assert.equal(summary.calibration.coveredCount, 1);
  assert.equal(summary.calibration.sampleCountEligible, false);
  assert.equal(summary.calibration.thresholdUpdateEligible, false);
  assert.deepEqual(summary.calibration.reasonCodes, [
    "insufficient_cell_samples",
    "independent_human_adjudication_required"
  ]);

  const sampleReady = summarizeWhiteboxCaseAudits(
    Array.from({ length: 20 }, () => audit)
  )["internal_medicine|outpatient"];
  assert.equal(sampleReady.calibration.coveredCount, 20);
  assert.equal(sampleReady.calibration.sampleCountEligible, true);
  assert.equal(sampleReady.calibration.independentHumanAdjudicationVerified, false);
  assert.equal(sampleReady.calibration.thresholdUpdateEligible, false);
  assert.deepEqual(sampleReady.calibration.reasonCodes, [
    "independent_human_adjudication_required"
  ]);
});

test("machine precheck accounts for structured prescription facts outside linker metrics", () => {
  const text = "P）院外処方箋を発行。";
  const spanText = "処方箋";
  const charStart = text.indexOf(spanText);
  const audit = whiteboxShadowCaseAudit({
    caseId: "structured-prescription",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    clinicalText: text,
    expectedSpans: [{
      text: spanText,
      charStart,
      charEnd: charStart + spanText.length,
      category: "medication",
      code: "120002910",
      actionStatus: "performed",
      temporalRelation: "current_visit",
      sourceOrigin: "own_clinic_record",
      providerOwnership: "own_clinic"
    }]
  }, {
    feeSession: {
      calculationResult: {
        clinicalExtraction: {
          trace: [{
            stage: "whitebox_router",
            gateDiagnostics: [{
              lineId: "P-001",
              lineIndex: 1,
              spanId: "span-prescription",
              spanTextSha256: crypto.createHash("sha256").update(spanText).digest("hex"),
              charStart,
              charEnd: charStart + spanText.length,
              category: "medication",
              confidence: 0.9,
              resolutionSource: "structured_visit_fact",
              strict: {
                jointEligible: false,
                structuredFactEligible: true,
                resolution: "structured_visit_fact",
                blockerReasonCodes: []
              },
              shadow: {
                jointEligible: false,
                structuredFactEligible: true,
                resolution: "structured_visit_fact",
                blockerReasonCodes: []
              },
              semanticCandidates: [],
              shadowCandidates: []
            }]
          }]
        }
      }
    }
  });
  const summary = summarizeWhiteboxCaseAudits(
    [audit]
  )["internal_medicine|outpatient"];

  assert.deepEqual(audit.expectedCurrentOwnCodes, ["120002910"]);
  assert.deepEqual(audit.expectedEncoderCodes, []);
  assert.deepEqual(audit.structuredVisitFactExpectedCodes, ["120002910"]);
  assert.deepEqual(audit.encoderFalseNegativeCodes, []);
  assert.equal(summary.structuredVisitFactExpectedCodeCount, 1);
  assert.equal(summary.expectedCurrentOwnSpanCount, 1);
  assert.equal(summary.expectedLinkerSpanCount, 0);
  assert.equal(summary.structuredVisitFactResolvedCount, 1);
  assert.equal(summary.strictStructuredVisitFactEligibleCount, 1);
  assert.equal(summary.shadowStructuredVisitFactEligibleCount, 1);
  assert.equal(summary.expectedBillableInclusionSpanCount, 1);
  assert.equal(summary.expectedDirectBillableInclusionSpanCount, 0);
  assert.deepEqual(summary.retrievalClassificationCounts, {
    structured_visit_fact: 1
  });
  assert.deepEqual(summary.strictBlockerCounts, {});
  assert.deepEqual(summary.shadowBlockerCounts, {});
});

test("span audit uses the same CRLF, trim, and fullwidth normalization as runtime", () => {
  const clinicalText = " \r\nＯ）ＣＴ撮影を実施。 \r\n";
  const rawStart = clinicalText.indexOf("ＣＴ");
  const audit = whiteboxShadowCaseAudit({
    caseId: "normalized-offsets",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    clinicalText,
    expectedSpans: [{
      text: "ＣＴ",
      charStart: rawStart,
      charEnd: rawStart + 2,
      category: "imaging",
      code: "170000000",
      actionStatus: "performed",
      temporalRelation: "current_visit",
      sourceOrigin: "own_clinic_record",
      providerOwnership: "own_clinic"
    }]
  }, detailWithGateDiagnostic({
    lineIndex: 1,
    charStart: 2,
    charEnd: 4,
    category: "imaging",
    spanText: "CT",
    code: "170000000",
    strict: {
      jointEligible: true,
      billableInclusionEligible: true,
      blockerReasonCodes: []
    },
    shadow: {
      jointEligible: true,
      billableInclusionEligible: true,
      blockerReasonCodes: []
    }
  }));

  const [diagnostic] = audit.expectedSpanDiagnostics;
  assert.equal(diagnostic.runtimeSpanObserved, true);
  assert.equal(diagnostic.matchType, "exact");
  assert.equal(diagnostic.exactBoundaryMatch, true);
  assert.equal(diagnostic.canonicalText, "CT");
  assert.equal(diagnostic.expectedLineIndex, 1);
  assert.equal(diagnostic.expectedCharStart, 2);
  assert.equal(diagnostic.expectedCharEnd, 4);
});

test("span audit separates an overlapping boundary from a missing span", () => {
  const clinicalText = "O）採血を実施。";
  const rawStart = clinicalText.indexOf("採血");
  const audit = whiteboxShadowCaseAudit({
    caseId: "overlap-boundary",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    clinicalText,
    expectedSpans: [{
      text: "採血",
      charStart: rawStart,
      charEnd: rawStart + 2,
      category: "lab",
      code: "160022510",
      actionStatus: "performed",
      temporalRelation: "current_visit",
      sourceOrigin: "own_clinic_record",
      providerOwnership: "own_clinic"
    }]
  }, detailWithGateDiagnostic({
    lineIndex: 1,
    charStart: 2,
    charEnd: 5,
    category: "lab",
    spanText: "採血を",
    code: "160022510"
  }));

  const [diagnostic] = audit.expectedSpanDiagnostics;
  assert.equal(diagnostic.runtimeSpanObserved, true);
  assert.equal(diagnostic.matchType, "overlap");
  assert.equal(diagnostic.exactBoundaryMatch, false);
  assert.equal(diagnostic.overlapMatch, true);
  assert.equal(diagnostic.intervalIou, 2 / 3);
  const summary = summarizeWhiteboxCaseAudits([audit])[
    "internal_medicine|outpatient"
  ];
  assert.equal(summary.boundaryMismatchCount, 1);
});

test("span audit does not match the same wording from a different line", () => {
  const clinicalText = "S）前回は採血を実施。\nO）本日も採血を実施。";
  const rawStart = clinicalText.lastIndexOf("採血");
  const audit = whiteboxShadowCaseAudit({
    caseId: "repeated-wording",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    clinicalText,
    expectedSpans: [{
      text: "採血",
      charStart: rawStart,
      charEnd: rawStart + 2,
      category: "lab",
      code: "160022510",
      actionStatus: "performed",
      temporalRelation: "current_visit",
      sourceOrigin: "own_clinic_record",
      providerOwnership: "own_clinic"
    }]
  }, detailWithGateDiagnostic({
    lineIndex: 1,
    charStart: 5,
    charEnd: 7,
    category: "lab",
    spanText: "採血",
    code: "160022510"
  }));

  const [diagnostic] = audit.expectedSpanDiagnostics;
  assert.equal(diagnostic.expectedLineIndex, 2);
  assert.equal(diagnostic.runtimeSpanObserved, false);
  assert.equal(diagnostic.matchType, "none");
});

test("span audit reports safe exclusion separately from billable inclusion", () => {
  const clinicalText = "O）ネブライザーは施行せず。";
  const rawStart = clinicalText.indexOf("ネブライザー");
  const audit = whiteboxShadowCaseAudit({
    caseId: "safe-exclusion",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    clinicalText,
    expectedSpans: [{
      text: "ネブライザー",
      charStart: rawStart,
      charEnd: rawStart + "ネブライザー".length,
      category: "treatment",
      code: "140009610",
      actionStatus: "not_performed",
      temporalRelation: "current_visit",
      sourceOrigin: "own_clinic_record",
      providerOwnership: "own_clinic"
    }]
  }, detailWithGateDiagnostic({
    lineIndex: 1,
    charStart: rawStart,
    charEnd: rawStart + "ネブライザー".length,
    category: "treatment",
    spanText: "ネブライザー",
    code: "140009610",
    strict: {
      jointEligible: true,
      safeExclusionEligible: true,
      blockerReasonCodes: []
    },
    shadow: {
      jointEligible: true,
      safeExclusionEligible: true,
      blockerReasonCodes: []
    }
  }));

  const summary = summarizeWhiteboxCaseAudits([audit])[
    "internal_medicine|outpatient"
  ];
  assert.equal(summary.expectedBillableInclusionSpanCount, 0);
  assert.equal(summary.expectedSafeExclusionSpanCount, 1);
  assert.equal(summary.strictSafeExclusionEligibleCount, 1);
  assert.equal(summary.shadowSafeExclusionEligibleCount, 1);
});

test("whitebox determinism snapshot excludes LLM-only output and compares controls", () => {
  const detail = {
    feeSession: {
      calculationProgress: {
        metrics: {
          performance: {
            whiteboxExtraction: {
              extractorVersion: "whitebox-v1",
              degraded: false,
              lineCount: 4,
              spanCount: 2,
              spanBearingLineCount: 2,
              shadowEncoderLineCount: 1,
              shadowPartialEncoderLineCount: 1,
              shadowEncoderSpanBearingLineCount: 2,
              shadowEncoderOwnedSpanCount: 2,
              encoderLineCount: 0,
              partialEncoderLineCount: 0,
              encoderOwnedSpanCount: 0,
              clauseRoutes: {
                strict: { total: 4, llm: 4, encoder: 0 },
                shadow: { total: 4, llm: 2, encoder: 2 }
              },
              visitFacts: {
                status: "complete",
                source: "deterministic",
                evidenceLineCount: 1,
                evidenceClauseCount: 1,
                ambiguousLineCount: 0,
                ambiguousClauseCount: 0,
                fullLlmRequired: false
              },
              routeReasonCounts: {
                linker_low_confidence_or_margin: 1,
                performed_span: 1
              },
              contextClassifier: {
                uncertainAxisCounts: {
                  temporalRelation: 1
                }
              }
            }
          }
        }
      },
      calculationResult: {
        clinicalExtraction: {
          trace: [
            {
              stage: "whitebox_router",
              shadowEncoderLineIds: ["O-002", "O-001"]
            },
            {
              stage: "whitebox_shadow_comparison",
              matchedCodes: ["160022510"],
              encoderOnlyCodes: ["140000610"],
              llmOnlyCodes: ["112007410"]
            }
          ]
        }
      }
    }
  };
  const snapshot = whiteboxDeterminismSnapshot(detail);
  const fingerprint = whiteboxDeterminismFingerprint(detail);

  assert.deepEqual(snapshot.encoderCodes, ["140000610", "160022510"]);
  assert.deepEqual(snapshot.shadowEncoderLineIds, ["O-001", "O-002"]);
  assert.equal(snapshot.determinismScope, "whitebox_router_only");
  assert.deepEqual(snapshot.clauseRoutes.shadow, {
    encoder: 2,
    llm: 2,
    total: 4
  });
  assert.equal(JSON.stringify(snapshot).includes("112007410"), false);
  assert.equal(fingerprint.length, 64);
  assert.deepEqual(summarizeWhiteboxRouting([
    { whiteboxSnapshot: snapshot }
  ]), {
    runCount: 1,
    degradedRunCount: 0,
    lineCount: 4,
    spanCount: 2,
    spanBearingLineCount: 2,
    shadowEncoderLineCount: 1,
    shadowPartialEncoderLineCount: 1,
    shadowEncoderSpanBearingLineCount: 2,
    shadowEncoderOwnedSpanCount: 2,
    encoderLineCount: 0,
    partialEncoderLineCount: 0,
    encoderOwnedSpanCount: 0,
    encoderCodeRunCount: 1,
    fullLlmRequiredRunCount: 0,
    strictClauseRoutes: {
      encoder: 0,
      llm: 4,
      total: 4
    },
    shadowClauseRoutes: {
      encoder: 2,
      llm: 2,
      total: 4
    },
    visitFactsStatusCounts: { complete: 1 },
    visitFactsSourceCounts: { deterministic: 1 },
    shadowRoutableLineCount: 2,
    shadowRoutableLineRatio: 0.5,
    spanBearingRoutableLineRatio: 1,
    strictExpectedLlmClauseRatio: 1,
    shadowExpectedLlmClauseRatio: 0.5
  });
  assert.deepEqual(summarizeWhiteboxDeterminism([
    {
      controlGroupId: "group-1",
      caseId: "case-1",
      measurementCell: "internal_medicine|outpatient",
      whiteboxFingerprint: fingerprint
    },
    {
      controlGroupId: "group-1",
      caseId: "case-1",
      measurementCell: "internal_medicine|outpatient",
      whiteboxFingerprint: fingerprint
    }
  ]), {
    scope: "whitebox_router_only",
    groupCount: 1,
    exactGroupCount: 1,
    exactMatchRate: 1,
    minimumObservedRepeats: 2,
    groups: [{
      controlGroupId: "group-1",
      caseId: "case-1",
      measurementCell: "internal_medicine|outpatient",
      observedRepeats: 2,
      exactMatch: true,
      uniqueFingerprintCount: 1
    }]
  });
});

test("diagnostic subsets are never eligible for promotion review", () => {
  const eligibility = assessWhiteboxEvaluationEligibility({
    status: "complete",
    purpose: "diagnostic",
    holdoutUsed: false,
    requiredCellCount: 32,
    observedCellCount: 12,
    expectedCalculationCount: 12,
    runCount: 12,
    degradedRunCount: 0,
    cloudRunRevisions: ["fee-api-stg-00001"],
    determinism: {
      groupCount: 0,
      exactGroupCount: 0,
      minimumObservedRepeats: 0,
    },
  });

  assert.equal(eligibility.promotionReviewEligible, false);
  assert.deepEqual(eligibility.ineligibleReasonCodes, [
    "diagnostic_measurement_only",
    "holdout_not_used",
    "matrix_incomplete",
    "determinism_controls_incomplete",
    "determinism_mismatch",
  ]);
});

test("promotion review eligibility requires full fixed and deterministic evidence", () => {
  const eligibility = assessWhiteboxEvaluationEligibility({
    status: "complete",
    purpose: "promotion",
    holdoutUsed: true,
    requiredCellCount: 32,
    observedCellCount: 32,
    expectedCalculationCount: 96,
    runCount: 96,
    degradedRunCount: 0,
    cloudRunRevisions: ["fee-api-stg-00001"],
    determinism: {
      groupCount: 32,
      exactGroupCount: 32,
      minimumObservedRepeats: 3,
    },
  });

  assert.equal(eligibility.promotionReviewEligible, true);
  assert.deepEqual(eligibility.ineligibleReasonCodes, []);
  assert.equal(eligibility.independentHumanAdjudicationRequired, true);
});

function detailWithGateDiagnostic({
  spanText,
  code,
  strict = {
    jointEligible: true,
    billableInclusionEligible: true,
    blockerReasonCodes: []
  },
  shadow = {
    jointEligible: true,
    billableInclusionEligible: true,
    blockerReasonCodes: []
  },
  ...diagnostic
}) {
  return {
    feeSession: {
      calculationResult: {
        clinicalExtraction: {
          trace: [{
            stage: "whitebox_router",
            gateDiagnostics: [{
              lineId: "line-1",
              spanId: "span-1",
              spanTextSha256: crypto.createHash("sha256").update(spanText).digest("hex"),
              strict,
              shadow,
              semanticCandidates: [{ code, rank: 1 }],
              shadowCandidates: [{ code, rank: 1 }],
              ...diagnostic
            }]
          }]
        }
      }
    }
  };
}
