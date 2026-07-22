import test from "node:test";
import assert from "node:assert/strict";
import {
  captureFeeEvaluationSurface,
  evaluateLongitudinalEquivalence,
  evaluateMemoAcceptance,
  normalizeCandidateItems,
  normalizeConfirmedLines
} from "../../../scripts/lib/fee-longitudinal-evaluation.mjs";

const confirmed = [{ code: "114001110", name: "在宅患者訪問診療料", quantity: 1, totalPoints: 890 }];
const candidate = [{ kind: "proposal", code: "114057970", codeCandidates: [], title: "在宅データ提出加算", points: 50 }];

test("longitudinal equivalence requires exact confirmed lines and stable candidates", () => {
  const run = { confirmedLines: confirmed, candidateItems: candidate };
  const result = evaluateLongitudinalEquivalence({
    memoRuns: { crossSession: run, sameSession: run },
    controls: [run, run, run]
  });
  assert.equal(result.overallVerdict, "pass");
  assert.equal(result.controlVariability.confirmedStable, true);
  assert.equal(result.paths.sameSession.confirmed.verdict, "pass");
});

test("candidate differences are allowed only for the documented visit facts limit", () => {
  const control = { confirmedLines: confirmed, candidateItems: [] };
  const prescriptionCandidate = {
    confirmedLines: confirmed,
    candidateItems: [{ kind: "proposal", code: "120002910", codeCandidates: [], title: "処方箋料", points: 68 }]
  };
  const allowed = evaluateLongitudinalEquivalence({
    memoRuns: { crossSession: prescriptionCandidate },
    controls: [control, control, control],
    allowKnownVisitFactsCandidateDifferences: true
  });
  assert.equal(allowed.overallVerdict, "pass_with_known_limit");

  const rejected = evaluateLongitudinalEquivalence({
    memoRuns: { crossSession: { ...control, candidateItems: candidate } },
    controls: [control, control, control],
    allowKnownVisitFactsCandidateDifferences: true
  });
  assert.equal(rejected.overallVerdict, "fail");
});

test("visit facts limit includes all prescription-path candidates changed by outside prescription", () => {
  const control = {
    confirmedLines: confirmed,
    candidateItems: [
      { kind: "pending_line", code: "120002910", codeCandidates: [], title: "処方箋料", points: 60 },
      { kind: "proposal", code: "120005710", codeCandidates: [], title: "特定疾患処方管理加算", points: 56 }
    ]
  };
  const memo = {
    confirmedLines: confirmed,
    candidateItems: [
      { kind: "pending_line", code: "120000710", codeCandidates: [], title: "調剤料", points: 11 },
      { kind: "pending_line", code: "120001210", codeCandidates: [], title: "処方料", points: 42 },
      { kind: "proposal", code: "120005610", codeCandidates: [], title: "特定疾患処方管理加算", points: 56 }
    ]
  };
  const result = evaluateLongitudinalEquivalence({
    memoRuns: { crossSession: memo },
    controls: [control, control, control],
    allowKnownVisitFactsCandidateDifferences: true
  });
  assert.equal(result.overallVerdict, "pass_with_known_limit");
  assert.equal(result.paths.crossSession.candidates.knownVisitFactsLimitOnly, true);
});

test("control instability is reported as inconclusive instead of a memo regression", () => {
  const noCandidate = { confirmedLines: confirmed, candidateItems: [] };
  const withCandidate = { confirmedLines: confirmed, candidateItems: candidate };
  const result = evaluateLongitudinalEquivalence({
    memoRuns: { crossSession: noCandidate },
    controls: [noCandidate, withCandidate, noCandidate]
  });
  assert.equal(result.controlVariability.candidateStable, false);
  assert.equal(result.paths.crossSession.candidates.verdict, "inconclusive_control_variability");
});

test("memo acceptance verifies line counts, trace, history, and zero OpenAI calls", () => {
  const result = evaluateMemoAcceptance({
    extraction: { memo: { used: true, memoHitLineRatio: 1, continuedLineCount: 4, newLineCount: 0, removedLineCount: 1, traceRecorded: true } },
    patientHistory: { completeness: "partial" },
    openAi: { callObserved: false, providerDurationMs: 0 }
  }, {
    memoUsed: true,
    memoHitLineRatio: 1,
    continuedLineCount: 4,
    newLineCount: 0,
    removedLineCount: 1,
    traceRecorded: true,
    noOpenAiCall: true,
    historyAvailable: true
  });
  assert.equal(result.pass, true);
});

test("partial memo extraction still records the OpenAI call for new lines", () => {
  const surface = {
    feeSession: {
      calculationProgress: {
        metrics: {
          clinicalStructuring: { source: "memo", openAiProviderDurationMs: 120, usage: { input_tokens: 100 } },
          extractionMemo: { enabled: true, used: true, memoHitLineRatio: 0.75 }
        }
      },
      calculationResult: { totalPoints: 0, clinicalExtraction: {} }
    },
    candidateWorkbench: {}
  };
  const captured = captureFeeEvaluationSurface(surface);
  assert.equal(captured.openAi.callObserved, true);
});

test("memo wrapper duration without usage is not counted as an OpenAI call", () => {
  const surface = {
    feeSession: {
      calculationProgress: {
        metrics: {
          clinicalStructuring: { source: "memo", openAiProviderDurationMs: 1, usage: null },
          extractionMemo: { enabled: true, used: true, memoHitLineRatio: 1 }
        }
      },
      calculationResult: { totalPoints: 0, clinicalExtraction: {} }
    },
    candidateWorkbench: {}
  };
  const captured = captureFeeEvaluationSurface(surface);
  assert.equal(captured.openAi.callCount, 0);
  assert.equal(captured.openAi.callObserved, false);
});

test("surface normalizers omit volatile ids and preserve billing semantics", () => {
  assert.deepEqual(normalizeConfirmedLines([{ lineItem: { code: "1", name: " A  B ", quantity: 2, totalPoints: 20, lineId: "volatile" } }]), [
    { code: "1", name: "A B", quantity: 2, totalPoints: 20 }
  ]);
  assert.deepEqual(normalizeCandidateItems({
    pendingLines: [{ lineItem: { code: "2", name: "候補", totalPoints: 10 } }],
    proposals: [{ title: "区分選択", codeCandidates: ["4", "3", "4"] }]
  }), [
    { kind: "proposal", code: "", codeCandidates: ["3", "4"], title: "区分選択", points: 0 },
    { kind: "pending_line", code: "2", codeCandidates: [], title: "候補", points: 10 }
  ]);
});
