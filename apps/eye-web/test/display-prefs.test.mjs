import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrangeItems,
  DEFAULT_DISPLAY_PREFS,
  displayPrefsKey,
  LEFT_TAB_IDS,
  moveItem,
  NAV_IDS,
  normalizeDisplayPrefs,
  readDisplayPrefs,
  setItemHidden,
  TEXT_SIZE_BOOT_SCRIPT,
  TEXT_SIZE_STORAGE_KEY,
  writeDisplayPrefs
} from "../lib/display-prefs.js";
import { readFileSync } from "node:fs";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } };
}

test("the left tab ids follow LEFT_TABS in encounter-panels.js", () => {
  const source = readFileSync(new URL("../components/encounter-panels.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("export const LEFT_TABS"), source.indexOf("];", source.indexOf("export const LEFT_TABS")));
  assert.deepEqual(LEFT_TAB_IDS, [...block.matchAll(/\{ id: "([a-z]+)"/gu)].map((match) => match[1]));
});

test("defaults keep the current order with everything shown", () => {
  const prefs = normalizeDisplayPrefs(null);
  assert.deepEqual(prefs.nav, { order: [...NAV_IDS], hidden: [] });
  assert.deepEqual(prefs.leftTabs, { order: [...LEFT_TAB_IDS], hidden: [] });
  assert.equal(prefs.guide, true);
  assert.equal(prefs.textSize, "standard");
  assert.deepEqual(normalizeDisplayPrefs(DEFAULT_DISPLAY_PREFS), prefs);
});

test("normalize drops unknown ids and re-adds missing ones near their default place", () => {
  const prefs = normalizeDisplayPrefs({ nav: { order: ["billing", "ghost", "reception", "billing"], hidden: ["ghost", "dark", "dark"] }, textSize: "huge", guide: false });
  assert.equal(prefs.nav.order.length, NAV_IDS.length);
  assert.equal(prefs.nav.order[0], "billing");
  assert.ok(prefs.nav.order.indexOf("billing") < prefs.nav.order.indexOf("reception"));
  // 足りない項目は既定で前にある項目の後ろ（list は reception の後ろ、settings は billing の後ろ）
  assert.equal(prefs.nav.order.indexOf("list"), prefs.nav.order.indexOf("reception") + 1);
  assert.equal(prefs.nav.order.indexOf("settings"), prefs.nav.order.indexOf("billing") + 1);
  assert.deepEqual(prefs.nav.hidden, ["dark"]);
  assert.equal(prefs.textSize, "standard");
  assert.equal(prefs.guide, false);
});

test("at least one left tab stays visible", () => {
  const prefs = normalizeDisplayPrefs({ leftTabs: { hidden: [...LEFT_TAB_IDS] } });
  assert.deepEqual(prefs.leftTabs.hidden.includes("history"), false);
  assert.equal(prefs.leftTabs.hidden.length, LEFT_TAB_IDS.length - 1);
});

test("arrange keeps only allowed items, in the chosen order, without hidden ones", () => {
  const items = [{ id: "reception" }, { id: "list" }, { id: "schedule" }, { id: "billing" }, { id: "dark" }];
  const list = { order: ["billing", "audit", "dark", "reception", "list", "schedule"], hidden: ["schedule", "audit"] };
  assert.deepEqual(arrangeItems(items, list).map((item) => item.id), ["billing", "dark", "reception", "list"]);
  // 並びに無い項目は最後に出す
  assert.deepEqual(arrangeItems([...items, { id: "new" }], list).map((item) => item.id), ["billing", "dark", "reception", "list", "new"]);
});

test("move swaps with the visible neighbour and skips items the user cannot see", () => {
  const list = { order: ["reception", "audit", "list"], hidden: [] };
  const moved = moveItem(list, "list", -1, ["reception", "list"]);
  assert.deepEqual(moved.order, ["list", "audit", "reception"]);
  assert.equal(moveItem(list, "reception", -1, ["reception", "list"]), list, "the first item does not move up");
  assert.deepEqual(setItemHidden(list, "list", true).hidden, ["list"]);
  assert.deepEqual(setItemHidden({ ...list, hidden: ["list"] }, "list", false).hidden, []);
});

test("stored per organization and member, and broken storage falls back to defaults", () => {
  assert.equal(displayPrefsKey("", "m1"), "");
  const key = displayPrefsKey("org1", "m1");
  assert.notEqual(key, displayPrefsKey("org1", "m2"));
  const storage = memoryStorage();
  writeDisplayPrefs(key, { textSize: "large", leftTabs: { hidden: ["files"] } }, storage);
  assert.equal(storage.data[TEXT_SIZE_STORAGE_KEY], "large", "the text size is mirrored for the boot script");
  assert.deepEqual(readDisplayPrefs(key, storage).leftTabs.hidden, ["files"]);
  assert.equal(readDisplayPrefs(displayPrefsKey("org1", "m2"), storage).textSize, "standard");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(readDisplayPrefs(key, broken), normalizeDisplayPrefs(null));
  assert.equal(writeDisplayPrefs(key, { textSize: "large" }, broken).textSize, "large");
  assert.deepEqual(readDisplayPrefs(key, memoryStorage({ [key]: "{not json" })), normalizeDisplayPrefs(null));
});

test("the boot script sets the text size before paint and survives blocked storage", () => {
  const run = (getItem) => {
    const documentElement = { dataset: {} };
    new Function("window", "document", TEXT_SIZE_BOOT_SCRIPT)({ localStorage: { getItem } }, { documentElement });
    return documentElement.dataset.textSize;
  };
  assert.equal(run(() => "large"), "large");
  assert.equal(run(() => "standard"), undefined);
  assert.equal(run(() => { throw new Error("blocked"); }), undefined);
});
