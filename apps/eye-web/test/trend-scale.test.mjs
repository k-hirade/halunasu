import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeMarkPath, iopAxis, thinLabels, VA_FIXED_TICKS, vaAxis, vaFixedAxis, vaPoint } from "../lib/trend-scale.mjs";

const band = { top: 0, bottom: 100 };

test("VA axis starts one step below the lowest value and ends at 2.0", () => {
  const axis = vaAxis([0.3, 1.2], band);
  assert.equal(axis.lower, 0.2);
  assert.equal(axis.upper, 2.0);
  assert.equal(axis.y(2.0), 0);
  assert.equal(axis.y(0.2), 100);
});

test("VA axis keeps a non-zero range for one point, 2.0 and empty data", () => {
  for (const values of [[1.0], [2.0], [0.01], [], [Number.NaN]]) {
    const axis = vaAxis(values, band);
    assert.ok(axis.upper > axis.lower, `range for ${values}`);
    assert.ok(axis.ticks.length >= 2);
    assert.ok(Number.isFinite(axis.y(Number.isFinite(values[0]) ? values[0] : 1)));
  }
});

test("IOP axis is data driven with at least 10 mmHg", () => {
  assert.deepEqual([iopAxis([13, 16], band).lower, iopAxis([13, 16], band).upper], [5, 25]);
  const single = iopAxis([14], band);
  assert.ok(single.upper - single.lower >= 10);
  const high = iopAxis([40], band);
  assert.ok(high.upper >= 45);
  assert.ok(Number.isFinite(iopAxis([], band).y(15)));
  assert.equal(iopAxis([0], band).lower, 0);
});

test("date labels closer than the gap are dropped, keeping the latest", () => {
  const items = [0, 20, 60, 70, 200].map((x) => ({ x }));
  assert.deepEqual(thinLabels(items).map((item) => item.x), [0, 60, 200]);
  assert.deepEqual(thinLabels([{ x: 0 }, { x: 10 }]).map((item) => item.x), [10]);
  assert.deepEqual(thinLabels([{ x: 5 }]).map((item) => item.x), [5]);
});

test("the fixed VA axis is logarithmic from 0.01 to 2.0", () => {
  const axis = vaFixedAxis(band);
  assert.deepEqual(axis.ticks, VA_FIXED_TICKS);
  assert.deepEqual(VA_FIXED_TICKS, [0.01, 0.1, 0.2, 0.5, 1.0, 2.0]);
  assert.equal(axis.y(2.0), 0);
  assert.equal(axis.y(0.01), 100);
  // 対数: 0.1→1.0 と 0.01→0.1 は同じ高さの差
  assert.ok(Math.abs((axis.y(0.1) - axis.y(1.0)) - (axis.y(0.01) - axis.y(0.1))) < 1e-9);
  // 1.0 は中ほどより上（線形なら 0.5 付近に 1.0 が来る）
  assert.ok(axis.y(1.0) < 20);
});

test("VA values outside the axis and non-numeric VA get an edge marker instead of being dropped", () => {
  const axis = vaFixedAxis(band);
  assert.deepEqual(vaPoint(0.5, "0.5", axis), { y: axis.y(0.5), edge: "", note: "" });
  const high = vaPoint(2.5, "2.5", axis);
  assert.equal(high.edge, "high");
  assert.equal(high.y, 0);
  const counting = vaPoint(null, "指数弁", axis);
  assert.equal(counting.edge, "low");
  assert.equal(counting.y, 100);
  assert.match(counting.note, /数値にできない/u);
  const below = vaPoint(0.02, "0.02", vaAxis([0.5], band));
  assert.equal(below.edge, "low");
  assert.equal(vaPoint(null, "", axis), null);
  assert.match(edgeMarkPath(10, 0, "high"), /^M10,-5 /u);
  assert.match(edgeMarkPath(10, 100, "low"), /^M10,105 /u);
});
