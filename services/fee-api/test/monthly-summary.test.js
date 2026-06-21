import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMonthlyBulkCandidatePlan, buildMonthlyClaimSummary, receiptAnnotationContext } from "../src/server.js";

const sessions = [
  { feeSessionId: "f1", patientId: "p1", patientSnapshot: { displayName: "山田" }, serviceDate: "2026-06-03", claimMonth: "2026-06", status: "needs_review", diagnoses: [{ name: "急性上気道炎" }], calculationSummary: { totalPoints: 100, reviewLineCount: 2 }, monthlyClaimWork: { status: "doctor_confirming", note: "医師へ確認中", diagnosisCandidates: [{ name: "急性上気道炎" }], diagnosisRequestReason: "病名確認が必要", doctorName: "山田医師", collectedResult: "急性上気道炎" } },
  { feeSessionId: "f2", patientId: "p1", patientSnapshot: { displayName: "山田" }, serviceDate: "2026-06-20", claimMonth: "2026-06", status: "calculated", diagnoses: [{ name: "急性上気道炎" }], calculationSummary: { totalPoints: 50 }, monthlyClaimWork: { status: "ready_for_claim" }, receiptAnnotations: { comments: [{ status: "confirmed", text: "コメント本文" }], symptomDetails: [{ status: "draft", text: "症状詳記下書き" }] } },
  { feeSessionId: "f3", patientId: "p2", patientSnapshot: { displayName: "佐藤" }, serviceDate: "2026-06-10", claimMonth: "2026-06", status: "calculated", calculationSummary: { totalPoints: 300 } },
  { feeSessionId: "f4", patientId: "p1", serviceDate: "2026-05-30", claimMonth: "2026-05", calculationSummary: { totalPoints: 999 } }
];

test("buildMonthlyClaimSummary groups by patient within the requested month", () => {
  const summary = buildMonthlyClaimSummary(sessions, { claimMonth: "2026-06" });
  assert.equal(summary.claimMonth, "2026-06");
  assert.equal(summary.patientCount, 2);
  assert.equal(summary.sessionCount, 3); // 5月分(f4)は除外
  assert.equal(summary.totalPoints, 450);
  // 要対応がある患者が先頭
  assert.equal(summary.patients[0].patientId, "p1");
  assert.equal(summary.patients[0].needsReviewCount, 2);
  const yamada = summary.patients.find((p) => p.patientId === "p1");
  assert.equal(yamada.sessionCount, 2);
  assert.equal(yamada.totalPoints, 150);
  assert.equal(yamada.patientName, "山田");
  assert.equal(yamada.readyForClaim, false);
  assert.equal(summary.missingDiagnosisCount, 1);
  assert.equal(summary.readyForClaimCount, 0);
  assert.equal(summary.blockedCount, 3);
  assert.equal(summary.diagnosisRequestCandidateCount, 1);
  assert.equal(summary.doctorConfirmationCandidateCount, 1);
  assert.equal(summary.pendingReceiptAnnotationCount, 1);
  assert.equal(summary.confirmedReceiptAnnotationCount, 1);
  assert.equal(summary.workStatusCounts.doctor_confirming, 1);
  assert.equal(summary.workStatusCounts.ready_for_claim, 1);
  assert.equal(yamada.primaryWorkStatus, "doctor_confirming");
  assert.equal(yamada.doctorConfirmationCandidate, true);
  assert.equal(yamada.sessions[0].monthlyClaimWork.status, "doctor_confirming");
  assert.equal(yamada.sessions[0].monthlyClaimWork.diagnosisCandidates[0].name, "急性上気道炎");
  assert.equal(yamada.sessions[0].monthlyClaimWork.diagnosisRequestReason, "病名確認が必要");
  assert.equal(yamada.sessions[0].monthlyClaimWork.doctorName, "山田医師");
  assert.equal(yamada.sessions[0].monthlyClaimWork.collectedResult, "急性上気道炎");
  assert.equal(yamada.sessions[1].receiptAnnotations.comments[0].text, "コメント本文");
  assert.equal(yamada.sessions[1].readiness.pendingReceiptAnnotationCount, 1);
  assert.equal(yamada.sessions[1].readiness.confirmedReceiptAnnotationCount, 1);
  assert.equal(yamada.sessions[0].readiness.issues.some((issue) => issue.label === "要確認"), true);
  // 受診日昇順
  assert.deepEqual(yamada.sessions.map((s) => s.serviceDate), ["2026-06-03", "2026-06-20"]);
});

test("buildMonthlyClaimSummary without month aggregates all", () => {
  const summary = buildMonthlyClaimSummary(sessions, {});
  assert.equal(summary.claimMonth, null);
  assert.equal(summary.sessionCount, 4);
  assert.equal(summary.totalPoints, 1449);
});

test("buildMonthlyClaimSummary handles empty input", () => {
  const summary = buildMonthlyClaimSummary([], { claimMonth: "2026-06" });
  assert.equal(summary.patientCount, 0);
  assert.equal(summary.totalPoints, 0);
  assert.deepEqual(summary.patients, []);
});

test("receiptAnnotationContext exports only confirmed comments and symptom details", () => {
  const context = receiptAnnotationContext({
    receiptAnnotations: {
      comments: [
        { status: "confirmed", shinryoIdentification: "60", code: "830000001", text: "確定コメント" },
        { status: "draft", shinryoIdentification: "60", code: "830000002", text: "下書きコメント" }
      ],
      symptomDetails: [
        { status: "confirmed", kubun: "01", text: "確定詳記" },
        { status: "rejected", kubun: "01", text: "不要詳記" }
      ]
    }
  });

  assert.deepEqual(context.comments, [{ shinryoIdentification: "60", code: "830000001", text: "確定コメント" }]);
  assert.deepEqual(context.symptomDetails, [{ kubun: "01", text: "確定詳記" }]);
});

test("buildMonthlyBulkCandidatePlan extracts uncalculated failed and stale sessions", () => {
  const plan = buildMonthlyBulkCandidatePlan([
    { feeSessionId: "uncalc", patientId: "p1", facilityId: "fac", patientSnapshot: { displayName: "山田" }, serviceDate: "2026-06-01", claimMonth: "2026-06", status: "ready", clinicalText: "発熱" },
    { feeSessionId: "failed", patientId: "p2", facilityId: "fac", serviceDate: "2026-06-02", claimMonth: "2026-06", status: "failed", clinicalText: "咳" },
    { feeSessionId: "stale", patientId: "p3", facilityId: "fac", serviceDate: "2026-06-03", claimMonth: "2026-06", status: "calculated", clinicalText: "変更後", calculationResult: { inputSnapshot: { clinicalText: "変更前" } } },
    { feeSessionId: "done", patientId: "p4", facilityId: "fac", serviceDate: "2026-06-04", claimMonth: "2026-06", status: "calculated", clinicalText: "同じ", calculationResult: { inputSnapshot: { clinicalText: "同じ" } } },
    { feeSessionId: "other_month", patientId: "p5", facilityId: "fac", serviceDate: "2026-05-04", claimMonth: "2026-05", status: "ready", clinicalText: "対象外" }
  ], { claimMonth: "2026-06" });

  assert.equal(plan.targetCount, 3);
  assert.equal(plan.runnableCount, 3);
  assert.deepEqual(plan.reasonCounts, { uncalculated: 1, failed: 1, clinical_text_changed: 1 });
  assert.deepEqual(plan.targets.map((target) => target.feeSessionId).sort(), ["failed", "stale", "uncalc"]);
});
