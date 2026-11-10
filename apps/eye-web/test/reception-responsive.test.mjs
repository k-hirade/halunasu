import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultHiddenColumns, MEDIUM_HIDDEN_COLUMNS, NARROW_HIDDEN_COLUMNS, RECEPTION_COLUMNS } from "../lib/reception-table.js";

test("wide screens show every reception column by default", () => {
  assert.deepEqual(defaultHiddenColumns(1920), []);
  assert.deepEqual(defaultHiddenColumns(1366), []);
});

test("laptops and tablets hide the department, doctor and patient memo columns until the user picks columns", () => {
  assert.deepEqual(defaultHiddenColumns(1280), [...MEDIUM_HIDDEN_COLUMNS]);
  assert.deepEqual(defaultHiddenColumns(1024), ["department", "doctor", "patientMemo"]);
  assert.deepEqual(defaultHiddenColumns(721), [...MEDIUM_HIDDEN_COLUMNS]);
});

test("phones keep the narrow set (the table becomes cards)", () => {
  assert.deepEqual(defaultHiddenColumns(720), [...NARROW_HIDDEN_COLUMNS]);
  assert.deepEqual(defaultHiddenColumns(390), [...NARROW_HIDDEN_COLUMNS]);
});

test("the default hidden columns never hide the name and are real column keys", () => {
  const keys = new Set(RECEPTION_COLUMNS.map((column) => column.key));
  for (const width of [390, 1024, 1920]) {
    for (const key of defaultHiddenColumns(width)) {
      assert.ok(keys.has(key), key);
      assert.notEqual(key, "name");
    }
  }
  // 返り値を変えても定数は変わらない
  defaultHiddenColumns(1024).push("name");
  assert.ok(!MEDIUM_HIDDEN_COLUMNS.includes("name"));
});
