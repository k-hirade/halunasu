import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eraYearLabel,
  formatBirthDateJp,
  normalizeKanaName,
  parseBirthDateQuery,
  patientSearchVariants,
  toHiragana,
  toKatakana
} from "../src/index.js";

test("converts between hiragana and katakana without touching other characters", () => {
  assert.equal(toKatakana("みほん はなこ"), "ミホン ハナコ");
  assert.equal(toKatakana("ゔぁ・ゝ"), "ヴァ・ヽ");
  assert.equal(toKatakana("見本 花子 D003"), "見本 花子 D003");
  assert.equal(toHiragana("ミホン ハナコ"), "みほん はなこ");
  assert.equal(toHiragana("ー"), "ー");
});

test("normalizes a kana name for registration", () => {
  assert.equal(normalizeKanaName(" ﾐﾎﾝ　はなこ "), "ミホン ハナコ");
  assert.equal(normalizeKanaName("もぎ   かずこ"), "モギ カズコ");
  assert.equal(normalizeKanaName(""), "");
});

test("returns unique search variants", () => {
  assert.deepEqual(patientSearchVariants("もぎ"), ["もぎ", "モギ"]);
  assert.deepEqual(patientSearchVariants("モギ"), ["モギ", "もぎ"]);
  assert.deepEqual(patientSearchVariants("D003"), ["D003"]);
  assert.deepEqual(patientSearchVariants("  "), []);
});

test("parses birth date queries in western and Japanese era forms", () => {
  assert.equal(parseBirthDateQuery("19500304"), "1950-03-04");
  assert.equal(parseBirthDateQuery("1950/3/4"), "1950-03-04");
  assert.equal(parseBirthDateQuery("1950-03-04"), "1950-03-04");
  assert.equal(parseBirthDateQuery("１９５０．３．４"), "1950-03-04");
  assert.equal(parseBirthDateQuery("1950年3月4日"), "1950-03-04");
  assert.equal(parseBirthDateQuery("S25.3.4"), "1950-03-04");
  assert.equal(parseBirthDateQuery("s25/3/4"), "1950-03-04");
  assert.equal(parseBirthDateQuery("昭和25年3月4日"), "1950-03-04");
  assert.equal(parseBirthDateQuery("令和元年5月1日"), "2019-05-01");
  assert.equal(parseBirthDateQuery("H1.1.8"), "1989-01-08");
  assert.equal(parseBirthDateQuery("S64.1.7"), "1989-01-07");
});

test("rejects ambiguous or impossible birth dates", () => {
  assert.equal(parseBirthDateQuery("500304"), "");
  assert.equal(parseBirthDateQuery("2023-02-29"), "");
  assert.equal(parseBirthDateQuery("2024-02-29"), "2024-02-29");
  assert.equal(parseBirthDateQuery("S64.1.8"), "");
  assert.equal(parseBirthDateQuery("H31.5.1"), "");
  assert.equal(parseBirthDateQuery("H0.1.1"), "");
  assert.equal(parseBirthDateQuery("みほん"), "");
  assert.equal(parseBirthDateQuery("D003"), "");
  assert.equal(parseBirthDateQuery("1950/13/1"), "");
});

test("formats birth dates in the Japanese era", () => {
  assert.equal(formatBirthDateJp("1950-03-04"), "S25.3.4");
  assert.equal(formatBirthDateJp("1989-01-07"), "S64.1.7");
  assert.equal(formatBirthDateJp("1989-01-08"), "H1.1.8");
  assert.equal(formatBirthDateJp("2019-05-01"), "R1.5.1");
  assert.equal(formatBirthDateJp(""), "");
  assert.equal(eraYearLabel("2019-05-01"), "令和元年");
  assert.equal(eraYearLabel("1950-03-04"), "昭和25年");
});
