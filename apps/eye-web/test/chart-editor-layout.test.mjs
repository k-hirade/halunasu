import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

// カルテの 3 ペイン・引き出しの切り替えは、JS（どのボタンを出すか）と CSS（どう並べるか）の 2 か所で同じ条件を使う。
// 片方だけ変えると、横向きスマホなどで「引き出しのボタンが無いのに左が隠れる」ようなずれが起きるため、文字列でそろっているかを見る。
const css = readFileSync(new URL("../app/styles/chart-editor.css", import.meta.url), "utf8");
const editor = readFileSync(new URL("../components/encounter-editor.js", import.meta.url), "utf8");

test("3 ペインと左の常時表示の条件は、高さ 500px 以下を除く", () => {
  assert.match(editor, /const WIDE_QUERY = "\(min-width: 1280px\) and \(min-height: 501px\)";/u);
  assert.match(editor, /const MEDIUM_QUERY = "\(min-width: 768px\) and \(min-height: 501px\)";/u);
  assert.match(editor, /useMediaQuery\(WIDE_QUERY, true\)/u);
  assert.match(editor, /useMediaQuery\(MEDIUM_QUERY, true\)/u);
});

test("CSS の引き出しの条件は、JS の条件の裏返しになっている", () => {
  // 右を引き出しにする: 1279px 以下、または高さ 500px 以下
  assert.ok(css.includes("@media (max-width: 1279px), (max-height: 500px) {"));
  // 左も引き出しにし、ページ全体をスクロールする: 767px 以下、または高さ 500px 以下
  assert.ok(css.includes("@media (max-width: 767px), (max-height: 500px) {"));
  // 右ペインの下の操作帯の 2 段の配置は、3 ペインのときだけ
  assert.ok(css.includes("@media (min-width: 1280px) and (min-height: 501px) {"));
  // 幅だけの古い条件が残っていない
  assert.ok(!/@media \(max-width: 1279px\) \{/u.test(css));
  assert.ok(!/@media \(min-width: 1280px\) \{/u.test(css));
});

test("用法のメニューの幅は .more-menu-list の既定に負けない選択子で指定する", () => {
  assert.ok(css.includes(".more-menu-list.usage-list {"));
  assert.match(css, /\.usage-list \.btn\.btn-chip \{[^}]*width: auto;/u);
});
