import { strict as assert } from "node:assert";
import test from "node:test";
import { applyCopy, appendRpRows } from "../lib/chart-copy.js";

const empty = () => ({
  findings: { od: {}, os: {} },
  findingsText: "",
  plan: "",
  assessment: "",
  prescriptions: [],
  orders: [],
  sketches: []
});

const source = {
  findingsText: "前房清明",
  findings: { od: { anterior: "清明", cdRatio: 0.7 }, os: { lens: "NS2" }, general: "全身良好" },
  plan: "点眼継続",
  prescriptions: [
    { kind: "eye_drop", name: "ラタノプロスト", eye: "ou", rpId: "rp1" },
    { kind: "eye_drop", name: "チモロール", eye: "ou", rpId: "rp1" },
    { kind: "comment", rpId: "rp1", text: "後発品変更不可", scope: "free" },
    { kind: "oral", name: "アセタゾラミド", eye: "" }
  ],
  orders: [
    { orderId: "o1", code: "va", name: "視力検査", kind: "exam", eye: "ou", status: "performed", statusChangedBy: { memberId: "m" }, statusChangedAt: "x", rpId: "rpA" },
    { orderId: "o2", code: "iop", name: "眼圧検査", kind: "exam", eye: "ou", status: "cancelled" }
  ],
  sketches: [{ sketchId: "sk1", template: "fundus", eye: "od", caption: "", strokes: [{ color: "#000", width: 3, points: [1, 2, 3, 4] }] }]
};

test("the left column copy fills only empty fields and never copies C/D", () => {
  const current = { ...empty(), findingsText: "今回の所見", findings: { od: { anterior: "今回" }, os: {} } };
  const { content, note } = applyCopy(current, source, "left");
  assert.equal(content.findingsText, "今回の所見", "written text is kept");
  assert.equal(content.findings.od.anterior, "今回");
  assert.equal(content.findings.os.lens, "NS2");
  assert.equal(content.findings.od.cdRatio, undefined);
  assert.equal(content.findings.general, "全身良好");
  assert.equal(content.plan, "点眼継続");
  assert.equal(content.sketches.length, 1);
  assert.match(note, /入力済み/u);
  assert.equal(content.prescriptions.length, 0, "the left column does not copy prescriptions");
});

test("the right column copy re-keys Rps, keeps comments, carries over and skips cancelled orders", () => {
  const { content } = applyCopy(empty(), source, "right");
  const rx = content.prescriptions;
  assert.equal(rx.length, 4);
  assert.notEqual(rx[0].rpId, "rp1");
  assert.equal(rx[0].rpId, rx[1].rpId);
  assert.equal(rx[2].kind, "comment");
  assert.equal(rx[2].rpId, rx[0].rpId);
  assert.ok(rx.filter((row) => row.kind !== "comment").every((row) => row.carriedOver));
  assert.equal(content.orders.length, 1);
  assert.equal(content.orders[0].status, "planned");
  assert.equal(content.orders[0].statusChangedBy, null);
  assert.notEqual(content.orders[0].orderId, "o1");
});

test("copying the same Rp twice does not duplicate drugs", () => {
  const once = applyCopy(empty(), source, "rx", { rows: source.prescriptions.slice(0, 3) }).content;
  const twice = applyCopy(once, source, "rx", { rows: source.prescriptions.slice(0, 3) });
  assert.equal(twice.content.prescriptions.length, 3);
  assert.match(twice.note, /重ねていません/u);
});

test("a sketch template copy has a new id and no strokes", () => {
  const { content } = applyCopy(empty(), source, "sketch", { sketch: source.sketches[0], strokes: false });
  assert.equal(content.sketches[0].strokes.length, 0);
  assert.notEqual(content.sketches[0].sketchId, "sk1");
});

test("free text drag appends to the written text", () => {
  const { content } = applyCopy({ ...empty(), findingsText: "今回" }, source, "text");
  assert.equal(content.findingsText, "今回\n前房清明");
});

test("learning bundles become one new Rp", () => {
  const next = appendRpRows(empty(), "prescriptions", [{ kind: "eye_drop", name: "A" }, { kind: "eye_drop", name: "B" }]);
  assert.equal(next.prescriptions[0].rpId, next.prescriptions[1].rpId);
  const orders = appendRpRows(empty(), "orders", [{ kind: "exam", name: "視力検査", code: "va" }]);
  assert.equal(orders.orders[0].status, "planned");
  assert.ok(orders.orders[0].orderId);
});
