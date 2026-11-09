import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateEyeDropBottles } from "@halunasu/eye-core";
import { auditRangeFor, auditTargetLabel, buildFolderTree, daysPerBottle, descendantFolderIds, facilityBaseValue, flattenFolderTree, folderPathText, matchesSearch, memberRoleText, moveSet, normalizeSearch, setContentText, setsInFolder, sortMembers } from "../lib/settings.js";

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
  assert.equal(auditTargetLabel({ eventType: "eye.appointment_status_changed", safePayload: { from: "checked_in", to: "waiting_doctor" } }), "受付中 → 診察待");
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

test("set folders form a tree with counts, survive broken parents and keep their order", () => {
  const folders = [
    { folderId: "f1", name: "緑内障", parentId: "", sortOrder: 1 },
    { folderId: "f2", name: "点眼", parentId: "f1", sortOrder: 0 },
    { folderId: "f0", name: "白内障", parentId: "", sortOrder: 0 },
    { folderId: "fx", name: "迷子", parentId: "missing", sortOrder: 2 },
    { folderId: "fa", name: "輪A", parentId: "fb", sortOrder: 3 },
    { folderId: "fb", name: "輪B", parentId: "fa", sortOrder: 4 },
    { folderId: "fz", name: "停止", parentId: "", active: false }
  ];
  const sets = [
    { setId: "s1", name: "定期", folderId: "f2", sortOrder: 1 },
    { setId: "s2", name: "初回", folderId: "f2", sortOrder: 0 },
    { setId: "s3", name: "術前", folderId: "f0" },
    { setId: "s4", name: "なし", folderId: "" },
    { setId: "s5", name: "消えたフォルダ", folderId: "fz" },
    { setId: "s6", name: "停止中", folderId: "f2", sortOrder: 2, active: false }
  ];
  const tree = buildFolderTree(folders, sets);
  assert.deepEqual(tree.roots.map((node) => node.folder.name).slice(0, 3), ["白内障", "緑内障", "迷子"]);
  const glaucoma = tree.roots.find((node) => node.folder.folderId === "f1");
  assert.equal(glaucoma.setCount, 0);
  assert.equal(glaucoma.totalCount, 2, "counts include sub folders and skip stopped sets");
  assert.equal(glaucoma.children[0].depth, 1);
  assert.ok(tree.roots.some((node) => node.folder.folderId === "fa") && tree.roots.some((node) => node.folder.folderId === "fb"), "folders in a cycle stay visible");
  assert.equal(tree.unfiled, 2, "sets without a folder or in a stopped folder are unfiled");
  assert.deepEqual(flattenFolderTree(tree.roots, new Set(["f1"])).map((node) => node.folder.folderId).slice(0, 3), ["f0", "f1", "fx"]);
  assert.deepEqual([...descendantFolderIds(folders, "f1")].sort(), ["f1", "f2"]);
  assert.equal(folderPathText(folders, "f2"), "緑内障 / 点眼");
  assert.deepEqual(setsInFolder(sets, folders, "f2").map((set) => set.setId), ["s2", "s1", "s6"]);
  assert.deepEqual(setsInFolder(sets, folders, "").map((set) => set.setId), ["s4", "s5"]);
  const ordered = setsInFolder(sets, folders, "f2").filter((set) => set.active !== false);
  assert.deepEqual(moveSet(ordered, "s1", -1).map(({ set, sortOrder }) => [set.setId, sortOrder]), [["s1", 0], ["s2", 1]]);
  assert.deepEqual(moveSet(ordered, "s2", -1), [], "the first set cannot move up");
});

test("facility base values and member roles read like the paper", () => {
  const facility = { displayName: "あさおか眼科", prefecture: "東京都", address: { city: "千代田区", line1: "1-1", postalCode: "100-0001" }, phone: "03" };
  assert.equal(facilityBaseValue(facility, "name"), "あさおか眼科");
  assert.equal(facilityBaseValue(facility, "address"), "東京都 千代田区 1-1");
  assert.equal(facilityBaseValue(facility, "postalCode"), "100-0001");
  assert.equal(facilityBaseValue(facility, "fax"), "");
  assert.equal(facilityBaseValue(null, "name"), "");
  assert.equal(memberRoleText(["admin", "doctor"]), "医師");
  assert.equal(memberRoleText(["admin"]), "管理のみ");
  assert.deepEqual(sortMembers([{ loginId: "b", eyeRoles: ["medical_clerk"] }, { loginId: "a", eyeRoles: ["doctor"] }]).map((item) => item.loginId), ["a", "b"]);
});
