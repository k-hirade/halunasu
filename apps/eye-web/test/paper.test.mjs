import assert from "node:assert/strict";
import { test } from "node:test";
import { prescriptionSerial, recipientLines } from "../lib/paper.js";
import { auditTargetLabel, staffSearchValues } from "../lib/settings.js";

test("prescription serial comes from the encounter and the finalized version", () => {
  assert.equal(prescriptionSerial("eenc_0123456789abcdef3f9a2c", "2026-11-03", 2), "20261103-3F9A2C-2");
  assert.equal(prescriptionSerial("eenc_0123456789abcdef3f9a2c", "2026-11-03", null), "20261103-3F9A2C");
  assert.equal(prescriptionSerial("", "", null), "");
});

test("recipient lines keep the old 先生 御侍史 when no honorific is stored", () => {
  assert.deepEqual(recipientLines({ institution: "県立病院", department: "眼科", doctor: "山田" }), { to: "県立病院 眼科", toSuffix: "", person: "山田 先生", suffix: "御侍史" });
  assert.deepEqual(recipientLines({ institution: "県立病院" }), { to: "県立病院", toSuffix: "", person: "ご担当 先生", suffix: "御侍史" });
  assert.deepEqual(recipientLines({}), { to: "", toSuffix: "", person: "", suffix: "御侍史" });
});

test("recipient lines follow the chosen honorific", () => {
  assert.equal(recipientLines({ doctor: "山田", honorific: "御机下" }).suffix, "御机下");
  assert.deepEqual(recipientLines({ doctor: "山田", honorific: "先生" }), { to: "", toSuffix: "", person: "山田 先生", suffix: "" });
  assert.deepEqual(recipientLines({ institution: "市役所", doctor: "佐藤", honorific: "殿" }), { to: "市役所", toSuffix: "", person: "佐藤", suffix: "殿" });
  assert.deepEqual(recipientLines({ institution: "県立病院", department: "眼科", honorific: "御中" }), { to: "県立病院 眼科", toSuffix: "御中", person: null, suffix: "" });
  assert.equal(recipientLines({ institution: "県立病院", doctor: "山田", honorific: "御中" }).person, "山田 先生");
});

test("staff print names are searchable and named in the audit log", () => {
  assert.ok(staffSearchValues({ displayName: "院長（管理者・医師）", loginId: "director", printName: "山田 太郎", eyeRoles: ["doctor"] }).includes("医師"));
  const log = { eventType: "eye.staff_profile_saved", targetType: "staff_profile", targetId: "mem_1" };
  assert.equal(auditTargetLabel(log, { actors: { mem_1: { displayName: "院長", loginId: "director" } } }), "院長");
  assert.match(auditTargetLabel(log, {}), /^ID mem_1/u);
});
