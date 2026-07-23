import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStabilityBaseline,
  candidateKey,
  jaccardSimilarity,
  summarizeStabilityCase,
  summarizeStabilitySuite,
  validateStabilityBaseline
} from "./fee-extraction-stability.mjs";

function run(totalPoints, codes, clinicalEventCount) {
  return {
    totalPoints,
    candidateItems: codes.map((code) => ({ code, title: `候補${code}` })),
    extraction: { clinicalEventCount }
  };
}

test("candidate key ignores display order but keeps the semantic identity", () => {
  assert.equal(
    candidateKey({ code: "1", codeCandidates: ["3", "2"], title: " 候補  名 " }),
    candidateKey({ code: "1", codeCandidates: ["2", "3"], title: "候補 名" })
  );
});

test("Jaccard is one for two empty sets and measures set overlap", () => {
  assert.equal(jaccardSimilarity([], []), 1);
  assert.equal(
    jaccardSimilarity([{ code: "1" }, { code: "2" }], [{ code: "2" }, { code: "3" }]),
    0.333333
  );
});

test("confirmed point variance is the mandatory gate", () => {
  const summary = summarizeStabilityCase({
    caseId: "unstable",
    runs: [run(100, ["a"], 1), run(101, ["a"], 1), run(100, ["a"], 1)],
    minimumCandidateJaccard: 1
  });
  assert.equal(summary.confirmedPoints.pass, false);
  assert.equal(summary.verdict, "fail");
});

test("candidate threshold is pending before baseline and enforced afterward", () => {
  const runs = [
    run(100, ["a", "b"], 1),
    run(100, ["a"], 3),
    run(100, ["a", "b"], 2)
  ];
  const unbaselined = summarizeStabilityCase({ caseId: "case-a", runs });
  assert.equal(unbaselined.verdict, "baseline_required");
  assert.equal(unbaselined.candidates.minimumJaccard, 0.5);
  assert.equal(unbaselined.clinicalEvents.spread, 2);

  const passing = summarizeStabilityCase({
    caseId: "case-a",
    runs,
    minimumCandidateJaccard: 0.5
  });
  assert.equal(passing.verdict, "pass");

  const failing = summarizeStabilityCase({
    caseId: "case-a",
    runs,
    minimumCandidateJaccard: 0.75
  });
  assert.equal(failing.verdict, "fail");
});

test("reviewed baseline can be generated and validated only from stable points", () => {
  const suite = summarizeStabilitySuite({
    cases: [{
      id: "case-a",
      runs: [run(100, ["a"], 1), run(100, ["a"], 2), run(100, ["a"], 1)]
    }]
  });
  const baseline = buildStabilityBaseline(suite, {
    sourceRunId: "run-1",
    generatedAt: "2026-07-23T00:00:00.000Z"
  });
  assert.equal(baseline.cases["case-a"].minimumCandidateJaccard, 1);
  assert.equal(validateStabilityBaseline(baseline, ["case-a"]), baseline);

  assert.throws(() => buildStabilityBaseline({
    allConfirmedPointVarianceZero: false,
    cases: suite.cases
  }), /non-zero/u);
});
