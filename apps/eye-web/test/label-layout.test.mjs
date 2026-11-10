import assert from "node:assert/strict";
import test from "node:test";
import { placeLabels, splitAtBreaks } from "../lib/label-layout.mjs";

const bounds = { left: 40, right: 400, top: 0, bottom: 200 };
const overlap = (a, b) => Math.abs(a.x - b.x) < 20 && Math.abs(a.y - b.y) < 11;

test("重なる 2 つのラベルは、後のほうを点の反対側へ回す", () => {
  const placed = placeLabels([
    { key: "od", x: 200, y: 100, up: true, text: "14", order: 0 },
    { key: "os", x: 200, y: 108, up: true, text: "13", order: 1 }
  ], { bounds });
  assert.deepEqual(placed.get("od"), { x: 200, y: 93 });
  assert.deepEqual(placed.get("os"), { x: 200, y: 122 });
});

test("置ける所がないラベルは省き、残ったラベル同士は重ならない", () => {
  const items = [0, 1, 2, 3].map((index) => ({ key: `k${index}`, x: 200, y: 100 + index * 2, up: index % 2 === 0, text: "1.2", order: index }));
  const placed = placeLabels(items, { bounds });
  assert.ok(placed.size < items.length);
  const list = [...placed.values()];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) assert.ok(!overlap(list[i], list[j]));
});

test("左端・右端のラベルは枠（Y 軸の目盛りの右）の中に寄せる", () => {
  const placed = placeLabels([
    { key: "left", x: 40, y: 100, up: true, text: "0.3" },
    { key: "right", x: 400, y: 100, up: true, text: "0.3" }
  ], { bounds });
  assert.ok(placed.get("left").x - 10.6 >= bounds.left);
  assert.ok(placed.get("right").x + 10.6 <= bounds.right);
});

test("障害物（目盛り・日付）と上下の枠の外は避ける", () => {
  const placed = placeLabels([{ key: "top", x: 200, y: 5, up: true, text: "20" }], { bounds, obstacles: [{ x1: 190, x2: 210, y1: 15, y2: 25 }] });
  assert.equal(placed.has("top"), false);
});

test("値の文字は空白・×・= の後と括弧の前で区切る", () => {
  assert.deepEqual(splitAtBreaks("RV=0.9 (1.2×S−1.00D=C−0.50D Ax180°)"), ["RV=", "0.9 ", "(1.2×", "S−1.00D=", "C−0.50D ", "Ax180°)"]);
  assert.deepEqual(splitAtBreaks("0.3（0.6）"), ["0.3", "（0.6）"]);
  assert.deepEqual(splitAtBreaks(""), []);
});
