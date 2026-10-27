import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTrend,
  evaluateFinalizeReadiness,
  evaluateOpticalPrescription,
  calculateEyeDropBottles,
  copyContentForRevisit,
  daysUntilNextVisit,
  diffEncounterContent,
  parseVisualAcuity,
  prescriptionLabel,
  suggestNextVisit
} from "../src/index.js";

test("parses decimal visual acuity notations", () => {
  assert.equal(parseVisualAcuity("1.2").decimal, 1.2);
  assert.equal(parseVisualAcuity("0.7p").decimal, 0.7);
  assert.equal(parseVisualAcuity("(1.0×S-1.00D)").decimal, 1);
  assert.equal(parseVisualAcuity("（0.9）").decimal, 0.9);
  assert.deepEqual(parseVisualAcuity("指数弁"), { decimal: null, label: "指数弁" });
  assert.deepEqual(parseVisualAcuity("HM"), { decimal: null, label: "手動弁" });
  assert.deepEqual(parseVisualAcuity(""), { decimal: null, label: "" });
});

test("calculates eye-drop bottles from interval, frequency, and eyes", () => {
  assert.deepEqual(
    calculateEyeDropBottles({ timesPerDay: 1, eye: "ou", days: 84 }),
    { bottles: 2, dropsNeeded: 168, dropsPerBottle: 100, reason: "calculated" }
  );
  assert.equal(calculateEyeDropBottles({ timesPerDay: 4, eye: "od", days: 28, dropsPerBottle: 120 }).bottles, 1);
  assert.equal(calculateEyeDropBottles({ timesPerDay: 4, eye: "ou", days: 28, dropsPerBottle: 120 }).bottles, 2);
  assert.equal(calculateEyeDropBottles({ timesPerDay: 0, eye: "ou", days: 28 }).bottles, null);
  assert.equal(calculateEyeDropBottles({ timesPerDay: 2, days: 28 }).reason, "insufficient_input");
});

test("derives days until next visit from weeks or a date", () => {
  assert.equal(daysUntilNextVisit("2026-10-27", { intervalWeeks: 12 }), 84);
  assert.equal(daysUntilNextVisit("2026-10-27", { date: "2026-11-24" }), 28);
  assert.equal(daysUntilNextVisit("2026-10-27", {}), null);
});

test("suggests the next visit from the previous plan, then the previous interval", () => {
  const planned = [{ encounterId: "e1", encounterDate: "2026-07-01", status: "finalized", content: { nextVisit: { intervalWeeks: 12 } } }];
  assert.equal(suggestNextVisit(planned, "2026-10-01").intervalWeeks, 12);
  assert.equal(suggestNextVisit(planned, "2026-10-01").basis, "previous_plan");

  const unplanned = [{ encounterId: "e1", encounterDate: "2026-09-01", status: "finalized", content: { nextVisit: {} } }];
  assert.equal(suggestNextVisit(unplanned, "2026-10-27").intervalWeeks, 8);
  assert.equal(suggestNextVisit(unplanned, "2026-10-27").basis, "previous_interval");

  assert.equal(suggestNextVisit([], "2026-10-27").basis, "default");
  const draftsOnly = [{ encounterId: "e1", encounterDate: "2026-09-01", status: "draft", content: { nextVisit: { intervalWeeks: 2 } } }];
  assert.equal(suggestNextVisit(draftsOnly, "2026-10-27").basis, "default");
});

test("revisit copy keeps the plan but never copies measurements", () => {
  const copied = copyContentForRevisit({
    chiefComplaint: "見えにくい",
    exam: { od: { vaCorrected: "1.0", iop: 15 }, os: { vaCorrected: "0.9", iop: 16 } },
    findings: { od: { fundus: "C/D 0.7" } },
    diagnoses: [{ name: "緑内障", eye: "ou" }, { name: "結膜炎", eye: "od", status: "resolved" }],
    prescriptions: [{ name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1 }],
    plan: "点眼継続",
    nextVisit: { intervalWeeks: 12, date: "2026-12-01" }
  });

  assert.equal(copied.chiefComplaint, "");
  assert.equal(copied.exam.od.vaCorrected, "");
  assert.equal(copied.exam.od.iop, null);
  assert.equal(copied.findings.od.fundus, "C/D 0.7");
  assert.deepEqual(copied.diagnoses, [], "diagnoses live on the patient profile, not the copied draft");
  assert.equal(copied.prescriptions.length, 1);
  assert.equal(copied.plan, "点眼継続");
  assert.deepEqual(copied.nextVisit, { intervalWeeks: 12, date: "", note: "" });
});

test("lists what changed since the previous visit", () => {
  const changes = diffEncounterContent(
    { exam: { od: { iop: 15 } }, prescriptions: [{ name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1 }] },
    {
      exam: { od: { iop: 19 } },
      prescriptions: [
        { name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1 },
        { name: "チモロール点眼液", eye: "ou", timesPerDay: 2 }
      ]
    }
  );

  assert.deepEqual(changes.map((change) => change.path), ["exam.od.iop", "prescriptions"]);
  assert.equal(changes[0].label, "右眼 眼圧");
  assert.equal(changes[0].before, "15");
  assert.equal(changes[0].after, "19");
  assert.match(changes[1].after, /チモロール/u);

  const notYetMeasured = diffEncounterContent({ chiefComplaint: "かすむ", exam: { od: { iop: 15, vaCorrected: "1.0" } } }, {});
  assert.deepEqual(notYetMeasured, []);
});

test("builds trend series and medication changes from finalized visits only", () => {
  const trend = buildTrend([
    { encounterId: "e3", encounterDate: "2026-09-01", status: "finalized", content: { exam: { od: { vaCorrected: "0.9", iop: 18 }, os: { vaCorrected: "指数弁" } }, prescriptions: [{ kind: "eye_drop", name: "チモロール", eye: "ou", timesPerDay: 2 }] } },
    { encounterId: "e1", encounterDate: "2026-06-01", status: "finalized", content: { exam: { od: { vaCorrected: "1.0", iop: 15 } }, prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト", eye: "ou", timesPerDay: 1 }] } },
    { encounterId: "e2", encounterDate: "2026-08-01", status: "draft", content: { exam: { od: { iop: 30 } } } },
    { encounterId: "e4", encounterDate: "2026-10-01", status: "finalized", content: { prescriptions: [{ kind: "injection", name: "アフリベルセプト", eye: "od" }] } }
  ]);

  assert.deepEqual(trend.points.map((point) => point.encounterDate), ["2026-06-01", "2026-09-01", "2026-10-01"]);
  assert.equal(trend.points[0].od.va, 1);
  assert.equal(trend.points[1].od.iop, 18);
  assert.equal(trend.points[1].os.va, null);
  assert.equal(trend.points[1].os.vaLabel, "指数弁");
  assert.deepEqual(trend.medicationEvents.map((event) => `${event.encounterDate}:${event.type}`), [
    "2026-06-01:started",
    "2026-09-01:started",
    "2026-09-01:stopped",
    "2026-10-01:stopped"
  ]);
  assert.deepEqual(trend.injections, [{ encounterDate: "2026-10-01", label: "アフリベルセプト（右眼）" }]);
});

test("formats prescription labels", () => {
  assert.equal(prescriptionLabel({ name: "ラタノプロスト", eye: "ou", timesPerDay: 1, quantity: 2, unit: "本" }), "ラタノプロスト（両眼 1日1回 2本）");
  assert.equal(prescriptionLabel({ name: "内服薬" }), "内服薬");
});

test("evaluates blockers and warnings before finalization", () => {
  const empty = evaluateFinalizeReadiness({});
  assert.deepEqual(empty.blockers, []);
  assert.deepEqual(empty.warnings.map((item) => item.code), ["chief_complaint_empty", "plan_empty"]);

  const result = evaluateFinalizeReadiness({
    chiefComplaint: "かすむ",
    plan: "経過観察",
    prescriptions: [{ kind: "eye_drop", name: "" }, { kind: "eye_drop", name: "ラタノプロスト", eye: "" }],
    nextVisit: {}
  });
  assert.deepEqual(result.blockers.map((item) => item.code), ["prescription_name_missing", "prescription_eye_missing"]);
  assert.deepEqual(result.warnings.map((item) => item.code), ["next_visit_missing"]);
});

test("checks glasses and contact lens prescriptions only when they are issued", () => {
  assert.deepEqual(evaluateOpticalPrescription({ type: "glasses", issue: false }), []);
  const glasses = evaluateOpticalPrescription({
    type: "glasses",
    issue: true,
    od: { sphere: -2, cylinder: -0.5, axis: null },
    os: { sphere: -1.75 }
  });
  assert.deepEqual(glasses.map((item) => item.code), ["optical_axis_mismatch", "optical_pd_missing"]);
  const contact = evaluateOpticalPrescription({ type: "contact", issue: true, od: { sphere: -3, bc: 8.6, dia: 14.2 }, os: { sphere: -3 } });
  assert.deepEqual(contact.map((item) => item.code), ["optical_cl_fit_missing"]);
});
