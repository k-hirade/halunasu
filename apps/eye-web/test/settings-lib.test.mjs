import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateEyeDropBottles } from "@halunasu/eye-core";
import { auditRangeFor, auditTargetLabel, daysPerBottle, matchesSearch, normalizeSearch, setContentText } from "../lib/settings.js";

test("search treats hiragana and katakana, full and half width alike", () => {
  assert.equal(normalizeSearch("ラタノプロスト"), "らたのぷろすと");
  assert.equal(normalizeSearch("ﾗﾀﾉ"), "らたの");
  assert.ok(matchesSearch("らたの", ["ラタノプロスト点眼液0.005%"]));
  assert.ok(matchesSearch("ＯＣＴ", ["oct（網膜）"]));
  assert.ok(matchesSearch("  ", ["anything"]));
  assert.equal(matchesSearch("チモロール", ["ラタノプロスト", null, undefined]), false);
});

test("days per bottle agrees with the chart's bottle calculation", () => {
  const result = daysPerBottle({ timesPerDay: 1, eye: "ou", dropsPerBottle: 80 });
  assert.equal(result.days, 40);
  assert.equal(calculateEyeDropBottles({ timesPerDay: 1, eye: "ou", days: result.days, dropsPerBottle: 80 }).bottles, 1);
  assert.equal(calculateEyeDropBottles({ timesPerDay: 1, eye: "ou", days: result.days + 1, dropsPerBottle: 80 }).bottles, 2);
  assert.equal(daysPerBottle({ timesPerDay: 4, eye: "od" }).dropsPerBottle, 100, "empty drops fall back to the default");
  assert.equal(daysPerBottle({ timesPerDay: 4, eye: "od" }).days, 25);
  assert.equal(daysPerBottle({ timesPerDay: null, eye: "ou", dropsPerBottle: 80 }), null);
  assert.equal(daysPerBottle({ timesPerDay: 1, eye: "od", dropsPerBottle: 2000 }).capped, true);
  assert.equal(daysPerBottle({ timesPerDay: 6, eye: "ou", dropsPerBottle: 5 }).days, 0);
});

test("audit target labels resolve setting names and summarise payloads", () => {
  const masters = { drugPresets: [{ presetId: "edp_1", name: "ラタノプロスト" }], orderSets: [{ setId: "eset_1", name: "緑内障 定期" }], phrases: [{ phraseId: "ephr_1", label: "", text: "点眼継続。" }] };
  assert.equal(auditTargetLabel({ targetType: "drug_preset", targetId: "edp_1" }, masters), "ラタノプロスト");
  assert.equal(auditTargetLabel({ targetType: "order_set", targetId: "eset_1" }, masters), "緑内障 定期");
  assert.equal(auditTargetLabel({ targetType: "phrase", targetId: "ephr_1" }, masters), "点眼継続。");
  assert.match(auditTargetLabel({ targetType: "drug_preset", targetId: "edp_gone" }, masters), /^ID edp_gone/u);
  assert.equal(auditTargetLabel({ eventType: "eye.clinic_exported", safePayload: { patientCount: 12 } }), "患者 12人");
  assert.equal(auditTargetLabel({ eventType: "eye.billing_handed_off", safePayload: { date: "2026-11-03", encounterCount: 4 } }), "11/03分・4件");
  assert.equal(auditTargetLabel({ eventType: "eye.billing_exported", targetType: "billing_day", targetId: "2026-11-02", safePayload: { encounterCount: 2 } }), "11/02分・2件");
  assert.equal(auditTargetLabel({ eventType: "eye.appointment_status_changed", safePayload: { from: "checked_in", to: "waiting_doctor" } }), "受付済 → 診察待ち");
  assert.equal(auditTargetLabel({ eventType: "eye.exam_confirmed", safePayload: { eye: "both" } }), "両眼");
  assert.equal(auditTargetLabel({ eventType: "eye.chart_viewed" }), "");
});

test("set contents and audit ranges", () => {
  assert.equal(setContentText({ prescriptions: [{}, {}], orders: [{}], plan: "x" }), "処方2 検査1 方針");
  assert.equal(setContentText({ prescriptions: [], orders: [], plan: "" }), "");
  assert.deepEqual(auditRangeFor("today", "2026-11-03"), { from: "2026-11-03", to: "2026-11-03" });
  assert.deepEqual(auditRangeFor("week", "2026-11-03"), { from: "2026-10-28", to: "2026-11-03" });
  assert.deepEqual(auditRangeFor("month", "2026-03-01"), { from: "2026-01-31", to: "2026-03-01" });
  assert.equal(auditRangeFor("custom", "2026-11-03"), null);
});
