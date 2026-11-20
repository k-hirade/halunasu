import { strict as assert } from "node:assert";
import { test } from "node:test";
import { acceptNumber, checkNumber, normalizeNumberText, readDiopter, readNumber } from "../lib/exam-number.js";
import { formatDiopter, formatShortDate } from "../lib/format.js";

test("a lone sign or trailing dot is a partial entry, not an empty value", () => {
  for (const text of ["-", "+", ".", "-.", "-1.", "1."]) {
    assert.equal(readNumber(text).partial, true, text);
    assert.equal(readNumber(text).value, null, text);
  }
  assert.equal(readNumber("").empty, true);
  assert.equal(readNumber("  ").empty, true);
});

test("numbers are read exactly as typed (no rounding, no sign flip)", () => {
  assert.equal(readNumber("-1.25").value, -1.25);
  assert.equal(readNumber("+0.50").value, 0.5);
  assert.equal(readNumber("2").value, 2);
  assert.equal(readNumber("-1.2").value, -1.2);
  assert.equal(readNumber(".75").value, 0.75);
  assert.equal(readNumber("-0").value === 0, true);
});

test("full-width digits and minus signs are normalised", () => {
  assert.equal(normalizeNumberText("−１．２５"), "-1.25");
  assert.equal(normalizeNumberText("ー２"), "-2");
  assert.equal(readNumber("－０．５").value, -0.5);
});

test("non-numbers are invalid", () => {
  for (const text of ["abc", "1-", "--1", "1.2.3", "1e3", "n.d."]) assert.equal(readNumber(text).invalid, true, text);
});

test("range and integer checks match the server validation", () => {
  assert.equal(acceptNumber(readNumber("-40"), { min: -40, max: 40 }), true);
  assert.equal(acceptNumber(readNumber("-40.25"), { min: -40, max: 40 }), false);
  assert.equal(acceptNumber(readNumber("180"), { min: 0, max: 180, integer: true }), true);
  assert.equal(acceptNumber(readNumber("181"), { min: 0, max: 180, integer: true }), false);
  assert.equal(acceptNumber(readNumber("90.5"), { min: 0, max: 180, integer: true }), false);
  assert.equal(acceptNumber(readNumber("-"), {}), false);
});

test("diopters are shown signed with two decimals", () => {
  assert.equal(formatDiopter(-1), "-1.00");
  assert.equal(formatDiopter(0.5), "+0.50");
  assert.equal(formatDiopter(0), "0.00");
  assert.equal(formatDiopter(-0), "0.00");
  assert.equal(formatDiopter(-1.25), "-1.25");
  assert.equal(formatDiopter(null), "");
});

test("short dates carry the weekday", () => {
  assert.equal(formatShortDate("2026-11-03"), "11/03(火)");
  assert.equal(formatShortDate(""), "");
});

test("sphere/cylinder without a decimal point and with 3+ digits are hundredths", () => {
  assert.deepEqual(readDiopter("-125"), { value: -1.25, converted: true });
  assert.deepEqual(readDiopter("+075"), { value: 0.75, converted: true });
  assert.deepEqual(readDiopter("-1250"), { value: -12.5, converted: true });
  assert.equal(readDiopter("ー１２５").value, -1.25);
  // 1〜2 桁と小数点つきは D のまま
  assert.equal(readDiopter("-12").value, -12);
  assert.equal(readDiopter("-1").value, -1);
  assert.equal(readDiopter("-1.25").value, -1.25);
  assert.equal(readDiopter("-12").converted, undefined);
  assert.equal(readDiopter("-").partial, true);
});

const DIOPTER = { min: -40, max: 40, step: 0.25, read: readDiopter };
const AXIS = { min: 0, max: 180, integer: true };
const IOP = { min: 0, max: 90 };

test("typed values are checked as a whole, not saved as an in-range prefix", () => {
  assert.deepEqual(checkNumber("-125", DIOPTER), { ok: true, value: -1.25, converted: true });
  assert.deepEqual(checkNumber("+075", DIOPTER), { ok: true, value: 0.75, converted: true });
  assert.equal(checkNumber("200", AXIS).ok, false);
  assert.equal(checkNumber("200", AXIS).message, "0〜180の範囲で入力");
  assert.equal(checkNumber("150", IOP).message, "0〜90の範囲で入力");
  assert.equal(checkNumber("-50", DIOPTER).message, "-40〜40の範囲で入力");
  assert.equal(checkNumber("abc", IOP).message, "数値で入力");
  assert.equal(checkNumber("90.5", AXIS).message, "整数で入力");
  assert.deepEqual(checkNumber("", IOP), { ok: true, value: null });
});

test("errors that more typing can fix are quiet while typing and shown when leaving the field", () => {
  // 0.25 刻み: 「-1.2」は「-1.25」の途中
  assert.deepEqual(checkNumber("-1.2", DIOPTER), { ok: false, message: null });
  assert.equal(checkNumber("-1.2", { ...DIOPTER, final: true }).message, "0.25刻みで入力");
  // 正の下限: 「3」は「30」の途中
  assert.deepEqual(checkNumber("3", { min: 30, max: 70 }), { ok: false, message: null });
  assert.equal(checkNumber("3", { min: 30, max: 70, final: true }).message, "30〜70の範囲で入力");
  // 符号だけ・末尾の点
  assert.deepEqual(checkNumber("-", DIOPTER), { ok: false, message: null });
  assert.equal(checkNumber("-", { ...DIOPTER, final: true }).message, "数値で入力");
  assert.deepEqual(checkNumber("-1.", { ...DIOPTER, final: true }), { ok: true, value: -1, converted: false });
  assert.equal(checkNumber("-1.25", { ...DIOPTER, final: true }).ok, true);
});
