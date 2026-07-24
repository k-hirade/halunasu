import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnchorSuggestions,
  prepareAnnotationQueue
} from "../prepare_fee_specialty_matrix_annotations.mjs";

function sourceCase(overrides = {}) {
  return {
    caseId: "V2-IM-LAB-001",
    caseTypeKey: "internal-lab-revisit",
    encounter: {
      department: "internal_medicine",
      setting: "outpatient"
    },
    chart: {
      standard: "O）院内で尿定性を実施。静脈採血も施行した。"
    },
    expectedExtraction: {
      requiredBillingSignals: ["尿定性", "静脈採血"]
    },
    billingTargets: [
      { code: "160000310", name: "尿一般" },
      { code: "160095710", name: "Ｂ－Ｖ" }
    ],
    expectedClaimContext: {
      procedure_codes: ["160000310"]
    },
    ...overrides
  };
}

test("anchor suggestions preserve Unicode offsets but never assert gold labels", () => {
  const suggestions = buildAnchorSuggestions(sourceCase());
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].text, "尿定性");
  assert.equal(suggestions[0].status, "suggestion_only");
  assert.equal(suggestions[0].codeCandidates.length, 0);
});

test("queue includes only the declared initial specialty and setting matrix", () => {
  const result = prepareAnnotationQueue({
    datasetId: "source",
    cases: [
      sourceCase(),
      sourceCase({
        caseId: "inpatient",
        encounter: {
          department: "internal_medicine",
          setting: "inpatient"
        }
      }),
      sourceCase({
        caseId: "unsupported",
        encounter: {
          department: "urology",
          setting: "outpatient"
        }
      })
    ]
  });
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].notGold, true);
  assert.equal(result.skipped.length, 2);
});
