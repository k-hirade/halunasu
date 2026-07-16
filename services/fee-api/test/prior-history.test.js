import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPriorHistoryOptions, mergePriorHistoryIntoOptions } from "../src/server.js";

const priorSessions = [
	  {
	    serviceDate: "2026-06-03",
	    reviewDecisions: {
	      line_judgement: { status: "approved" },
	      line_rejected_by_staff: { status: "rejected" }
	    },
	    calculationResult: { lineItems: [
	      { lineId: "judgement", code: "160000410", name: "生化学的検査判断料", status: "candidate" },
	      { code: "160072610", name: "検体検査管理加算2", status: "confirmed" },
	      { code: "114001110", name: "特定疾患処方管理加算", status: "confirmed" },
	      { lineId: "rejected_by_staff", code: "112007410", status: "candidate" },
	      { code: "112008810", status: "candidate" }
	    ] }
	  },
  {
    serviceDate: "2026-05-20",
    calculationResult: { lineItems: [{ code: "160000410", status: "confirmed" }] }
  }
];

test("buildPriorHistoryOptions derives same-month codes and history events", () => {
  const history = buildPriorHistoryOptions(priorSessions, {
    serviceDate: "2026-06-05",
    feeSettings: { historyPolicy: { historyCompleteness: "partial", defaultLookbackMonths: 12 } }
  });
  assert.ok(history);
  assert.deepEqual(history.same_month_history_codes, ["160000410", "160072610", "114001110"]); // 6月分のみ、未承認・却下は除外
  assert.deepEqual(history.same_week_history_codes, ["160000410", "160072610", "114001110"]);
  assert.deepEqual(history.already_billed_judgement_groups, ["biochemistry"]);
  assert.equal(history.already_billed_lab_management_same_month, true);
  assert.equal(history.medication_already_billed_same_month, true);
  assert.equal(history.history_completeness, "partial");
  assert.equal(history.history_lookback_months, 12);
  assert.equal(history.procedure_history_events.length, 4); // 6/3 x 3 と 5/20
  assert.ok(history.procedure_history_events.some((e) => (
    e.procedure_code === "160000410"
    && e.service_date === "2026-06-03"
    && e.quantity === 1
  )));
});

test("buildPriorHistoryOptions preserves and aggregates same-day quantities", () => {
  const history = buildPriorHistoryOptions([{
    serviceDate: "2026-06-10",
    calculationResult: { lineItems: [
      { code: "114001110", status: "confirmed", quantity: 2 },
      { code: "114001110", status: "confirmed", quantity: 3 },
      { code: "160000410", status: "confirmed" }
    ] }
  }], { serviceDate: "2026-06-10" });

  assert.deepEqual(history.procedure_history_events, [
    { procedure_code: "114001110", service_date: "2026-06-10", quantity: 5 },
    { procedure_code: "160000410", service_date: "2026-06-10", quantity: 1 }
  ]);
});

test("buildPriorHistoryOptions uses the billing week from Sunday through Saturday", () => {
  const sameWeek = buildPriorHistoryOptions([{
    serviceDate: "2026-06-07",
    calculationResult: { lineItems: [{ code: "114001110", status: "confirmed" }] }
  }], { serviceDate: "2026-06-13" });
  assert.deepEqual(sameWeek.same_week_history_codes, ["114001110"]);

  const nextWeek = buildPriorHistoryOptions([{
    serviceDate: "2026-06-06",
    calculationResult: { lineItems: [{ code: "114001110", status: "confirmed" }] }
  }], { serviceDate: "2026-06-07" });
  assert.deepEqual(nextWeek.same_week_history_codes, []);
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

test("mergePriorHistoryIntoOptions fills extended history keys", () => {
  const merged = mergePriorHistoryIntoOptions(
    { history: {} },
    {
      same_week_history_codes: ["160000410"],
      already_billed_judgement_groups: ["biochemistry"],
      already_billed_lab_management_same_month: true,
      history_completeness: "unknown"
    }
  );
  assert.deepEqual(merged.history.same_week_history_codes, ["160000410"]);
  assert.deepEqual(merged.history.already_billed_judgement_groups, ["biochemistry"]);
  assert.equal(merged.history.already_billed_lab_management_same_month, true);
  assert.equal(merged.history.history_completeness, "unknown");
});
