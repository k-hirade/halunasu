// 共通のダイアログの決まりごと: 日本語入力の変換中のキー・Tab の回り方・重なり・dirty のときの確認
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmClose, createModalStack, DIRTY_CONFIRM_TEXT, isImeKey, isPrevented, trapTarget } from "../lib/modal.js";

test("変換中（isComposing・keyCode 229）のキーは閉じる・送るに使わない", () => {
  assert.equal(isImeKey({ key: "Escape", isComposing: true }), true);
  assert.equal(isImeKey({ key: "Enter", keyCode: 229 }), true);
  assert.equal(isImeKey({ key: "Escape", nativeEvent: { isComposing: true } }), true);
  assert.equal(isImeKey({ key: "Escape", keyCode: 27 }), false);
  assert.equal(isImeKey(null), false);
});

test("ほかの部品が先に使った Esc（preventDefault 済み）は見分けられる", () => {
  assert.equal(isPrevented({ defaultPrevented: true }), true);
  assert.equal(isPrevented({ defaultPrevented: false, isDefaultPrevented: () => true }), true);
  assert.equal(isPrevented({ defaultPrevented: false, nativeEvent: { defaultPrevented: true } }), true);
  assert.equal(isPrevented({ defaultPrevented: false, isDefaultPrevented: () => false }), false);
});

test("Tab は端で反対の端へ回り、中ほどはブラウザに任せる", () => {
  assert.equal(trapTarget(3, 2, false), 0);
  assert.equal(trapTarget(3, 0, true), 2);
  assert.equal(trapTarget(3, 1, false), -1);
  assert.equal(trapTarget(3, 1, true), -1);
  // ダイアログの外（または枠そのもの）にいるときは、最初（Shift なら最後）へ入れる
  assert.equal(trapTarget(3, -1, false), 0);
  assert.equal(trapTarget(3, -1, true), 2);
  assert.equal(trapTarget(1, 0, false), 0);
  assert.equal(trapTarget(0, -1, false), -1);
});

test("重なったダイアログは、後から開いたものが一番上。閉じると下のものが一番上に戻る", () => {
  const stack = createModalStack();
  const parent = { name: "parent" };
  const child = { name: "child" };
  const removeParent = stack.push(parent);
  assert.equal(stack.isTop(parent), true);
  const removeChild = stack.push(child);
  assert.equal(stack.isTop(parent), false);
  assert.equal(stack.isTop(child), true);
  assert.equal(stack.size(), 2);
  assert.equal(stack.find((entry) => entry.name === "parent"), parent);
  removeChild();
  assert.equal(stack.isTop(parent), true);
  removeChild();
  assert.equal(stack.size(), 1);
  removeParent();
  assert.equal(stack.size(), 0);
  assert.equal(stack.top(), null);
  assert.equal(stack.isTop(parent), false);
});

test("dirty のときだけ確かめ、答えに従う", () => {
  const asked = [];
  const confirm = (answer) => (text) => { asked.push(text); return answer; };
  assert.equal(confirmClose({ dirty: false, confirm: confirm(false) }), true);
  assert.equal(asked.length, 0);
  assert.equal(confirmClose({ dirty: true, confirm: confirm(false) }), false);
  assert.equal(confirmClose({ dirty: true, confirm: confirm(true) }), true);
  assert.deepEqual(asked, [DIRTY_CONFIRM_TEXT, DIRTY_CONFIRM_TEXT]);
  assert.equal(DIRTY_CONFIRM_TEXT, "入力中の内容を破棄して閉じますか？");
});
