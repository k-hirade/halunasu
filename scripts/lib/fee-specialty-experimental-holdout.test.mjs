import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExperimentalHoldoutDataset
} from "./fee-specialty-experimental-holdout.mjs";

function fixture() {
  return {
    canonicalDataset: {
      cases: [{
        caseId: "reviewed-1",
        specialty: "internal_medicine",
        encounterSetting: "outpatient",
        split: "holdout",
        annotationStatus: "reviewed"
      }]
    },
    generatedDataset: {
      cases: [{
        caseId: "generated-1",
        caseTypeKey: "template-1",
        specialty: "internal_medicine",
        encounterSetting: "telephone",
        chart: {
          standard: [
            "S：患者本人から電話相談。",
            "O：状態を確認。",
            "A：増悪なし。",
            "P：電話等再診として治療上必要な指示。院外処方箋を発行。"
          ].join("\n")
        },
        expectedClaimContext: {},
        billingTargets: [
          { code: "112007950", name: "電話等再診料" },
          { code: "120002910", name: "処方箋料" }
        ],
        generationProvenance: {
          source: "separate_generator",
          generatorFamily: "test-generator",
          blueprintSha256: "abc"
        }
      }]
    },
    blueprintDataset: {
      blueprints: [{
        blueprintId: "generated-1",
        specialty: "internal_medicine",
        encounterSetting: "telephone"
      }]
    }
  };
}

test("builds non-gold machine labels without promoting review status", () => {
  const result = buildExperimentalHoldoutDataset(fixture());
  const generated = result.cases.find((item) => item.caseId === "generated-1");

  assert.equal(result.notGold, true);
  assert.equal(result.humanReviewSkipped, true);
  assert.equal(result.coverage.totalCaseCount, 2);
  assert.equal(generated.annotationStatus, "pending_review");
  assert.equal(generated.experimentalLabelStatus, "machine_derived");
  assert.equal(generated.expectedSpans.length, 2);
  assert.deepEqual(
    generated.expectedSpans.map((span) => [span.code, span.category]),
    [
      ["112007950", "outpatient_basic"],
      ["120002910", "medication"]
    ]
  );
  for (const span of generated.expectedSpans) {
    const actual = Array.from(generated.clinicalText)
      .slice(span.charStart, span.charEnd)
      .join("");
    assert.equal(actual, span.text);
  }
});

test("rejects a generated target when its required phrase is absent", () => {
  const input = fixture();
  input.generatedDataset.cases[0].chart.standard = "S：相談。\nO：確認。\nA：安定。\nP：説明。";
  assert.throws(
    () => buildExperimentalHoldoutDataset(input),
    /required span phrase/
  );
});
