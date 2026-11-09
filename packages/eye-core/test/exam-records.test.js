import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEncounterContent, validateExamRecords } from "../../eye-contracts/src/index.js";
import {
  applyChartExamEdit,
  buildTrend,
  currentExamRecord,
  deriveExamFromRecords,
  mergePlanItems,
  planItemsFromPreset,
  plannedOrdersFromPlan,
  seedExamRecordFromExam,
  setPlanItemsEye
} from "../src/index.js";

const MORNING = {
  recordId: "r1",
  at: "2026-11-09T00:10:00.000Z",
  examinerMemberId: "m_ort",
  examinerName: "視能 訓子",
  values: {
    vision: {
      far: {
        od: { uncorrected: "0.3", corrected: "1.0", correctionType: "trial", sphere: -1.5, cylinder: -0.5, axis: 180, iolCl: "iol" },
        os: { uncorrected: "0.4", corrected: "1.2", sphere: -1 },
        ou: { uncorrected: "0.5", corrected: "1.2" }
      },
      near: { od: { uncorrected: "0.4", corrected: "0.8", sphere: 1.5 }, os: { uncorrected: "0.5" } },
      comment: "散瞳前"
    },
    refraction: { od: { sphere: -1.75, cylinder: -0.5, axis: 175 }, source: "autoref", device: "KR-800" },
    iop: { od: { readings: [{ value: 15 }, { value: 16 }, { value: 16 }], method: "nct", at: "09:10" }, os: { readings: [14], method: "nct", at: "09:10" } },
    devices: { tonometer: { device: "CT-800", od: { readings: [15, 16, 16] }, raw: "R 15 16 16" } }
  }
};
const AFTERNOON = {
  recordId: "r2",
  at: "2026-11-09T05:00:00.000Z",
  values: { iop: { od: { readings: [{ value: 21 }], method: "goldmann", at: "14:00" } } }
};

function records(...items) {
  return validateExamRecords(items);
}

test("validates exam records into Firestore-safe objects and computes the IOP average", () => {
  const [record] = records(MORNING);
  assert.deepEqual(record.values.iop.od, { readings: [{ value: 15 }, { value: 16 }, { value: 16 }], average: 15.7, method: "nct", at: "09:10" });
  assert.deepEqual(record.values.iop.os.readings, [{ value: 14 }], "plain numbers are stored as objects");
  assert.equal(record.values.iop.os.average, 14);
  assert.deepEqual(record.values.vision.far.ou, { uncorrected: "0.5", corrected: "1.2" });
  assert.equal(record.values.devices.tonometer.od.average, 15.7);
  assert.equal(record.source, "manual");
  // 配列の中に配列がない（Firestore に保存できる）
  const nestedArray = (value) => Array.isArray(value)
    ? value.some((item) => Array.isArray(item) || nestedArray(item))
    : value && typeof value === "object" ? Object.values(value).some(nestedArray) : false;
  assert.equal(nestedArray(record), false);
  assert.deepEqual(validateExamRecords([record]), [record], "validation is idempotent");
  assert.throws(() => records({ ...MORNING, values: { iop: { od: { readings: [1, 2, 3, 4] } } } }), (error) => error.field === "examRecord.values.iop.od.readings" || /readings/u.test(error.field));
  assert.throws(() => records(MORNING, MORNING), /duplicated/u);
  assert.throws(() => records({ ...MORNING, at: "yesterday" }), /ISO/u);
});

test("derives the latest exam from records in time order", () => {
  const exam = deriveExamFromRecords(records(AFTERNOON, MORNING));
  assert.equal(exam.od.vaUncorrected, "0.3");
  assert.equal(exam.od.vaCorrected, "1.0");
  assert.equal(exam.od.vaCorrectionType, "trial");
  assert.deepEqual(exam.od.correction, { sphere: -1.5, cylinder: -0.5, axis: 180 });
  assert.deepEqual(exam.od.refraction, { sphere: -1.75, cylinder: -0.5, axis: 175 });
  assert.equal(exam.od.iop, 21, "the afternoon IOP is the latest");
  assert.equal(exam.od.iopMethod, "goldmann");
  assert.equal(exam.od.measuredAt, "14:00");
  assert.equal(exam.od.vaNear, "0.4");
  assert.equal(exam.os.iop, 14);
  assert.deepEqual(exam.os.correction, { sphere: -1, cylinder: null, axis: null });
  assert.deepEqual(validateEncounterContent({ exam }).exam, exam);
  assert.equal(currentExamRecord(records(AFTERNOON, MORNING)).recordId, "r2");
  assert.deepEqual(deriveExamFromRecords([]), validateEncounterContent({}).exam);
});

test("maps a chart (exam) edit into the current record without losing other record data", () => {
  const before = records(MORNING, AFTERNOON);
  const derived = deriveExamFromRecords(before);
  const edited = {
    ...derived,
    od: { ...derived.od, iop: 19, vaCorrected: "0.9" },
    os: { ...derived.os, pupil: { sizeMm: 3 } },
    binocular: { alignment: "exo" }
  };
  const { records: after, changedPaths } = applyChartExamEdit(before, edited, { actor: { memberId: "m_doc", displayName: "医師" }, now: "2026-11-09T06:00:00.000Z" });
  assert.deepEqual(changedPaths.sort(), ["binocular.alignment", "od.iop", "od.vaCorrected", "os.pupil"]);
  const validated = validateExamRecords(after);
  assert.deepEqual(deriveExamFromRecords(validated), validateEncounterContent({ exam: edited }).exam, "the derived exam equals what the chart sent");
  assert.deepEqual(validated[0], before[0], "the morning record is untouched");
  assert.deepEqual(validated[1].values.iop.od.readings, [{ value: 19 }]);
  assert.equal(validated[1].values.vision.far.od.corrected, "0.9");
  assert.equal(validated[1].updatedBy.memberId, "m_doc");

  // 何も変えなければ記録も変わらない
  assert.equal(applyChartExamEdit(before, derived).records, before);
});

test("clearing a value in the chart keeps older records and marks the field as cleared", () => {
  const before = records(MORNING, AFTERNOON);
  const derived = deriveExamFromRecords(before);
  const edited = { ...derived, od: { ...derived.od, vaUncorrected: "", iop: null } };
  const { records: after } = applyChartExamEdit(before, edited, {});
  const validated = validateExamRecords(after);
  assert.equal(validated[0].values.vision.far.od.uncorrected, "0.3", "the morning value is kept");
  assert.deepEqual(validated[1].cleared, ["od.vaUncorrected", "od.iop"]);
  assert.equal(validated[1].values.iop.od.readings, undefined, "the afternoon reading itself is removed");
  const exam = deriveExamFromRecords(validated);
  assert.equal(exam.od.vaUncorrected, "");
  assert.equal(exam.od.iop, null);
  assert.equal(exam.od.iopMethod, "goldmann", "untouched fields stay");

  // 後で値を入れ直すと印は外れる
  const refilled = applyChartExamEdit(validated, { ...exam, od: { ...exam.od, vaUncorrected: "0.2" } }).records;
  assert.deepEqual(validateExamRecords(refilled)[1].cleared, ["od.iop"]);
  assert.equal(deriveExamFromRecords(validateExamRecords(refilled)).od.vaUncorrected, "0.2");
});

test("seeds the first record from an old exam without changing its values", () => {
  const exam = validateEncounterContent({
    exam: {
      od: { vaUncorrected: "0.1", vaCorrected: "(1.0)", correction: { sphere: -3 }, iop: 15.5, iopMethod: "nct", measuredAt: "09:00", vaNear: "0.5", pupil: { sizeMm: 3, reaction: "brisk" }, keratometry: { k1: 43, k2: 44, axis: 90 } },
      os: { refraction: { sphere: -2, cylinder: -1, axis: 10 }, vaCorrectionType: "glasses" },
      binocular: { rapd: "none", motility: "normal" }
    }
  }).exam;
  const seed = seedExamRecordFromExam(exam, { recordId: "seed", at: "2026-11-09T00:00:00.000Z" });
  assert.equal(seed.source, "chart");
  assert.deepEqual(deriveExamFromRecords(validateExamRecords([seed])), exam);
  assert.equal(seedExamRecordFromExam(validateEncounterContent({}).exam, { recordId: "x", at: "2026-11-09T00:00:00.000Z" }), null);
});

test("adds near VA and IOP averages to the trend without changing the old fields", () => {
  const trend = buildTrend([
    { encounterId: "e1", encounterDate: "2026-10-01", status: "finalized", content: { exam: { od: { vaCorrected: "1.0", iop: 15, vaNear: "0.6" }, os: {} } } },
    { encounterId: "e2", encounterDate: "2026-11-09", status: "finalized", content: { exam: deriveExamFromRecords(records(MORNING)), examRecords: records(MORNING) } }
  ]);
  const [old, recorded] = trend.points;
  assert.equal(old.od.va, 1);
  assert.equal(old.od.iop, 15);
  assert.equal(old.od.vaNear, 0.6);
  assert.equal(old.od.iopAverage, null);
  assert.deepEqual(old.od.iopReadings, []);
  assert.equal(recorded.od.vaNear, 0.8, "near corrected wins over uncorrected");
  assert.equal(recorded.od.vaNearLabel, "0.8");
  assert.equal(recorded.od.iop, 15.7);
  assert.equal(recorded.od.iopAverage, 15.7);
  assert.deepEqual(recorded.od.iopReadings, [15, 16, 16]);
  assert.equal(recorded.os.vaNear, 0.5);
  // 裸眼と矯正を分けた値（視力眼圧の表・グラフ用）
  assert.equal(old.od.vaCorrected, 1);
  assert.equal(old.od.vaCorrectedLabel, "1.0");
  assert.equal(old.od.vaUncorrected, null);
  assert.equal(old.od.correction, null);
});

test("plans next-visit items per eye and turns them into planned orders once", () => {
  const items = planItemsFromPreset("va_iop_dilation");
  assert.deepEqual(items.map((item) => [item.code, item.eye]), [["va", "ou"], ["iop", "ou"], ["dilation", "ou"], ["fundus_dilated", "ou"]]);
  assert.deepEqual(setPlanItemsEye(items, "od").map((item) => item.eye), ["od", "od", "od", "od"]);
  assert.throws(() => setPlanItemsEye(items, "both"));
  const merged = mergePlanItems(items, [{ code: "va", name: "視力検査", eye: "ou" }, { code: "vf_static", name: "静的視野検査", eye: "os" }, { name: "説明", eye: "none" }]);
  assert.equal(merged.length, 6);

  let next = 0;
  const orders = plannedOrdersFromPlan(merged, [{ orderId: "x", code: "va", name: "視力検査", eye: "ou", status: "performed" }], {
    sourceEncounterId: "eenc_prev",
    createOrderId: () => `o${++next}`
  });
  assert.deepEqual(orders.map((order) => [order.code, order.eye, order.kind]), [
    ["iop", "ou", "exam"], ["dilation", "ou", "procedure"], ["fundus_dilated", "ou", "exam"], ["vf_static", "os", "exam"], ["", "", "exam"]
  ]);
  assert.equal(orders[4].name, "説明");
  assert.ok(orders.every((order) => order.status === "planned" && order.sourceEncounterId === "eenc_prev"));
  const content = validateEncounterContent({ orders });
  assert.equal(content.orders[0].sourceEncounterId, "eenc_prev");
  assert.deepEqual(validateEncounterContent(content), content);
});
