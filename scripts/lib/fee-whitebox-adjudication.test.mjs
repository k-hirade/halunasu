import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileWhiteboxAdjudication,
  prepareWhiteboxAdjudicationQueue
} from "./fee-whitebox-adjudication.mjs";

const policy = {
  requiredSpecialties: ["internal_medicine"],
  requiredEncounterSettings: ["outpatient"],
  telemetry: {
    minimumRunsPerCell: 2
  },
  adjudication: {
    minimumReviewedLinesPerCell: 2,
    minimumReviewedSpansPerCell: 1
  }
};

function manifest() {
  return {
    schemaVersion: "fee-whitebox-shadow-stg-run-v1",
    status: "complete",
    runId: "run-1",
    source: {
      dataset: "cases.json",
      datasetSha256: "dataset-sha",
      policy: "policy.json",
      policySha256: "policy-sha",
      holdoutUsed: false
    },
    methodology: {
      evaluationPurpose: "diagnostic"
    },
    environment: {
      cloudRunRevision: "revision-1",
      artifactVersions: { spanDetector: "span-v1" }
    },
    determinism: {
      groupCount: 1,
      exactGroupCount: 1,
      exactMatchRate: 1,
      minimumObservedRepeats: 3
    },
    runs: [
      {
        runKind: "measurement",
        caseId: "case-disagreement",
        feeSessionId: "fee-1",
        specialty: "internal_medicine",
        encounterSetting: "outpatient",
        measurementCell: "internal_medicine|outpatient",
        machinePrecheck: {
          reviewedSpanCount: 2,
          encoderCodes: ["A", "B"],
          llmCodes: ["A", "C"]
        }
      },
      {
        runKind: "measurement",
        caseId: "case-agreement",
        feeSessionId: "fee-2",
        specialty: "internal_medicine",
        encounterSetting: "outpatient",
        measurementCell: "internal_medicine|outpatient",
        machinePrecheck: {
          reviewedSpanCount: 1,
          encoderCodes: ["D"],
          llmCodes: ["D"]
        }
      },
      {
        runKind: "determinism_control",
        caseId: "case-disagreement",
        feeSessionId: "fee-control",
        specialty: "internal_medicine",
        encounterSetting: "outpatient",
        measurementCell: "internal_medicine|outpatient",
        machinePrecheck: {
          reviewedSpanCount: 2,
          encoderCodes: ["A", "B"],
          llmCodes: ["A", "C"]
        }
      }
    ]
  };
}

const dataset = {
  cases: [
    {
      caseId: "case-disagreement",
      clinicalText: "S）安定。\nO）検査Aと検査Bを実施。"
    },
    {
      caseId: "case-agreement",
      clinicalText: "O）処置Dを実施。"
    }
  ]
};

test("adjudication queue selects all disagreements and deterministic cell samples", () => {
  const queue = prepareWhiteboxAdjudicationQueue({
    runManifest: manifest(),
    dataset,
    policy,
    bindings: {
      runManifestSha256: "run-sha",
      datasetSha256: "dataset-sha",
      policySha256: "policy-sha"
    },
    additionalPerCell: 1
  });

  assert.equal(queue.purpose, "diagnostic");
  assert.equal(queue.promotionEligibleSource, false);
  assert.equal(queue.items.length, 2);
  assert.deepEqual(
    queue.items.map((item) => item.selectionReasons[0]).sort(),
    ["deterministic_cell_sample", "encoder_llm_disagreement"]
  );
  assert.equal(queue.items.some((item) => item.feeSessionId === "fee-control"), false);
  assert.equal(queue.items[0].humanReview.status, "pending");
});

test("compiler validates human review and emits diagnostic feedback without promotion", () => {
  const queue = prepareWhiteboxAdjudicationQueue({
    runManifest: manifest(),
    dataset,
    policy,
    bindings: {
      runManifestSha256: "run-sha",
      datasetSha256: "dataset-sha",
      policySha256: "policy-sha"
    },
    additionalPerCell: 1
  });
  for (const item of queue.items) {
    item.humanReview = {
      status: "human_reviewed",
      reviewerId: "reviewer-1",
      reviewedAt: "2026-07-26T00:00:00Z",
      truthCodes: item.caseId === "case-disagreement" ? ["A", "C", "E"] : ["D"],
      truthSpanCount: item.caseId === "case-disagreement" ? 3 : 1,
      dangerousFalsePositiveCodes: item.caseId === "case-disagreement" ? ["B"] : [],
      dangerousNegativeOpportunityCount: item.caseId === "case-disagreement" ? 1 : 0,
      notes: ""
    };
  }

  const compiled = compileWhiteboxAdjudication(queue, policy);
  const cell = compiled.cells[0];
  assert.equal(compiled.promotionEligible, false);
  assert.equal(compiled.controlRepeats, 3);
  assert.equal(compiled.deterministicExactMatchRate, 1);
  assert.equal(cell.truePositiveCodeCount, 2);
  assert.equal(cell.falsePositiveCodeCount, 1);
  assert.equal(cell.falseNegativeCodeCount, 2);
  assert.equal(cell.llmTruePositiveCodeCount, 3);
  assert.equal(cell.llmFalseNegativeCodeCount, 1);
  assert.equal(cell.dangerousFalsePositiveCount, 1);
  assert.ok(compiled.feedbackEvents.some((item) => (
    item.code === "E" && item.rejectReason === "both_false_negative"
  )));
});

test("compiler rejects source text tampering and incomplete reviews", () => {
  const queue = prepareWhiteboxAdjudicationQueue({
    runManifest: manifest(),
    dataset,
    policy,
    bindings: {
      runManifestSha256: "run-sha",
      datasetSha256: "dataset-sha",
      policySha256: "policy-sha"
    }
  });
  assert.throws(
    () => compileWhiteboxAdjudication(queue, policy),
    /is not human_reviewed/u
  );
  queue.items[0].humanReview.status = "human_reviewed";
  queue.items[0].clinicalText += "tampered";
  assert.throws(
    () => compileWhiteboxAdjudication(queue, policy),
    /clinicalText hash mismatch/u
  );
});

test("compiler rejects changes to bound machine comparison", () => {
  const queue = prepareWhiteboxAdjudicationQueue({
    runManifest: manifest(),
    dataset,
    policy,
    bindings: {
      runManifestSha256: "run-sha",
      datasetSha256: "dataset-sha",
      policySha256: "policy-sha"
    }
  });
  queue.items[0].humanReview.status = "human_reviewed";
  queue.items[0].machineComparison.encoderCodes.push("TAMPERED");
  assert.throws(
    () => compileWhiteboxAdjudication(queue, policy),
    /immutable review payload hash mismatch/u
  );
});

test("compiler marks only holdout-backed covered reviews as promotion eligible", () => {
  const promotionManifest = manifest();
  promotionManifest.source.holdoutUsed = true;
  promotionManifest.methodology.evaluationPurpose = "promotion";
  const queue = prepareWhiteboxAdjudicationQueue({
    runManifest: promotionManifest,
    dataset,
    policy,
    bindings: {
      runManifestSha256: "run-sha",
      datasetSha256: "dataset-sha",
      policySha256: "policy-sha"
    },
    additionalPerCell: 1
  });
  for (const item of queue.items) {
    item.humanReview = {
      status: "human_reviewed",
      reviewerId: "reviewer-1",
      reviewedAt: "2026-07-26T00:00:00Z",
      truthCodes: item.machineComparison.encoderCodes,
      truthSpanCount: item.machineComparison.encoderCodes.length,
      dangerousFalsePositiveCodes: [],
      dangerousNegativeOpportunityCount: 1,
      notes: ""
    };
  }

  const compiled = compileWhiteboxAdjudication(queue, policy);
  assert.equal(queue.purpose, "promotion");
  assert.equal(compiled.promotionEligible, true);
});

test("queue rejects inconsistent evaluation purpose and holdout use", () => {
  const inconsistent = manifest();
  inconsistent.methodology.evaluationPurpose = "promotion";
  assert.throws(
    () => prepareWhiteboxAdjudicationQueue({
      runManifest: inconsistent,
      dataset,
      policy,
      bindings: {
        runManifestSha256: "run-sha",
        datasetSha256: "dataset-sha",
        policySha256: "policy-sha"
      }
    }),
    /evaluationPurpose and source\.holdoutUsed are inconsistent/u
  );
});

test("promotion requires the minimum reviewed item count per cell", () => {
  const promotionManifest = manifest();
  promotionManifest.source.holdoutUsed = true;
  promotionManifest.methodology.evaluationPurpose = "promotion";
  promotionManifest.runs = promotionManifest.runs.filter(
    (run) => run.caseId === "case-disagreement"
  );
  const queue = prepareWhiteboxAdjudicationQueue({
    runManifest: promotionManifest,
    dataset,
    policy,
    bindings: {
      runManifestSha256: "run-sha",
      datasetSha256: "dataset-sha",
      policySha256: "policy-sha"
    }
  });
  queue.items[0].humanReview = {
    status: "human_reviewed",
    reviewerId: "reviewer-1",
    reviewedAt: "2026-07-26T00:00:00Z",
    truthCodes: queue.items[0].machineComparison.encoderCodes,
    truthSpanCount: 10,
    dangerousFalsePositiveCodes: [],
    dangerousNegativeOpportunityCount: 10,
    notes: ""
  };

  const compiled = compileWhiteboxAdjudication(queue, {
    ...policy,
    adjudication: {
      ...policy.adjudication,
      minimumReviewedLinesPerCell: 1,
      minimumReviewedSpansPerCell: 1
    }
  });
  assert.equal(compiled.cells[0].reviewedItemCount, 1);
  assert.equal(compiled.promotionEligible, false);
});

test("compiler rejects changing a diagnostic queue into a promotion queue", () => {
  const queue = prepareWhiteboxAdjudicationQueue({
    runManifest: manifest(),
    dataset,
    policy,
    bindings: {
      runManifestSha256: "run-sha",
      datasetSha256: "dataset-sha",
      policySha256: "policy-sha"
    }
  });
  queue.purpose = "promotion";
  queue.promotionEligibleSource = true;
  assert.throws(
    () => compileWhiteboxAdjudication(queue, policy),
    /queue immutable payload hash mismatch/u
  );
});
