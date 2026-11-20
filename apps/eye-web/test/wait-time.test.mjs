// 待ち時間: 待ちが終わった時刻で止まり、過去の日の院内のままの受付は「未終了」にする
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitTimeOf } from "../lib/consult-flow.js";

const at = (clock) => `2026-11-20T${clock}:00.000+09:00`;
const now = Date.parse(at("10:30"));

test("今日の院内の受付は、今の状態に入った時刻から今まで", () => {
  const item = { date: "2026-11-20", status: "waiting_doctor", statusHistory: [{ status: "checked_in", at: at("09:00") }, { status: "waiting_doctor", at: at("10:00") }] };
  assert.deepEqual(waitTimeOf(item, { now, today: "2026-11-20" }), { minutes: 30, unfinished: false, since: at("10:00") });
});

test("過去の日で院内のまま残った受付は増え続けずに未終了", () => {
  const item = { date: "2026-11-19", status: "in_exam", statusHistory: [{ status: "in_exam", at: "2026-11-19T15:00:00.000+09:00" }] };
  const wait = waitTimeOf(item, { now, today: "2026-11-20" });
  assert.equal(wait.unfinished, true);
  assert.equal(wait.minutes, null);
  assert.equal(wait.since, "2026-11-19T15:00:00.000+09:00");
});

test("会計済は会計待に入った時刻から会計済になった時刻まで", () => {
  const item = { date: "2026-11-19", status: "done", statusHistory: [{ status: "checkout", at: at("09:00") }, { status: "done", at: at("09:12") }] };
  assert.deepEqual(waitTimeOf(item, { now, today: "2026-11-20" }), { minutes: 12, unfinished: false, since: at("09:00") });
  assert.equal(waitTimeOf({ status: "done", statusHistory: [{ status: "done", at: at("09:00") }] }, { now }), null);
});

test("予約済・取消・不在は待ち時間を出さない", () => {
  for (const status of ["booked", "cancelled", "absent"]) {
    assert.equal(waitTimeOf({ date: "2026-11-20", status, statusHistory: [{ status, at: at("09:00") }] }, { now, today: "2026-11-20" }), null);
  }
});

test("履歴が無ければ受付時刻から数える", () => {
  assert.equal(waitTimeOf({ date: "2026-11-20", status: "checked_in", checkedInAt: at("10:20") }, { now, today: "2026-11-20" }).minutes, 10);
});
