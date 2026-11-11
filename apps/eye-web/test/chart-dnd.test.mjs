import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyCopy } from "../lib/chart-copy.js";
import { COPY_DRAG_TYPE, copyDragProps, copyDropProps, findingDragText, parseCopyPayload } from "../lib/chart-dnd.js";

const today = () => ({ findings: { od: {}, os: {} }, findingsText: "", plan: "", assessment: "", prescriptions: [], orders: [], sketches: [] });
const source = {
  findings: { od: { anterior: "前房清明", angle: "open", angleNote: "Shaffer 4", cdRatio: 0.7 }, os: { anterior: "浅前房" } },
  plan: "点眼継続",
  assessment: "眼圧安定"
};

test("the drag type matches the one in chart-shared", () => {
  const shared = readFileSync(new URL("../components/chart-shared.js", import.meta.url), "utf8");
  assert.ok(shared.includes(`COPY_DRAG_TYPE = "${COPY_DRAG_TYPE}"`));
});

test("payloads with unknown kinds or parts are ignored", () => {
  assert.equal(parseCopyPayload(""), null);
  assert.equal(parseCopyPayload("{"), null);
  assert.equal(parseCopyPayload(JSON.stringify({ kind: "evil", encounterId: "e1" })), null);
  assert.equal(parseCopyPayload(JSON.stringify({ kind: "finding", encounterId: "e1", part: "__proto__" })), null);
  assert.equal(parseCopyPayload(JSON.stringify({ kind: "text" })), null);
  assert.deepEqual(parseCopyPayload(JSON.stringify({ kind: "finding", encounterId: "e1", part: "angle" })), { kind: "finding", encounterId: "e1", part: "angle" });
});

test("a finding part is copied into empty eyes only", () => {
  const current = today();
  current.findings.os.anterior = "今日の所見";
  const result = applyCopy(current, source, "finding", { part: "anterior" });
  assert.equal(result.content.findings.od.anterior, "前房清明");
  assert.equal(result.content.findings.os.anterior, "今日の所見");
  assert.match(result.note, /入力済みの1眼/u);
  assert.equal(result.label, "前眼部");
});

test("the angle part brings its note along and C/D keeps the number", () => {
  const angle = applyCopy(today(), source, "finding", { part: "angle" });
  assert.deepEqual(angle.content.findings.od, { angle: "open", angleNote: "Shaffer 4" });
  const cd = applyCopy(today(), source, "finding", { part: "cdRatio" });
  assert.equal(cd.content.findings.od.cdRatio, 0.7);
  assert.deepEqual(cd.content.findings.os, {});
});

test("the plan is copied only when today's plan is empty", () => {
  const first = applyCopy(today(), source, "plan");
  assert.equal(first.content.plan, "点眼継続");
  assert.equal(first.content.assessment, "眼圧安定");
  const kept = applyCopy({ ...today(), plan: "手術予定" }, source, "plan");
  assert.equal(kept.content.plan, "手術予定");
  assert.match(kept.note, /そのまま/u);
});

test("drag props are only given when editable, and drops parse the payload", () => {
  assert.deepEqual(copyDragProps(false, { kind: "plan", encounterId: "e1" }), {});
  const props = copyDragProps(true, { kind: "plan", encounterId: "e1" }, { text: "点眼継続" });
  assert.equal(props.draggable, true);
  const store = new Map();
  const event = { stopPropagation() {}, dataTransfer: { setData: (type, value) => store.set(type, value), effectAllowed: "" } };
  props.onDragStart(event);
  assert.equal(store.get("text/plain"), "点眼継続");
  assert.equal(event.dataTransfer.effectAllowed, "copy");

  let dropped = null;
  let active = null;
  const drop = copyDropProps({ enabled: true, onDrop: (data) => { dropped = data; }, onActive: (value) => { active = value; } });
  let prevented = false;
  drop.onDragOver({ preventDefault: () => { prevented = true; }, dataTransfer: { types: [COPY_DRAG_TYPE], dropEffect: "" } });
  assert.equal(prevented, true);
  assert.equal(active, true);
  drop.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { getData: (type) => store.get(type) || "" } });
  assert.deepEqual(dropped, { kind: "plan", encounterId: "e1" });
  assert.equal(active, false);
  assert.deepEqual(copyDropProps({ enabled: false, onDrop() {} }), {});
});

test("finding drag text names the eye", () => {
  assert.equal(findingDragText("眼底", "出血", ""), "眼底 R 出血");
  assert.equal(findingDragText("眼底", "出血", "正常"), "眼底 R 出血\n眼底 L 正常");
});
