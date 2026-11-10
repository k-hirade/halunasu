import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// (D) 会計連携・文書・印刷・設定のレスポンシブ修正が CSS から抜け落ちないことの確認（見た目は ui-audit・smoke で見る）
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("phone-only paper rules in print.css are limited to the screen", () => {
  const css = read("app/styles/print.css");
  // 印刷のとき Chrome は用紙の印字幅で max-width を評価するので、screen を付けないとスマホ用の指定が紙に当たる
  const queries = [...css.matchAll(/@media\s+([^{]+)\{/gu)].map((match) => match[1].trim());
  for (const query of queries.filter((item) => item.includes("max-width"))) {
    assert.match(query, /^screen and /u, `"${query}" must be screen-only`);
  }
});

test("the chart print sheet cancels the card style of .chart-sheet", () => {
  const css = read("app/styles/print.css");
  assert.match(css, /\.sheet > \.chart-sheet \{[^}]*border: 0;[^}]*\}/u);
  assert.match(css, /\.cs-facility-info > span \{\s*white-space: nowrap;/u);
});

test("the insert sheet scrolls between its header and its buttons", () => {
  const css = read("app/styles/documents.css");
  assert.match(css, /\.doc-insert-body \{[^}]*min-height: 0;[^}]*overflow-y: auto;/u);
  const panel = read("components/document-insert-panel.js");
  const body = panel.indexOf('className="doc-insert-body"');
  assert.ok(body > panel.indexOf('className="doc-insert-head"') && body < panel.indexOf('className="doc-insert-foot"'), "the body sits between the header and the footer");
});

test("small settings dialogs have a back button and stay centred on phones", () => {
  const source = read("components/settings-master.js");
  const dialog = source.slice(source.indexOf("export function SettingsDialog"));
  assert.match(dialog, /master-panel-back/u);
  const css = read("app/styles/settings.css");
  assert.match(css, /\.master-panel\.settings-dialog:not\(\.is-wide\) \{[^}]*transform: translate\(-50%, -50%\);/u);
});
