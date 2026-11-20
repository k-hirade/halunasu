import assert from "node:assert/strict";
import { test } from "node:test";
import { autoKana, createKanaCapture, kanaCaptureStep, readingOf } from "../lib/kana-capture.js";

// ローマ字入力で 1 文節を打って変換・確定するまでの事件の並び
function type(state, updates, committed) {
  let next = kanaCaptureStep(state, { type: "start" });
  for (const data of updates) next = kanaCaptureStep(next, { type: "update", data });
  return kanaCaptureStep(next, { type: "end", data: committed });
}

// 氏名欄の流れ（値の変化ごとにフリガナを決める）をまねる
function field() {
  let capture = createKanaCapture();
  let kana = "";
  let auto = "";
  return {
    compose(updates, committed, valueAfter) {
      capture = type(capture, updates, committed);
      this.input(valueAfter);
    },
    input(value) {
      const result = autoKana({ kana, auto, reading: readingOf(capture, value) });
      if (result) ({ kana, auto } = result);
    },
    editKana(value) { kana = value; },
    get kana() { return kana; }
  };
}

test("takes the reading typed before conversion and turns it into katakana", () => {
  const state = type(createKanaCapture(), ["y", "や", "やm", "やま", "やまd", "やまだ", "山田"], "山田");
  assert.deepEqual(state.segments, [{ text: "山田", reading: "やまだ" }]);
  assert.equal(readingOf(state, "山田"), "ヤマダ");
});

test("joins several conversions and keeps the space between family and given names", () => {
  let state = type(createKanaCapture(), ["やまだ", "山田"], "山田");
  state = type(state, ["はなこ", "花子"], "花子");
  assert.equal(readingOf(state, "山田 花子"), "ヤマダ ハナコ");
  assert.equal(readingOf(state, "山田　花子"), "ヤマダ ハナコ", "a full-width space is one space");
  assert.equal(readingOf(state, "山田花子"), "ヤマダハナコ");
});

test("drops the reading of deleted characters", () => {
  let state = type(createKanaCapture(), ["やまだ", "山田"], "山田");
  state = type(state, ["はなこ", "花子"], "花子");
  assert.equal(readingOf(state, "山田 "), "ヤマダ");
  assert.equal(readingOf(state, "山田"), "ヤマダ");
  assert.equal(readingOf(state, ""), "");
  // 名の 1 文字だけ消すと、その文節の読みは分からなくなる（読める部分だけ残す）
  assert.equal(readingOf(state, "山田 花"), "ヤマダ");
  // 消してから打ち直すと新しい組で読む
  state = type(state, ["ゆみ", "由美"], "由美");
  assert.equal(readingOf(state, "山田 由美"), "ヤマダ ユミ");
  // 同じ漢字を別の読みで打ち直したら、新しい読みを使う
  state = type(state, ["あらた", "新"], "新");
  state = type(state, ["しん", "新"], "新");
  assert.equal(readingOf(state, "山田 新"), "ヤマダ シン");
});

test("handles kana committed without conversion, katakana conversion and a cancelled composition", () => {
  let state = type(createKanaCapture(), ["さくら"], "さくら");
  assert.equal(readingOf(state, "さくら"), "サクラ");
  state = type(createKanaCapture(), ["じょん", "ジョン"], "ジョン");
  assert.equal(readingOf(state, "ジョン"), "ジョン");
  state = type(createKanaCapture(), ["やま"], "");
  assert.deepEqual(state.segments, []);
});

test("trims the previous reading when only part of a composition was committed", () => {
  // やまだはなこ を打って「山田」だけ確定し、残りの「はなこ」を続けて変換する
  let state = type(createKanaCapture(), ["やまだはなこ", "山田はなこ"], "山田");
  state = type(state, ["はなこ", "花子"], "花子");
  assert.deepEqual(state.segments.map((segment) => segment.reading), ["やまだ", "はなこ"]);
  assert.equal(readingOf(state, "山田花子"), "ヤマダハナコ");
  // 打ち始めの 1 文字が前の読みの終わりと同じでも削らない
  let other = type(createKanaCapture(), ["はなこ", "花子"], "花子");
  other = type(other, ["こ", "子"], "子");
  assert.deepEqual(other.segments.map((segment) => segment.reading), ["はなこ", "こ"]);
});

test("pasted names give no reading", () => {
  assert.equal(readingOf(createKanaCapture(), "山田 花子"), "");
  const state = type(createKanaCapture(), ["やまだ", "山田"], "山田");
  assert.equal(readingOf(state, "鈴木"), "", "a pasted name replacing the typed one");
});

test("fills the furigana only while it is empty or still the last auto-filled value", () => {
  const name = field();
  name.compose(["やまだ", "山田"], "山田", "山田");
  assert.equal(name.kana, "ヤマダ");
  name.input("山田 ");
  name.compose(["はなこ", "花子"], "花子", "山田 花子");
  assert.equal(name.kana, "ヤマダ ハナコ");
  // 消すとフリガナも短くなる
  name.input("山田 ");
  assert.equal(name.kana, "ヤマダ");
  name.compose(["はなこ", "華子"], "華子", "山田 華子");
  assert.equal(name.kana, "ヤマダ ハナコ");
  // フリガナを手で直したら、それ以降は変えない
  name.editKana("ヤマダ ハナ");
  name.compose(["さん", "さん"], "さん", "山田 華子さん");
  assert.equal(name.kana, "ヤマダ ハナ");
  // 手で空にしたら、また自動で入れる
  name.editKana("");
  name.input("山田 華子");
  assert.equal(name.kana, "ヤマダ ハナコ");
});

test("does not fill from a pasted name, and clears an auto value when the name is replaced by paste", () => {
  const pasted = field();
  pasted.input("山田 花子");
  assert.equal(pasted.kana, "");
  const replaced = field();
  replaced.compose(["やまだ", "山田"], "山田", "山田");
  replaced.input("鈴木");
  assert.equal(replaced.kana, "");
  assert.equal(autoKana({ kana: "", auto: "", reading: "" }), null);
  assert.equal(autoKana({ kana: "スズキ", auto: "", reading: "ヤマダ" }), null, "typed by hand before");
});
