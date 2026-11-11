import { strict as assert } from "node:assert";
import test from "node:test";
import { hasPreopValues, keratoSummary, preopSummary, radiusFromPower } from "../lib/preop.js";

test("keratometry adds the average K, corneal cylinder and radii", () => {
  assert.deepEqual(keratoSummary({ k1: 43.25, k2: 44.75, axis: 90 }), { k1: 43.25, k2: 44.75, axis: 90, average: 44, cylinder: 1.5, r1: 7.8, r2: 7.54 });
  assert.equal(keratoSummary({}), null);
  assert.equal(radiusFromPower(0), null);
});

test("the newest value wins per eye and planned IOLs come first", () => {
  const today = { encounterDate: "2026-11-11", content: { exam: { od: { iop: 15 }, os: {} } } };
  const last = { encounterDate: "2026-10-01", content: { exam: { od: { iop: 18, keratometry: { k1: 43, k2: 44, axis: 180 }, vaUncorrected: "0.3", vaCorrected: "0.8" }, os: { refraction: { sphere: -1, cylinder: -0.5, axis: 90 } } } } };
  const summary = preopSummary({
    encounters: [today, null, last],
    iolRecords: [{ eye: "od", status: "implanted", model: "A" }, { eye: "od", status: "planned", model: "B" }]
  });
  assert.deepEqual(summary.od.iop, { value: 15, date: "2026-11-11" });
  assert.equal(summary.od.kerato.date, "2026-10-01");
  assert.equal(summary.od.kerato.value.average, 43.5);
  assert.equal(summary.od.va.value.corrected, "0.8");
  assert.equal(summary.od.iol.model, "B");
  assert.equal(summary.os.iol, null);
  assert.equal(summary.os.refraction.value.sphere, -1);
  assert.equal(hasPreopValues(summary), true);
  assert.equal(hasPreopValues(preopSummary({})), false);
});
