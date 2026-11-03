import { strict as assert } from "node:assert";
import { test } from "node:test";
import { acceptNumber, normalizeNumberText, readNumber } from "../lib/exam-number.js";
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
