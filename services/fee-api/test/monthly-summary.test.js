import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMonthlyClaimSummary } from "../src/server.js";

const sessions = [
  { feeSessionId: "f1", patientId: "p1", patientSnapshot: { displayName: "山田" }, serviceDate: "2026-06-03", claimMonth: "2026-06", status: "needs_review", calculationSummary: { totalPoints: 100 } },
  { feeSessionId: "f2", patientId: "p1", patientSnapshot: { displayName: "山田" }, serviceDate: "2026-06-20", claimMonth: "2026-06", status: "calculated", calculationSummary: { totalPoints: 50 } },
  { feeSessionId: "f3", patientId: "p2", patientSnapshot: { displayName: "佐藤" }, serviceDate: "2026-06-10", claimMonth: "2026-06", status: "calculated", calculationSummary: { totalPoints: 300 } },
  { feeSessionId: "f4", patientId: "p1", serviceDate: "2026-05-30", claimMonth: "2026-05", calculationSummary: { totalPoints: 999 } }
];

test("buildMonthlyClaimSummary groups by patient within the requested month", () => {
  const summary = buildMonthlyClaimSummary(sessions, { claimMonth: "2026-06" });
  assert.equal(summary.claimMonth, "2026-06");
  assert.equal(summary.patientCount, 2);
  assert.equal(summary.sessionCount, 3); // 5月分(f4)は除外
  assert.equal(summary.totalPoints, 450);
  // 合計点数の降順 → 佐藤(300)が先頭
  assert.equal(summary.patients[0].patientId, "p2");
  assert.equal(summary.patients[0].totalPoints, 300);
  const yamada = summary.patients.find((p) => p.patientId === "p1");
  assert.equal(yamada.sessionCount, 2);
  assert.equal(yamada.totalPoints, 150);
  assert.equal(yamada.patientName, "山田");
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
