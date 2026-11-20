import { strict as assert } from "node:assert";
import test from "node:test";
import { describeFieldError, fieldLabel, fieldMessage } from "../lib/field-errors.js";

test("API field paths of the chart become Japanese labels", () => {
  assert.deepEqual(fieldLabel("content.prescriptions.1.quantity"), { path: "prescriptions.1.quantity", label: "処方 2行目の数量", short: "数量" });
  assert.equal(fieldLabel("content.prescriptions.0.days").label, "処方 1行目の日数");
  assert.equal(fieldLabel("content.prescriptions.0.name").short, "薬剤名");
  assert.equal(fieldLabel("content.orders.2.eye").label, "検査・処置 3行目の眼");
  assert.equal(fieldLabel("content.findings.od.cdRatio").label, "所見 右眼のC/D 比");
  assert.equal(fieldLabel("content.exam.os.iop").label, "検査値 左眼の眼圧");
  assert.equal(fieldLabel("sections.plan").label, "方針");
  assert.equal(fieldLabel("").label, "");
});

test("English validation messages become short Japanese instructions", () => {
  assert.equal(fieldMessage("content.prescriptions.1.quantity must be between 0 and 999", "数量"), "数量は0〜999で入れてください。");
  assert.equal(fieldMessage("x must be at most 120 characters", "用法"), "用法は120文字以内で入れてください。");
  assert.equal(fieldMessage("x must be an integer", "日数"), "日数は整数で入れてください。");
  assert.equal(fieldMessage("x must be one of: od, os", "眼"), "眼は選び直してください。");
  assert.equal(fieldMessage("something odd", "数量"), "数量の値を確認してください。");
  assert.equal(fieldMessage("日本語の説明です。", ""), "日本語の説明です。");
});

test("the top notice and the inline message for a field error", () => {
  const error = describeFieldError("content.prescriptions.1.quantity", "content.prescriptions.1.quantity must be between 0 and 999");
  assert.equal(error.path, "prescriptions.1.quantity");
  assert.equal(error.inline, "数量は0〜999で入れてください。");
  assert.equal(error.top, "処方 2行目の数量: 0〜999で入れてください。");
  assert.doesNotMatch(error.top, /[a-z]{3,}/u);
});
