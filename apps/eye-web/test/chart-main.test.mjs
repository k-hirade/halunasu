// replicate-2 chart-main: カルテガイドの判定と、chart-main.css の約束（トークンだけ・globals から 1 行で読む）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { anyText, chartGuide } from "../lib/chart-guide.js";

const stateOf = (guide, id) => guide.find((item) => item.id === id).state;

test("the chart guide marks empty, entered and needs-check items", () => {
  const empty = chartGuide({});
  assert.deepEqual(empty.map((item) => item.state), Array(8).fill("todo"));
  assert.deepEqual(empty.map((item) => item.label), ["主訴", "検査", "所見", "病名", "処方", "処置", "方針", "次回"]);

  const content = {
    findingsText: "右眼の霧視",
    exam: { od: { vaUncorrected: "0.9" }, os: {} },
    findings: { od: { anterior: "" }, os: { lens: "IOL" } },
    prescriptions: [{ kind: "eye_drop", name: "A", timesPerDay: 2 }, { kind: "comment", rpId: "r", text: "x" }],
    orders: [{ kind: "exam", name: "眼圧検査", status: "performed" }, { kind: "exam", name: "OCT", status: "cancelled" }],
    plan: "点眼継続",
    nextVisit: { intervalWeeks: 4 }
  };
  const guide = chartGuide(content, { profile: { diagnoses: [{ name: "緑内障", status: "active" }] }, confirmations: { od: null, os: null } });
  assert.equal(stateOf(guide, "complaint"), "done");
  assert.equal(stateOf(guide, "exam"), "warn", "values that are not confirmed need a check");
  assert.equal(guide.find((item) => item.id === "exam").hint, "検査値が未確認");
  assert.equal(stateOf(guide, "findings"), "done");
  assert.equal(stateOf(guide, "diagnosis"), "done");
  assert.equal(stateOf(guide, "rx"), "done");
  assert.equal(stateOf(guide, "orders"), "done");
  assert.equal(stateOf(guide, "plan"), "done");
  assert.equal(stateOf(guide, "next"), "done");

  const confirmed = chartGuide(content, { confirmations: { od: { at: "x" }, os: null } });
  assert.equal(stateOf(confirmed, "exam"), "done");
  assert.equal(stateOf(confirmed, "diagnosis"), "todo");

  const pending = chartGuide({ prescriptions: [{ kind: "eye_drop", name: "B" }], orders: [{ kind: "exam", name: "C", status: "planned" }] });
  assert.equal(stateOf(pending, "rx"), "warn", "a drug without usage needs a check");
  assert.equal(pending.find((item) => item.id === "rx").hint, "用法が未入力");
  assert.equal(stateOf(pending, "orders"), "warn");
  assert.equal(stateOf(chartGuide({ prescriptions: [{ kind: "eye_drop", name: "B", issued: false }] }), "rx"), "done", "a drug not issued this time needs no usage");
  assert.equal(stateOf(chartGuide({ prescriptions: [{ kind: "eye_drop", name: "B", usage: "就寝前", carriedOver: true }] }), "rx"), "warn");
  assert.equal(stateOf(chartGuide({ orders: [{ kind: "exam", name: "C", status: "cancelled" }] }), "orders"), "todo");
});

test("anyText looks through nested findings", () => {
  assert.equal(anyText({ od: { a: "" }, os: { b: " " } }), false);
  assert.equal(anyText({ od: { a: ["", "x"] } }), true);
  assert.equal(anyText({ value: 0 }), true);
  assert.equal(anyText(null), false);
});

test("chart-main.css is imported once and uses tokens only", () => {
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.equal(globals.match(/@import "\.\/styles\/chart-main\.css";/gu)?.length, 1);
  assert.ok(globals.indexOf("chart-main.css") > globals.indexOf("chart-editor.css"), "chart-main.css comes after chart-editor.css");
  const css = readFileSync(new URL("../app/styles/chart-main.css", import.meta.url), "utf8");
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/iu.test(css), false, "no hard-coded colours");
  assert.ok(css.includes(".usage-pill.is-missing"), "a missing usage is a red button");
  assert.ok(css.includes(".order-bundle.is-learned"), "learning-list bundles have a dashed frame");
  const fontSizes = [...css.matchAll(/font-size:\s*([^;]+);/gu)].map((match) => match[1].trim());
  assert.ok(fontSizes.every((value) => value === "inherit" || value.startsWith("var(--fs-")), `font sizes use the type scale: ${fontSizes.join(", ")}`);
});

test("the chart action bar keeps the five large buttons and the warnings dialog can dismiss rows", () => {
  const editor = readFileSync(new URL("../components/encounter-editor.js", import.meta.url), "utf8");
  for (const label of ["送信", "検査依頼", "保存", "印刷", "次へ"]) {
    assert.ok(editor.includes(`<span className="action-tile-label">${label}</span>`), `the action bar has ${label}`);
  }
  const dialogs = readFileSync(new URL("../components/encounter-dialogs.js", import.meta.url), "utf8");
  assert.ok(dialogs.includes("onDismiss(warningKey(item))"));
  assert.ok(/isComposing/u.test(dialogs), "Enter in the comment search ignores IME composition");
});
