import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateEncounterInput,
  validateDrugPresetInput,
  validateEncounterContent,
  validateUpdateEncounterInput
} from "../src/index.js";

test("normalizes an empty encounter into per-eye structure", () => {
  const content = validateEncounterContent({});

  assert.deepEqual(Object.keys(content.exam), ["od", "os"]);
  assert.equal(content.exam.od.iop, null);
  assert.equal(content.exam.os.vaCorrected, "");
  assert.deepEqual(content.prescriptions, []);
  assert.deepEqual(content.sketches, []);
});

test("accepts structured exam values for each eye", () => {
  const content = validateEncounterContent({
    exam: {
      od: { vaUncorrected: "0.3", vaCorrected: "1.2", correction: { sphere: "-2.25", cylinder: -0.5, axis: 180 }, iop: "14", iopMethod: "nct" },
      os: { vaCorrected: "0.8p", iop: 21 }
    },
    diagnoses: [{ name: "緑内障", eye: "ou" }],
    prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1, quantity: 2, unit: "本" }],
    nextVisit: { intervalWeeks: 12 }
  });

  assert.equal(content.exam.od.correction.sphere, -2.25);
  assert.equal(content.exam.od.iop, 14);
  assert.equal(content.exam.os.iop, 21);
  assert.equal(content.diagnoses[0].status, "active");
  assert.equal(content.prescriptions[0].timesPerDay, 1);
  assert.equal(content.nextVisit.intervalWeeks, 12);
});

test("rejects out-of-range values with the failing field", () => {
  assert.throws(
    () => validateEncounterContent({ exam: { od: { iop: 200 } } }),
    (error) => error.statusCode === 400 && error.field === "content.exam.od.iop"
  );
  assert.throws(
    () => validateEncounterContent({ prescriptions: [{ name: "x", eye: "both" }] }),
    (error) => error.field === "content.prescriptions.0.eye"
  );
});

test("clamps sketch coordinates and limits sketch size", () => {
  const content = validateEncounterContent({
    sketches: [{ sketchId: "s1", template: "fundus", eye: "od", strokes: [{ points: [[-5, 1200], [10.6, 20.2]] }] }]
  });
  assert.deepEqual(content.sketches[0].strokes[0].points, [0, 1000, 11, 20]);
  assert.deepEqual(
    validateEncounterContent({ sketches: [{ sketchId: "s2", strokes: [{ points: [5, 6, 7, 8] }] }] }).sketches[0].strokes[0].points,
    [5, 6, 7, 8]
  );
  assert.throws(() => validateEncounterContent({ sketches: [{ sketchId: "s3", strokes: [{ points: [1, 2, 3] }] }] }), /even number/u);
  assert.equal(content.sketches[0].strokes[0].color, "#1f2937");

  const tooMany = Array.from({ length: 61 }, () => ({ points: Array.from({ length: 1000 }, () => [1, 1]) }));
  assert.throws(
    () => validateEncounterContent({ sketches: [{ sketchId: "s1", strokes: tooMany }] }),
    (error) => error.field === "content.sketches"
  );
});

test("requires patient and date to create an encounter", () => {
  assert.throws(() => validateCreateEncounterInput({ encounterDate: "2026-10-27" }), /patientId/u);
  assert.throws(() => validateCreateEncounterInput({ patientId: "pat_1", encounterDate: "2026/10/27" }), /encounterDate/u);
  assert.equal(validateCreateEncounterInput({ patientId: "pat_1", encounterDate: "2026-10-27" }).visitType, "revisit");
});

test("requires an expected revision for updates", () => {
  assert.throws(() => validateUpdateEncounterInput({ content: {} }), /expectedRevision/u);
  assert.equal(validateUpdateEncounterInput({ expectedRevision: 3, content: {} }).expectedRevision, 3);
});

test("validates drug presets", () => {
  const preset = validateDrugPresetInput({ name: "ヒアレイン点眼液0.1%", defaultTimesPerDay: 4, dropsPerBottle: 120 });
  assert.equal(preset.kind, "eye_drop");
  assert.equal(preset.dropsPerBottle, 120);
  assert.throws(() => validateDrugPresetInput({ name: "x", dropsPerBottle: 0 }), /dropsPerBottle/u);
});

test("allows half-filled rows in drafts", () => {
  const content = validateEncounterContent({ prescriptions: [{ kind: "eye_drop", name: "" }] });
  assert.equal(content.prescriptions[0].name, "");
});
