import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  collectDeviceReadings,
  copyDeviceValues,
  isoFromClock,
  recordClock,
  sameValues,
  sortRecords,
  writeValue
} from "../lib/exam-record.js";
import { listStageOf, nextExamPatient, nextWaitingPatient } from "../lib/consult-flow.js";
import { activeDiagnoses, ageWithMonths, elapsedLabel, latestIop, latestVision, todayPlan } from "../lib/patient-summary.js";

test("writes record values and drops emptied branches", () => {
  let values = writeValue({}, ["vision", "far", "od", "uncorrected"], "0.3");
  values = writeValue(values, ["vision", "far", "od", "sphere"], -1.25);
  assert.deepEqual(values, { vision: { far: { od: { uncorrected: "0.3", sphere: -1.25 } } } });
  values = writeValue(values, ["vision", "far", "od", "uncorrected"], "");
  values = writeValue(values, ["vision", "far", "od", "sphere"], null);
  assert.deepEqual(values, {}, "clearing the last value removes the empty parents");
  assert.deepEqual(writeValue({ iop: { od: { readings: [{ value: 12 }] } } }, ["iop", "od", "readings"], []), {});
});

test("converts the clinic clock and the record time both ways (JST)", () => {
  assert.equal(isoFromClock("2026-11-09", "09:05"), "2026-11-09T00:05:00.000Z");
  assert.equal(recordClock("2026-11-09T00:05:00.000Z"), "09:05");
  assert.equal(isoFromClock("2026-11-09", "9:5"), "", "an incomplete time is rejected");
  assert.equal(recordClock(""), "");
});

test("sorts records by time and compares values ignoring empty fields", () => {
  const records = [{ recordId: "b", at: "2026-11-09T02:00:00.000Z" }, { recordId: "a", at: "2026-11-09T01:00:00.000Z" }];
  assert.deepEqual(sortRecords(records).map((record) => record.recordId), ["a", "b"]);
  assert.equal(sameValues({ vision: { far: { od: { uncorrected: "1.0", rg: "" } } } }, { vision: { far: { od: { uncorrected: "1.0" } } } }), true);
  assert.equal(sameValues({ pd: { far: 62 } }, { pd: { far: 63 } }), false);
});

test("collects device readings per panel and copies them into the record", () => {
  const records = [
    { recordId: "r2", at: "2026-11-09T02:00:00.000Z", values: { devices: { tonometer: { method: "nct", od: { readings: [{ value: 14 }, { value: 15 }, { value: 15 }, { value: 16 }] } } } } },
    { recordId: "r1", at: "2026-11-09T01:00:00.000Z", values: { devices: { autoref: { pd: 62, od: { representative: { sphere: -2.5, cylinder: -0.75, axis: 180 } } }, kerato: { os: { k1: 43.25, k2: 44, axis: 90 } } } } }
  ];
  const readings = collectDeviceReadings(records);
  assert.equal(readings.autoref.length, 1);
  assert.equal(readings.autoref[0].time, "10:00");
  assert.equal(readings.tonometer.length, 1);
  let values = copyDeviceValues({ vision: { far: { od: { uncorrected: "0.3" } } } }, "autoref", readings.autoref[0].data);
  assert.deepEqual(values.vision.far.od, { uncorrected: "0.3", sphere: -2.5, cylinder: -0.75, axis: 180 });
  assert.equal(values.pd.far, 62);
  values = copyDeviceValues(values, "tonometer", readings.tonometer[0].data);
  assert.deepEqual(values.iop.od, { readings: [{ value: 14 }, { value: 15 }, { value: 15 }], method: "nct" }, "at most three readings are copied");
  values = copyDeviceValues(values, "kerato", readings.kerato[0].data);
  assert.deepEqual(values.keratometry, { os: { k1: 43.25, k2: 44, axis: 90 } });
});

test("picks the next patient for the exam room and for the doctor", () => {
  const appointments = [
    { appointmentId: "a1", patientId: "p1", status: "waiting_doctor", queueNumber: 2, statusHistory: [{ at: "2026-11-09T01:10:00.000Z" }] },
    { appointmentId: "a2", patientId: "p2", status: "waiting_doctor", queueNumber: 1, statusHistory: [{ at: "2026-11-09T01:05:00.000Z" }] },
    { appointmentId: "a3", patientId: "p3", status: "checked_in", queueNumber: 3, statusHistory: [{ at: "2026-11-09T01:00:00.000Z" }] },
    { appointmentId: "a4", patientId: "p4", status: "in_exam", queueNumber: 4, statusHistory: [{ at: "2026-11-09T00:50:00.000Z" }] },
    { appointmentId: "a5", patientId: "", status: "waiting_doctor", queueNumber: 5 }
  ];
  assert.equal(nextWaitingPatient(appointments).appointmentId, "a2", "the earliest to start waiting comes first");
  assert.equal(nextExamPatient(appointments, "p4").appointmentId, "a3", "the current patient is skipped");
  assert.equal(nextExamPatient([], "p1"), null);
  const dilating = { p3: { dilationStartedAt: new Date(Date.parse("2026-11-09T01:00:00.000Z")).toISOString() } };
  assert.equal(listStageOf(appointments[2], dilating, Date.parse("2026-11-09T01:05:00.000Z")), "dark");
  assert.equal(listStageOf(appointments[2], dilating, Date.parse("2026-11-09T01:30:00.000Z")), "exam");
  assert.equal(listStageOf({ status: "done" }), "checkout");
  assert.equal(listStageOf({ status: "cancelled" }), null);
});

test("builds the patient summary from today's records first, then the last finalized chart", () => {
  assert.equal(ageWithMonths("1990-04-15", "2026-11-09"), "36歳6ヵ月");
  assert.equal(elapsedLabel("2026-08-01", "2026-11-09"), "3ヵ月8日");
  const finalized = {
    encounterDate: "2026-08-01",
    content: {
      exam: { od: { vaUncorrected: "0.3", vaCorrected: "1.0", iop: 18, iopMethod: "goldmann" }, os: { iop: 17 } },
      nextVisit: { planItems: [{ code: "va", name: "視力検査", eye: "ou" }] },
      diagnoses: [{ name: "白内障", eye: "ou", status: "active" }, { name: "緑内障", eye: "od", status: "active", primary: true }, { name: "結膜炎", status: "resolved" }]
    }
  };
  const today = {
    encounterDate: "2026-11-09",
    content: {
      exam: { od: { iop: 15.7 }, os: {} },
      examRecords: [{ recordId: "r", at: "2026-11-09T00:30:00.000Z", examinerName: "検査 花子", values: { iop: { od: { readings: [{ value: 15 }, { value: 16 }, { value: 16 }], average: 15.7, method: "nct" } } } }],
      orders: [{ orderId: "o1", name: "眼圧検査", eye: "ou", status: "performed" }, { orderId: "o2", name: "散瞳", eye: "od", status: "planned" }]
    }
  };
  const iop = latestIop({ today, finalized, todayDate: "2026-11-09" });
  assert.deepEqual(iop.od, { readings: [15, 16, 16], average: 15.7 });
  assert.equal(iop.time, "09:30");
  assert.equal(iop.examiner, "検査 花子");
  assert.equal(iop.isToday, true);
  const vision = latestVision({ today, finalized, todayDate: "2026-11-09" });
  assert.equal(vision.date, "2026-08-01", "today has no VA yet, so the finalized chart is used");
  assert.match(vision.far.od, /^0\.3（1\.0/u);
  assert.deepEqual(todayPlan({ today, finalized }).map((item) => `${item.eye}${item.name}${item.done ? "済" : ""}`), ["両眼圧検査済", "右散瞳"]);
  assert.deepEqual(todayPlan({ finalized }).map((item) => `${item.eye}${item.name}`), ["両視力検査"]);
  assert.deepEqual(activeDiagnoses(null, finalized).map((item) => item.name), ["緑内障", "白内障"]);
  assert.equal(latestIop({ finalized: { encounterDate: "2026-08-01", content: { exam: { od: {}, os: {} } } } }), null);
});

test("exam values count near VA, keratometry and pupil; eyes with values also come from records (PD counts for both)", async () => {
  const { eyesWithValues, hasExamValues, recordHasEyeValues } = await import("../lib/exam-record.js");
  assert.equal(hasExamValues({}), false);
  assert.equal(hasExamValues({ vaNear: "0.5" }), true);
  assert.equal(hasExamValues({ keratometry: { k1: 43.5 } }), true);
  assert.equal(hasExamValues({ pupil: { sizeMm: 4 } }), true);
  assert.equal(hasExamValues({ pupil: { reaction: "" }, correction: { sphere: null } }), false);
  assert.equal(recordHasEyeValues({ iop: { os: { readings: [{ value: 15 }] } } }, "od"), false);
  assert.equal(recordHasEyeValues({ iop: { os: { readings: [{ value: 15 }] } } }, "os"), true);
  assert.equal(recordHasEyeValues({ pd: { far: 62 } }, "od"), true);
  assert.deepEqual(eyesWithValues({ exam: { od: {}, os: {} } }), []);
  assert.deepEqual(eyesWithValues({ exam: { od: { iop: 14 }, os: {} } }), ["od"]);
  assert.deepEqual(eyesWithValues({ exam: { od: {}, os: {} }, examRecords: [{ values: { vision: { far: { os: { uncorrected: "0.3" } } } } }] }), ["os"]);
});
