import { strict as assert } from "node:assert";
import test from "node:test";
import { applyCopy } from "../lib/chart-copy.js";
import {
  BUILTIN_CHART_TEMPLATES, clearUntouchedTemplate, copyBaseContent, groupPhrasesBySoap, isUntouchedTemplate, orderChartTemplates, phraseSoap, soapFilterOptions
} from "../lib/chart-soap.js";

const SOAP = "S)\nO)\nA)\nP)";

test("phrase SOAP category: explicit value, then the target, then an S)/O)/A)/P) prefix", () => {
  assert.equal(phraseSoap({ target: "plan", soap: "S" }), "S", "explicit category wins");
  assert.equal(phraseSoap({ target: "plan", soap: "none" }), "", "none means other");
  assert.equal(phraseSoap({ target: "plan" }), "P");
  assert.equal(phraseSoap({ target: "findings.fundus", soap: "" }), "O");
  assert.equal(phraseSoap({ target: "findingsText", text: "S) かわりなし" }), "S");
  assert.equal(phraseSoap({ target: "findingsText", text: "（a）病状に変化なし" }), "A");
  assert.equal(phraseSoap({ target: "findingsText", text: "o：著変なし" }), "O");
  assert.equal(phraseSoap({ target: "findingsText", text: "視神経に特記所見なし" }), "");
  assert.equal(phraseSoap({ target: "staffNote", text: "P) 説明" }), "P", "no target category falls back to the prefix");
});

test("phrases are grouped S, O, A, P, other and inactive ones are left out", () => {
  const phrases = [
    { phraseId: "1", target: "plan", text: "経過観察" },
    { phraseId: "2", target: "findingsText", text: "S) かわりなし" },
    { phraseId: "3", target: "findingsText", text: "眼底 異常なし", soap: "O" },
    { phraseId: "4", target: "staffNote", text: "次回散瞳" },
    { phraseId: "5", target: "chiefComplaint", text: "かすみ", active: false }
  ];
  const groups = groupPhrasesBySoap(phrases);
  assert.deepEqual(groups.map((group) => [group.key, group.label, group.items.map((item) => item.phraseId)]), [
    ["S", "S 主観", ["2"]], ["O", "O 客観", ["3"]], ["P", "P 計画", ["1"]], ["", "その他", ["4"]]
  ]);
  assert.deepEqual(groupPhrasesBySoap(phrases, "P").map((group) => group.key), ["P"]);
  assert.deepEqual(groupPhrasesBySoap(phrases, "A"), []);
  assert.deepEqual(soapFilterOptions(phrases).map((option) => [option.value, option.count]), [[null, 4], ["S", 1], ["O", 1], ["P", 1], ["", 1]]);
});

test("an untouched chart template is replaced when previous findings are copied", () => {
  const templates = [{ memberId: "m1", text: SOAP }];
  assert.equal(isUntouchedTemplate(`${SOAP}\n`, templates), true);
  assert.equal(isUntouchedTemplate("S) かすみ\nO)\nA)\nP)", templates), false);
  assert.equal(isUntouchedTemplate("", templates), false);

  const content = { findings: { od: {}, os: {} }, findingsText: `${SOAP}\n`, plan: "", assessment: "", prescriptions: [], orders: [], sketches: [] };
  // 型のままなら前回の文で置き換える（「空の欄にだけ」の決まりのまま、型を空とみなす）
  const cleared = clearUntouchedTemplate(content, "前回の所見", templates);
  assert.equal(applyCopy(cleared, { findingsText: "前回の所見" }, "left").content.findingsText, "前回の所見");
  assert.equal(applyCopy(cleared, { findingsText: "前回の所見" }, "text").content.findingsText, "前回の所見");
  // 型に書き足してあれば触らない。写す文が無ければ型を残す
  const edited = { ...content, findingsText: "S) かすみ\nO)\nA)\nP)" };
  assert.equal(clearUntouchedTemplate(edited, "前回の所見", templates), edited);
  assert.equal(clearUntouchedTemplate(content, "", templates), content);
  assert.equal(applyCopy(clearUntouchedTemplate(edited, "前回の所見", templates), { findingsText: "前回の所見" }, "text").content.findingsText, "S) かすみ\nO)\nA)\nP)\n前回の所見");
});

test("only copies that bring the free text replace an untouched template", () => {
  const templates = [{ memberId: "m1", text: SOAP }];
  const content = { findingsText: SOAP, prescriptions: [] };
  const source = { findingsText: "前回の所見", prescriptions: [] };
  for (const kind of ["left", "all", "text"]) assert.equal(copyBaseContent(content, source, kind, templates).findingsText, "", kind);
  for (const kind of ["right", "rx", "orders", "sketch", "finding", "plan"]) assert.equal(copyBaseContent(content, source, kind, templates), content, kind);
});

test("template candidates list the chart's doctor first, then the user, then others", () => {
  const templates = [{ memberId: "c", text: "C" }, { memberId: "b", text: "B" }, { memberId: "a", text: "A" }, { memberId: "x", text: " " }];
  const names = { a: "青木", b: "伊藤", c: "佐藤" };
  assert.deepEqual(orderChartTemplates(templates, { encounterMemberId: "b", selfMemberId: "c", names }).map((item) => item.name), ["伊藤", "佐藤", "青木"]);
  assert.equal(orderChartTemplates(templates, { names }).length, 3, "blank templates are not offered");
  assert.ok(BUILTIN_CHART_TEMPLATES.every((item) => item.text.length <= 2000 && item.label));
});
