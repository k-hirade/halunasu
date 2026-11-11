import assert from "node:assert/strict";
import { test } from "node:test";
import { validateExamRecordValues } from "../../../packages/eye-contracts/src/index.js";
import { detectKind, parseDeviceText, previewLines, splitEye, withImportedDevice } from "../lib/device-import.js";

const NOW = new Date("2026-11-11T01:00:00Z");

test("reads plain AR rows per eye and passes the contract", () => {
  const result = parseDeviceText("R -1.25 -0.50 180\nL -2.00 -0.75 90", "autoref", NOW);
  assert.equal(result.kind, "autoref");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.data.od.readings, [{ sphere: -1.25, cylinder: -0.5, axis: 180 }]);
  assert.deepEqual(result.data.os.readings, [{ sphere: -2, cylinder: -0.75, axis: 90 }]);
  assert.equal(result.data.device, "手入力取込");
  assert.equal(result.data.measuredAt, NOW.toISOString());
  const values = validateExamRecordValues(withImportedDevice({}, result.kind, result.data));
  assert.deepEqual(values.devices.autoref.od.readings[0], { sphere: -1.25, cylinder: -0.5, axis: 180 });
});

test("reads labelled printouts with eye headers, several readings, a representative value and PD", () => {
  const text = "2026/11/11 10:30\n<R>\nS-1.25 C-0.50 A180\nS-1.50 C-0.50 A178\n* S-1.25 C-0.50 A180\n<L>\nS-2.00 C-0.75 A90\nPD 63";
  const result = parseDeviceText(text, "auto", NOW);
  assert.equal(result.kind, "autoref");
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.od.readings.length, 2);
  assert.deepEqual(result.data.od.representative, { sphere: -1.25, cylinder: -0.5, axis: 180 });
  assert.equal(result.data.pd, 63);
  validateExamRecordValues({ devices: { autoref: result.data } });
});

test("reads Japanese eye marks and full-width digits", () => {
  const result = parseDeviceText("右　－１．００　－０．２５　１０\n左眼 -0.75 0 0", "autoref", NOW);
  assert.deepEqual(result.data.od.readings[0], { sphere: -1, cylinder: -0.25, axis: 10 });
  assert.deepEqual(result.data.os.readings[0], { sphere: -0.75, cylinder: 0, axis: 0 });
});

test("reads NCT CSV rows and recomputes the average", () => {
  const result = parseDeviceText("eye,1,2,3\nR,14,15,14\nL,16,17,16 AVG 16.3", "auto", NOW);
  assert.equal(result.kind, "tonometer");
  assert.deepEqual(result.data.od.readings.map((item) => item.value), [14, 15, 14]);
  assert.equal(result.data.od.average, 14.3);
  assert.deepEqual(result.data.os.readings.map((item) => item.value), [16, 17, 16]);
  assert.equal(result.data.method, "nct");
  validateExamRecordValues({ devices: { tonometer: result.data } });
});

test("reads keratometry as K values or radii (mm → D)", () => {
  const labelled = parseDeviceText("R K1 43.50 K2 44.25 A 90\nL K1 43.75 K2 44.00 A 85", "auto", NOW);
  assert.equal(labelled.kind, "kerato");
  assert.deepEqual(labelled.data.od, { k1: 43.5, k2: 44.25, axis: 90 });
  const radii = parseDeviceText("<R> 7.76 7.63 180", "kerato", NOW);
  assert.equal(radii.data.od.r1, 7.76);
  assert.equal(radii.data.od.k1, 43.49);
  assert.equal(radii.data.od.axis, 180);
  validateExamRecordValues({ devices: { kerato: labelled.data } });
  validateExamRecordValues({ devices: { kerato: radii.data } });
});

test("reports unreadable lines instead of guessing", () => {
  const result = parseDeviceText("-1.25 -0.50 180\nR -60 0 0\nR -1.00 -0.25 200\nL -1.00", "autoref", NOW);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0].message, /右眼/u);
  assert.equal(result.data.od, undefined);
  assert.deepEqual(result.data.os.readings, [{ sphere: -1 }]);
});

test("keeps only the newest 10 readings per eye", () => {
  const text = Array.from({ length: 12 }, (_, index) => `R ${index + 10}`).join("\n");
  const result = parseDeviceText(text, "tonometer", NOW);
  assert.equal(result.data.od.readings.length, 10);
  assert.equal(result.data.od.readings[0].value, 12);
  assert.ok(result.errors.some((item) => /10 回/u.test(item.message)));
});

test("helpers: eye split, kind detection, preview, R1 is not an eye mark", () => {
  assert.deepEqual(splitEye("<R>S-1.25"), { eye: "od", rest: "S-1.25" });
  assert.equal(splitEye("R1 7.80").eye, "");
  assert.equal(detectKind("R 14 15 14"), "tonometer");
  assert.equal(detectKind("R -1.25 -0.50 180"), "autoref");
  const result = parseDeviceText("R -1.25 -0.50 180", "autoref", NOW);
  assert.deepEqual(previewLines("autoref", result.data), ["R  S-1.25 C-0.50 A180"]);
  assert.deepEqual(withImportedDevice({ devices: { kerato: { device: "x" } } }, "autoref", { device: "y" }).devices, { kerato: { device: "x" }, autoref: { device: "y" } });
});
