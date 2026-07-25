import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  promoteReviewedAnnotations,
  SpecialtyPromotionError,
  writeJsonAtomic
} from "./fee-specialty-promotion.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const clinicalAxesSchema = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "packages/medical-core/generated/clinical-axes.schema.json"),
  "utf8"
));
const matrix = {
  specialties: [{ id: "internal_medicine" }],
  encounterSettings: [{ id: "home_visit" }],
  requirements: {
    minimumCasesPerCell: 1,
    minimumHoldoutCasesPerCell: 1
  }
};
const masterRecords = {
  "114001110": {
    code: "114001110",
    name: "在宅患者訪問診療料（１）１（同一建物居住者以外）",
    table: "medical_procedures"
  }
};

function reviewedQueue(overrides = {}) {
  return {
    schemaVersion: "fee-specialty-matrix-annotation-queue-v1",
    sourceDatasetId: "fee-specialty-holdout-generated-v1",
    queue: [{
      sourceCaseId: "H2-IM-HOME-001",
      caseId: "wx0-im-home-h001",
      specialty: "internal_medicine",
      encounterSetting: "home_visit",
      split: "holdout",
      sourceTemplateId: "h2-im-home-template-001",
      generationProvenance: {
        source: "separate_generator",
        generatorFamily: "openai-fee-specialty-holdout-v1",
        modelRevision: "test"
      },
      clinicalText: "O）本日、居宅へ定期訪問診療を実施した。",
      expectedClaimContext: {
        encounter: { is_outpatient: true },
        home_visit: { same_building: false }
      },
      billingTargets: [{
        code: "114001110",
        name: masterRecords["114001110"].name
      }],
      reviewedBy: "reviewer",
      approvedSpans: [{
        text: "定期訪問診療",
        code: "114001110",
        category: "management",
        actionStatus: "performed",
        temporalRelation: "current_visit",
        sourceOrigin: "own_clinic_record",
        providerOwnership: "own_clinic",
        standingStatus: "none"
      }],
      ...overrides
    }]
  };
}

test("reviewed queue is promoted with forced human-review provenance", () => {
  const result = promoteReviewedAnnotations({
    queueDocument: reviewedQueue(),
    dataset: { schemaVersion: "test", cases: [] },
    matrix,
    clinicalAxesSchema,
    masterRecords,
    reviewedAt: "2026-07-25",
    strict: true
  });
  assert.equal(result.validation.ok, true);
  assert.equal(result.promoted[0].holdoutProvenance.source, "human_reviewed");
  assert.deepEqual(result.promoted[0].reviewPolicy, {
    expectedSpansReviewed: true,
    reviewedBy: "reviewer",
    reviewedAt: "2026-07-25"
  });
  assert.equal(
    result.promoted[0].clinicalText.slice(
      result.promoted[0].expectedSpans[0].charStart,
      result.promoted[0].expectedSpans[0].charEnd
    ),
    "定期訪問診療"
  );
});

test("one invalid entry rejects the complete batch", () => {
  const queue = reviewedQueue();
  queue.queue.push({
    ...queue.queue[0],
    sourceCaseId: "BROKEN",
    caseId: "broken",
    approvedSpans: [{ ...queue.queue[0].approvedSpans[0], code: "999999999" }]
  });
  assert.throws(
    () => promoteReviewedAnnotations({
      queueDocument: queue,
      dataset: { cases: [] },
      matrix,
      clinicalAxesSchema,
      masterRecords,
      reviewedAt: "2026-07-25"
    }),
    SpecialtyPromotionError
  );
});

test("collision replacement requires the same holdout source and generation provenance", () => {
  const first = promoteReviewedAnnotations({
    queueDocument: reviewedQueue(),
    dataset: { cases: [] },
    matrix,
    clinicalAxesSchema,
    masterRecords,
    reviewedAt: "2026-07-25"
  }).dataset;
  assert.throws(() => promoteReviewedAnnotations({
    queueDocument: reviewedQueue(),
    dataset: first,
    matrix,
    clinicalAxesSchema,
    masterRecords,
    reviewedAt: "2026-07-25"
  }), /caseId collision/u);
  const replaced = promoteReviewedAnnotations({
    queueDocument: reviewedQueue(),
    dataset: first,
    matrix,
    clinicalAxesSchema,
    masterRecords,
    reviewedAt: "2026-07-25",
    replace: true
  });
  assert.equal(replaced.dataset.cases.length, 1);
});

test("atomic writer leaves the existing file untouched until a successful call", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fee-promotion-"));
  const target = path.join(directory, "cases.json");
  fs.writeFileSync(target, "{\"old\":true}\n");
  assert.equal(fs.readFileSync(target, "utf8"), "{\"old\":true}\n");
  writeJsonAtomic(target, { new: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { new: true });
  assert.equal(
    fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
    false
  );
});
