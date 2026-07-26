import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWhiteboxShadowSessionInput,
  requiredWhiteboxCells,
  resolveWhiteboxDepartments,
  selectWhiteboxShadowCases,
  summarizeWhiteboxCaseAudits,
  whiteboxDepartmentInput,
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
