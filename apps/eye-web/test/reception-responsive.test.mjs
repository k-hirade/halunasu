import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultHiddenColumns, MEDIUM_HIDDEN_COLUMNS, NARROW_HIDDEN_COLUMNS, RECEPTION_COLUMNS, sanitizeHiddenColumns, WIDE_HIDDEN_COLUMNS } from "../lib/reception-table.js";

// デジカルの受付一覧の既定の表示には生年月日の列が無い（年齢はある）。目的はデジカルでは保険の位置の列。
// 1366×768 で既定の列が横にスクロールせずに入るよう既定では隠す（絞り込みの「表示する列」で出せる）
test("wide screens hide only the birth date and purpose columns by default", () => {
  assert.deepEqual(defaultHiddenColumns(1920), ["birth", "purpose"]);
  assert.deepEqual(defaultHiddenColumns(1366), [...WIDE_HIDDEN_COLUMNS]);
});

test("every width hides the birth date by default, and it can still be chosen", () => {
  for (const width of [390, 720, 1024, 1280, 1366, 1920]) assert.ok(defaultHiddenColumns(width).includes("birth"), `${width}`);
  assert.ok(RECEPTION_COLUMNS.some((column) => column.key === "birth" && !column.fixed), "the birth date stays in the column list");
  assert.deepEqual(sanitizeHiddenColumns([]), [], "a stored choice that shows every column is kept");
});

test("laptops and tablets also hide the department, doctor and patient memo columns until the user picks columns", () => {
  assert.deepEqual(defaultHiddenColumns(1280), [...MEDIUM_HIDDEN_COLUMNS]);
  assert.deepEqual(defaultHiddenColumns(1024), ["birth", "department", "doctor", "patientMemo"]);
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
