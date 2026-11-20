import { strict as assert } from "node:assert";
import test from "node:test";
import { displayDrugName } from "../lib/drug-name.js";

test("drug names show full-width digits, letters, '．' and '％' as half-width", () => {
  assert.equal(displayDrugName("チモロール点眼液０．５％「ニッテン」"), "チモロール点眼液0.5%「ニッテン」");
  assert.equal(displayDrugName("キサラタン点眼液０．００５％"), "キサラタン点眼液0.005%");
  assert.equal(displayDrugName("ビタミンＢ１２点眼液ｍｇ"), "ビタミンB12点眼液mg");
});

test("kana, kanji, brackets and empty values stay as they are", () => {
  assert.equal(displayDrugName("ヒアレイン点眼液（ミニ）　２５ｍｇ"), "ヒアレイン点眼液（ミニ）　25mg");
  assert.equal(displayDrugName("ｶﾀｶﾅ"), "ｶﾀｶﾅ");
  assert.equal(displayDrugName(""), "");
  assert.equal(displayDrugName(null), "");
  assert.equal(displayDrugName(undefined), "");
});
