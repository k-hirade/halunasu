import assert from "node:assert/strict";
import { test } from "node:test";
import { diffChips, diffItems, groupByCategory, itemSummary } from "../lib/billing-diff.js";

const exam = (name, extra = {}) => ({ category: "検査", code: name, name, eye: "ou", quantity: 1, unit: "回", days: null, route: "", usage: "", note: "", ...extra });
const drop = (name, extra = {}) => ({ category: "処方", code: "", name, eye: "ou", quantity: 2, unit: "本", days: null, route: "院外", usage: "1日1回", note: "", ...extra });

test("summarises items by category in a fixed order, skipping empty ones", () => {
  assert.equal(itemSummary([drop("A"), exam("B"), exam("C"), { category: "文書", name: "診断書" }]), "検査2 処方1 文書1");
  assert.equal(itemSummary([]), "");
  assert.deepEqual(groupByCategory([drop("A"), exam("B")]).map((group) => group.category), ["検査", "処方"]);
});

test("diffs added, removed, changed and unchanged items without relying on order", () => {
  const previous = [drop("ラタノプロスト"), exam("眼圧検査"), exam("視力検査")];
  const current = [exam("視力検査"), exam("眼圧検査", { eye: "ou", note: "再検" }), drop("チモロール")];
  const rows = diffItems(previous, current);
  assert.deepEqual(rows.map((row) => `${row.kind}:${(row.current || row.previous).name}`), [
    "same:視力検査", "changed:眼圧検査", "added:チモロール", "removed:ラタノプロスト"
  ]);
  assert.deepEqual(diffChips(rows).map((chip) => chip.label), ["~眼圧検査", "+チモロール", "−ラタノプロスト"]);
});

test("pairs duplicates of the same drug by exact match first, then counts the rest", () => {
  const previous = [drop("ヒアレイン", { usage: "1日4回" }), drop("ヒアレイン", { usage: "1日2回" })];
  const current = [drop("ヒアレイン", { usage: "1日2回" })];
  const rows = diffItems(previous, current);
  assert.deepEqual(rows.map((row) => `${row.kind}:${(row.current || row.previous).usage}`), ["same:1日2回", "removed:1日4回"]);
  assert.deepEqual(diffItems([], [drop("A")]).map((row) => row.kind), ["added"]);
  assert.deepEqual(diffItems([drop("A", { eye: "od" })], [drop("A", { eye: "os" })]).map((row) => row.kind), ["added", "removed"], "a different eye is a different item");
  assert.deepEqual(diffItems([exam("A", { days: null })], [exam("A", { days: undefined })]).map((row) => row.kind), ["same"]);
});
