import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWhiteboxShadowExecutions,
  buildWhiteboxShadowSessionInput,
  requiredWhiteboxCells,
  resolveWhiteboxDepartments,
  selectWhiteboxDiagnosticSample,
  selectWhiteboxShadowCases,
  selectWhiteboxPromotionCases,
  summarizeWhiteboxCaseAudits,
  summarizeWhiteboxDeterminism,
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
          trace: [{
            stage: "whitebox_shadow_comparison",
            matchedCodes: ["160022510"],
            encoderOnlyCodes: ["999999999"],
            llmOnlyCodes: []
          }]
        }
      }
    }
  });

  assert.deepEqual(audit.expectedCurrentOwnCodes, ["160022510"]);
  assert.deepEqual(audit.encoderTruePositiveCodes, ["160022510"]);
  assert.deepEqual(audit.encoderFalsePositiveCodes, ["999999999"]);
  assert.deepEqual(audit.encoderFalseNegativeCodes, []);
  assert.equal(audit.reviewStatus, "machine_precheck_only");
  assert.deepEqual(
    summarizeWhiteboxCaseAudits([audit])["internal_medicine|outpatient"],
    {
      runCount: 1,
      reviewedLineCount: 2,
      reviewedSpanCount: 2,
      encoderTruePositiveCodeCount: 1,
      encoderFalsePositiveCodeCount: 1,
      encoderFalseNegativeCodeCount: 0,
      shadowComparisonObservedCount: 1
    }
  );
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
  assert.equal(JSON.stringify(snapshot).includes("112007410"), false);
  assert.equal(fingerprint.length, 64);
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
