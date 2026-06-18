import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPriorHistoryOptions, mergePriorHistoryIntoOptions } from "../src/server.js";

const priorSessions = [
  {
    serviceDate: "2026-06-03",
    calculationResult: { lineItems: [
      { code: "160000410", status: "candidate" },
      { code: "112007410", status: "rejected" } // 除外される
    ] }
  },
  {
    serviceDate: "2026-05-20",
    calculationResult: { lineItems: [{ code: "160000410", status: "confirmed" }] }
  }
];

test("buildPriorHistoryOptions derives same-month codes and history events", () => {
  const history = buildPriorHistoryOptions(priorSessions, { serviceDate: "2026-06-10" });
  assert.ok(history);
  assert.deepEqual(history.same_month_history_codes, ["160000410"]); // 6月分のみ、rejected除外
  assert.equal(history.procedure_history_events.length, 2); // 6/3 と 5/20
  assert.ok(history.procedure_history_events.some((e) => e.procedure_code === "160000410" && e.service_date === "2026-06-03"));
});

test("buildPriorHistoryOptions returns null with no usable history", () => {
  assert.equal(buildPriorHistoryOptions([], { serviceDate: "2026-06-10" }), null);
  assert.equal(buildPriorHistoryOptions([{ serviceDate: "" }], { serviceDate: "2026-06-10" }), null);
});

test("mergePriorHistoryIntoOptions keeps explicit history and fills missing", () => {
  const merged = mergePriorHistoryIntoOptions(
    { history: { same_month_history_codes: ["999"] }, foo: 1 },
    { same_month_history_codes: ["160000410"], procedure_history_events: [{ procedure_code: "160000410", service_date: "2026-06-03" }] }
  );
  assert.deepEqual(merged.history.same_month_history_codes, ["999"], "explicit wins");
  assert.equal(merged.history.procedure_history_events.length, 1, "missing filled from prior");
  assert.equal(merged.foo, 1, "other options preserved");
});
