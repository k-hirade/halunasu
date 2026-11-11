// replicate-2（受付）: 場所・患者マーク・受付編集履歴・院内掲示・検索オプションの純粋な関数
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countByLocation,
  displayBoard,
  filterByLocation,
  hasSearchOptions,
  historyTime,
  historyValueLabel,
  locationOf,
  marksOf,
  monthRange,
  receptionPrintHref,
  searchOptionsBody
} from "../lib/reception-extras.js";
import { filterAppointments, DEFAULT_FILTERS, RECEPTION_COLUMNS } from "../lib/reception-table.js";

test("the location follows the status unless the reception set one for the current status", () => {
  assert.equal(locationOf({ status: "booked" }), "", "booked patients are not in the clinic");
  assert.equal(locationOf({ status: "checked_in" }), "reception");
  assert.equal(locationOf({ status: "in_exam" }), "exam");
  assert.equal(locationOf({ status: "waiting_doctor" }), "consult");
  assert.equal(locationOf({ status: "checked_in", location: "darkroom", locationStatus: "checked_in" }), "darkroom");
  assert.equal(locationOf({ status: "in_consult", location: "darkroom", locationStatus: "checked_in" }), "consult", "moving on resets the place");
  assert.equal(locationOf({ status: "done", location: "darkroom", locationStatus: "done" }), "", "finished patients have no place");
  const rows = [{ status: "checked_in" }, { status: "in_exam" }, { status: "checked_in", location: "darkroom", locationStatus: "checked_in" }, { status: "booked" }];
  assert.deepEqual(countByLocation(rows), { reception: 1, exam: 1, darkroom: 1, consult: 0, treatment: 0 });
  assert.equal(filterByLocation(rows, "darkroom").length, 1);
  assert.equal(filterByLocation(rows, "").length, 4);
});

test("marks keep the clinic's order and skip removed definitions", () => {
  const definitions = [{ key: "hearing", label: "難聴", symbol: "耳" }, { key: "wheelchair", label: "車椅子", symbol: "車" }];
  assert.deepEqual(marksOf(["wheelchair", "gone"], definitions).map((mark) => mark.symbol), ["車"]);
  assert.deepEqual(marksOf([], definitions), []);
});

test("the reception table starts with marks and shows the place after the status", () => {
  assert.deepEqual(RECEPTION_COLUMNS.slice(0, 6).map((column) => column.key), ["marks", "no", "time", "checkin", "status", "location"]);
  const rows = [{ status: "checked_in", note: "", receptionLabels: ["紹介状あり"] }, { status: "checked_in", note: "紹介" }];
  assert.equal(filterAppointments(rows, { ...DEFAULT_FILTERS, receptionMemo: "紹介状" }).length, 1, "the memo filter also finds labels");
});

test("history labels, times, print links and the board", () => {
  assert.equal(historyValueLabel("location", "darkroom"), "暗室");
  assert.equal(historyValueLabel("time", ""), "（なし）");
  assert.equal(historyValueLabel("doctorMemberId", "m1", { doctorName: () => "医師 一郎" }), "医師 一郎");
  assert.equal(historyValueLabel("date", "2026-11-11"), "2026/11/11");
  assert.equal(historyTime("2026-11-11T00:05:00.000Z"), "2026/11/11 09:05");
  assert.equal(historyTime(""), "");
  assert.equal(receptionPrintHref("eapt_1", "booking", { memo: true }), "/reception/print/eapt_1?kind=booking&memo=1");
  assert.equal(receptionPrintHref("eapt_1", "visit"), "/reception/print/eapt_1?kind=visit");
  const board = displayBoard([
    { queueNumber: 3, status: "waiting_doctor", department: "眼科" },
    { queueNumber: 1, status: "waiting_doctor", department: "眼科" },
    { queueNumber: 2, status: "in_consult", department: "眼科" },
    { queueNumber: 4, status: "waiting_doctor", department: "内科" },
    { queueNumber: null, status: "booked" }
  ], "眼科");
  assert.deepEqual(board, { waiting: ["001", "003"], calling: ["002"] });
});

test("search options send only filled fields", () => {
  assert.deepEqual(searchOptionsBody({ history: " 点眼 ", historyAll: true, diagnosis: "", diagnosisAll: true, phone: "" }), { history: "点眼", historyAll: true });
  assert.equal(hasSearchOptions({ visitFrom: "", phone: " " }), false);
  assert.deepEqual(monthRange("2026-11-11"), { visitFrom: "2026-11-01", visitTo: "2026-11-30" });
  assert.deepEqual(monthRange("2026-01-15", -1), { visitFrom: "2025-12-01", visitTo: "2025-12-31" });
});
