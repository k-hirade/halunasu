import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE2_CONTEXT_GENERATOR_FAMILY,
  PHASE2_HOLDOUT_GENERATOR_FAMILY,
  auditPhase2ContextContrastCorpus,
  auditPhase2HoldoutSupplement,
  auditPhase2PromotionPreparation,
  buildPhase2ContextContrastCorpus,
  buildPhase2HoldoutSupplement
} from "./fee-whitebox-phase2-corpus.mjs";

test("context corpus covers every cell and every contrast axis", () => {
  const document = buildPhase2ContextContrastCorpus();
  const audit = auditPhase2ContextContrastCorpus(document);

  assert.equal(audit.ok, true);
  assert.equal(audit.caseCount, 96);
  assert.equal(audit.completeCellCount, 32);
  assert.equal(document.notGold, true);
  assert.equal(document.trainingOnly, true);
  for (const cell of audit.coverage) {
    assert.equal(cell.caseCount, 3);
    assert.equal(cell.developmentCaseCount, 1);
    assert.ok(cell.pastSpanCount >= 3);
    assert.ok(cell.otherProviderSpanCount >= 3);
    assert.ok(cell.patientReportedSpanCount >= 3);
    assert.ok(cell.sameDayUnknownSpanCount >= 3);
    assert.ok(cell.imagingSpanCount >= 3);
    assert.ok(cell.treatmentSpanCount >= 3);
  }
  assert.ok(document.cases.every((item) => (
    item.generationProvenance.generatorFamily === PHASE2_CONTEXT_GENERATOR_FAMILY
    && item.split !== "holdout"
  )));
});

test("holdout supplement is pending review and independently generated", () => {
  const document = buildPhase2HoldoutSupplement();
  const audit = auditPhase2HoldoutSupplement(document);

  assert.equal(audit.ok, true);
  assert.equal(audit.caseCount, 32);
  assert.equal(audit.completeCellCount, 32);
  assert.equal(document.notGold, true);
  for (const item of document.cases) {
    assert.equal(item.split, "holdout");
    assert.equal(item.annotationStatus, "pending_review");
    assert.equal(
      item.generationProvenance.generatorFamily,
      PHASE2_HOLDOUT_GENERATOR_FAMILY
    );
    assert.equal(item.generationProvenance.labelsRequireIndependentReview, true);
    assert.ok(item.annotationDraftSpans.length >= 10);
    assert.ok(item.chart.standard.split("\n").length >= 12);
  }
});

test("audit rejects a corrupted draft span offset", () => {
  const document = buildPhase2HoldoutSupplement();
  document.cases[0].annotationDraftSpans[0].charStart += 1;

  const audit = auditPhase2HoldoutSupplement(document);

  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((message) => message.includes("offset mismatch")));
});

test("promotion preparation can be complete without pretending it is reviewed", () => {
  const supplement = buildPhase2HoldoutSupplement();
  const generated = {
    cases: supplement.cases
      .filter((item) => item.encounterSetting !== "outpatient")
      .flatMap((item) => [1, 2].map((variant) => ({
        ...item,
        caseId: `${item.caseId}-generated-${variant}`,
        chart: {
          standard: "S：合成例\nO：所見\nA：評価\nP：方針"
        },
        annotationDraftSpans: []
      })))
  };
  const canonical = {
    cases: supplement.cases
      .filter((item) => item.encounterSetting === "outpatient")
      .flatMap((item) => [1, 2].map((variant) => ({
        ...item,
        caseId: `${item.caseId}-reviewed-${variant}`,
        split: "holdout",
        annotationStatus: "reviewed",
        clinicalText: Array.from({ length: 4 }, (_, index) => `L${index}`).join("\n"),
        expectedSpans: item.annotationDraftSpans.slice(0, 5)
      })))
  };
  const pending = [...generated.cases, ...supplement.cases];
  const reviewQueue = {
    queue: pending.map((item) => ({
      sourceCaseId: item.caseId,
      annotationStatus: "pending_manual_annotation",
      anchorSuggestions: [],
      draftSpanSuggestions: item.annotationDraftSpans || []
    }))
  };

  const audit = auditPhase2PromotionPreparation({
    canonicalDataset: canonical,
    generatedHoldoutDataset: generated,
    supplementDataset: supplement,
    reviewQueue
  });

  assert.equal(audit.ok, true);
  assert.equal(audit.preparedCompleteCellCount, 32);
  assert.equal(audit.reviewedCompleteCellCount, 0);
});
