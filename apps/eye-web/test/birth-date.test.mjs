import assert from "node:assert/strict";
import { test } from "node:test";
import { birthDateLabel, birthDateShort, parseBirthDateInput } from "../lib/birth-date.js";

const iso = (value, options) => parseBirthDateInput(value, options).iso;
const error = (value, options) => parseBirthDateInput(value, options).error;

test("reads Japanese era dates in the usual forms", () => {
  for (const value of ["S50.1.1", "S50/1/1", "S50-1-1", "s50.1.1", "S50.01.01", "S500101", "昭和50年1月1日", "昭和50.1.1", "Ｓ５０．１．１", "S５０/１/１", " S50.1.1 ", "S.50.1.1"]) {
    assert.equal(iso(value), "1975-01-01", value);
  }
  assert.equal(iso("H1.1.8"), "1989-01-08");
  assert.equal(iso("h1/1/8"), "1989-01-08");
  assert.equal(iso("平成元年1月8日"), "1989-01-08");
  assert.equal(iso("R6.4.1"), "2024-04-01");
  assert.equal(iso("r1.5.1"), "2019-05-01");
  assert.equal(iso("令和元年5月1日"), "2019-05-01");
  assert.equal(iso("T15.12.24"), "1926-12-24");
  assert.equal(iso("t1.7.30"), "1912-07-30");
  assert.equal(iso("大正3年4月5日"), "1914-04-05");
  assert.equal(iso("M45.7.29"), "1912-07-29");
  assert.equal(iso("m30.2.3"), "1897-02-03");
  assert.equal(iso("S64.1.7"), "1989-01-07");
  assert.equal(iso("H31.4.30"), "2019-04-30");
});

test("reads western dates", () => {
  for (const value of ["19750101", "1975/1/1", "1975/01/01", "1975-01-01", "1975.1.1", "1975年1月1日", "１９７５０１０１", "１９７５／１／１"]) {
    assert.equal(iso(value), "1975-01-01", value);
  }
  assert.equal(iso("2000/2/29"), "2000-02-29");
});

test("checks era boundaries", () => {
  assert.match(error("H1.1.7"), /平成元年1月7日はありません（平成は1989年1月8日〜2019年4月30日）/u);
  assert.match(error("S64.1.8"), /昭和64年1月8日はありません/u);
  assert.match(error("R1.4.30"), /令和元年4月30日はありません（令和は2019年5月1日から）/u);
  assert.match(error("H31.5.1"), /平成31年5月1日はありません/u);
  assert.match(error("T15.12.25"), /大正15年12月25日はありません/u);
  assert.match(error("S1.12.24"), /昭和元年12月24日はありません/u);
  assert.match(error("M1.1.1"), /明治元年1月1日はありません/u);
  assert.match(error("S0.1.1"), /昭和は元年（1年）から/u);
  assert.match(error("S70.1.1"), /昭和70年1月1日はありません/u);
});

test("rejects impossible, unreadable, too early and future dates", () => {
  assert.match(error("S50.2.30"), /2月30日はありません/u);
  assert.match(error("1999/2/29"), /2月29日はありません/u);
  assert.match(error("S50.13.1"), /月は1〜12/u);
  assert.match(error("1860/1/1"), /明治より前/u);
  for (const value of ["S50", "500101", "X50.1.1", "昭和", "abc", "1975/1", "S50.1.1.1"]) {
    assert.match(error(value), /読めません/u, value);
    assert.equal(iso(value), "", value);
  }
  assert.match(error("R8.12.1", { today: "2026-11-20" }), /今日より後/u);
  assert.equal(iso("R8.11.20", { today: "2026-11-20" }), "2026-11-20");
  assert.deepEqual(parseBirthDateInput("  "), { iso: "", error: "" });
  assert.deepEqual(parseBirthDateInput(undefined), { iso: "", error: "" });
});

test("shows the parsed date with the era year, and a short era form for the field", () => {
  assert.equal(birthDateLabel("1975-01-01"), "1975年1月1日（昭和50年）");
  assert.equal(birthDateLabel("1989-01-08"), "1989年1月8日（平成元年）");
  assert.equal(birthDateLabel("1989-01-07"), "1989年1月7日（昭和64年）");
  assert.equal(birthDateLabel("2019-05-01"), "2019年5月1日（令和元年）");
  assert.equal(birthDateLabel(""), "");
  assert.equal(birthDateShort("1975-01-01"), "S50.1.1");
  assert.equal(birthDateShort("2024-04-01"), "R6.4.1");
  assert.equal(birthDateShort(""), "");
  // 短い形はそのまま読み直せる
  for (const value of ["1912-07-30", "1926-12-25", "1989-01-08", "2019-05-01", "1950-04-01"]) {
    assert.equal(iso(birthDateShort(value)), value, value);
  }
});
