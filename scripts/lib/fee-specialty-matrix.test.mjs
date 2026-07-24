import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  unicodeOffsetOf,
  validateFeeSpecialtyMatrix
} from "./fee-specialty-matrix.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const clinicalAxesSchema = JSON.parse(
  fs.readFileSync(
    path.join(
      repoRoot,
      "packages/medical-core/generated/clinical-axes.schema.json"
    ),
    "utf8"
  )
);
const matrix = {
  specialties: [{ id: "internal_medicine", label: "内科" }],
  encounterSettings: [{ id: "outpatient", label: "外来" }],
  requirements: {
    minimumCasesPerCell: 1,
    minimumHoldoutCasesPerCell: 1
  }
};

function validCase(overrides = {}) {
  const clinicalText = "O）本日、静脈採血を実施。";
  const text = "静脈採血";
  const charStart = unicodeOffsetOf(clinicalText, text);
  return {
    caseId: "WX0-IM-OUT-001",
    specialty: "internal_medicine",
    encounterSetting: "outpatient",
    split: "holdout",
    templateId: "manual-template-001",
    synthetic: true,
    annotationStatus: "reviewed",
    generationProvenance: {
      source: "human_authored"
    },
    clinicalText,
    expectedSpans: [
      {
        text,
        charStart,
        charEnd: charStart + Array.from(text).length,
        code: "160095710",
        category: "lab",
        actionStatus: "performed",
        temporalRelation: "current_visit",
        sourceOrigin: "own_clinic_record",
        providerOwnership: "own_clinic",
        standingStatus: "none"
      }
    ],
    expectedClaimContext: { procedure_codes: ["160095710"] },
    holdoutProvenance: {
      source: "human_reviewed"
    },
    reviewPolicy: {
      expectedSpansReviewed: true,
      medicalOfficeReviewed: false,
      productionGoldAllowed: false
    },
    ...overrides
  };
}

test("valid reviewed holdout completes a one-cell strict matrix", () => {
  const result = validateFeeSpecialtyMatrix({
    matrix,
    dataset: { cases: [validCase()] },
    clinicalAxesSchema,
    strict: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.completeCellCount, 1);
  assert.equal(result.reviewedCaseCount, 1);
});

test("non-strict validation reports an incomplete corpus without hiding it", () => {
  const result = validateFeeSpecialtyMatrix({
    matrix,
    dataset: { cases: [] },
    clinicalAxesSchema,
    strict: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.completeCellCount, 0);
  assert.equal(result.coverage[0].caseDeficit, 1);
  assert.equal(result.warnings[0].code, "matrix_incomplete");

  const strictResult = validateFeeSpecialtyMatrix({
    matrix,
    dataset: { cases: [] },
    clinicalAxesSchema,
    strict: true
  });
  assert.equal(strictResult.ok, false);
  assert.ok(strictResult.errors.some((item) => item.code === "cell_case_deficit"));
});

test("invalid offsets and axis values are rejected", () => {
  const item = validCase();
  item.expectedSpans[0].charStart += 1;
  item.expectedSpans[0].actionStatus = "generated";
  const result = validateFeeSpecialtyMatrix({
    matrix,
    dataset: { cases: [item] },
    clinicalAxesSchema
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "span_text_mismatch"));
  assert.ok(result.errors.some((error) => error.code === "invalid_axis_value"));
});

test("template and identical-text leakage across splits are rejected", () => {
  const training = validCase({
    caseId: "WX0-TRAIN",
    split: "train",
    annotationStatus: "reviewed",
    generationProvenance: {
      source: "primary_generator",
      generatorFamily: "primary-v1"
    }
  });
  delete training.holdoutProvenance;
  const holdout = validCase({ caseId: "WX0-HOLDOUT" });
  const result = validateFeeSpecialtyMatrix({
    matrix,
    dataset: { cases: [training, holdout] },
    clinicalAxesSchema
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.code === "template_split_leakage")
  );
  assert.ok(result.errors.some((error) => error.code === "text_split_leakage"));
});

test("separate-generator holdout cannot reuse a non-holdout generator family", () => {
  const training = validCase({
    caseId: "WX0-TRAIN-GENERATOR",
    split: "train",
    templateId: "training-template",
    clinicalText: "O）採血を実施した。",
    generationProvenance: {
      source: "primary_generator",
      generatorFamily: "shared-generator"
    }
  });
  delete training.holdoutProvenance;
  const holdout = validCase({
    caseId: "WX0-HOLDOUT-GENERATOR",
    templateId: "holdout-template",
    generationProvenance: {
      source: "separate_generator",
      generatorFamily: "shared-generator"
    },
    holdoutProvenance: {
      source: "separate_generator",
      generatorFamily: "shared-generator"
    }
  });
  const result = validateFeeSpecialtyMatrix({
    matrix,
    dataset: { cases: [training, holdout] },
    clinicalAxesSchema
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.code === "generator_split_leakage")
  );
});

test("unicode offsets use code points and survive surrogate pairs", () => {
  const text = "S）発熱😀。O）採血実施。";
  assert.equal(unicodeOffsetOf(text, "採血"), 8);
  assert.equal(Array.from(text).slice(8, 10).join(""), "採血");
});
