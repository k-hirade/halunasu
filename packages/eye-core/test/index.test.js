import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appointmentDisplayStatus,
  countAppointmentSlots,
  datesBetween,
  enteredStatusAt,
  pickNextWaitingAppointment,
  summarizeBillingState,
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
  // 記録として成り立たない行（薬剤名なし）だけが止める。眼の未指定は確認を促す（level high）だけ。
  assert.deepEqual(result.blockers.map((item) => item.code), ["prescription_name_missing"]);
  assert.deepEqual(result.warnings.map((item) => [item.code, item.level]), [["prescription_eye_missing", "high"], ["next_visit_missing", "low"]]);
});

test("finalize readiness warns instead of blocking, except for rows that are not records", () => {
  const result = evaluateFinalizeReadiness({
    findingsText: "右眼の充血。前房清明。",
    plan: "経過観察",
    exam: { od: { iop: 18 }, os: {} },
    orders: [{ orderId: "o1", name: "OCT", status: "planned" }, { orderId: "c1", kind: "comment", rpId: "rp1", text: "" }],
    prescriptions: [{ kind: "comment", rpId: "rp9", text: "一包化" }],
    diagnoses: [{ name: "" }],
    optical: { issue: true, type: "glasses", od: {}, os: {} }
  }, { examConfirmations: { od: null, os: null } });
  assert.deepEqual(result.blockers.map((item) => item.code), ["comment_text_missing", "diagnosis_name_missing"]);
  const codes = result.warnings.map((item) => item.code);
  assert.ok(codes.includes("exam_unconfirmed"));
  assert.ok(codes.includes("order_planned"));
  assert.ok(codes.includes("optical_sphere_missing"));
  assert.ok(!codes.includes("chief_complaint_empty"), "the free-text findings can carry the chief complaint");
  assert.ok(!codes.includes("next_visit_missing"), "comment rows alone are not a prescription");
});

test("finalize readiness asks to confirm allergies before drugs and notes exam values without an order", () => {
  const base = { chiefComplaint: "かすむ", plan: "継続", nextVisit: { intervalWeeks: 4 } };
  const drugs = { ...base, prescriptions: [{ kind: "injection", name: "アフリベルセプト", eye: "od" }] };
  const codes = (content, options) => evaluateFinalizeReadiness(content, options).warnings.map((item) => [item.code, item.level]);
  // 患者の情報を渡さないときは見ない（従来どおり）
  assert.deepEqual(codes(drugs), []);
  assert.deepEqual(codes(drugs, { allergyProfile: { allergies: [], noKnownAllergies: false } }), [["allergy_unconfirmed", "high"]]);
  assert.deepEqual(codes(drugs, { allergyProfile: { allergies: [], noKnownAllergies: true } }), []);
  assert.deepEqual(codes(drugs, { allergyProfile: { allergies: [{ substance: "ペニシリン" }], noKnownAllergies: false } }), []);
  // 処方が無ければアレルギーは問わない
  assert.deepEqual(codes(base, { allergyProfile: { allergies: [], noKnownAllergies: false } }), []);

  const exam = { ...base, exam: { od: { vaCorrected: "1.2", iop: 14 }, os: {} } };
  const missing = evaluateFinalizeReadiness(exam).warnings;
  assert.deepEqual(missing.map((item) => [item.code, item.level]), [["exam_order_missing", "low"], ["exam_order_missing", "low"]]);
  assert.match(missing[0].message, /視力/);
  assert.match(missing[1].message, /眼圧/);
  const ordered = { ...exam, orders: [{ orderId: "o1", code: "va", name: "視力検査", status: "performed" }, { orderId: "o2", name: "精密眼圧測定（GAT）", status: "performed" }] };
  assert.deepEqual(evaluateFinalizeReadiness(ordered).warnings, []);
  const cancelled = { ...exam, orders: ordered.orders.map((order) => ({ ...order, status: "cancelled" })) };
  assert.equal(evaluateFinalizeReadiness(cancelled).warnings.length, 2);
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

test("prescriptions carried over to a revisit are flagged for review before finalizing", () => {
  const copied = copyContentForRevisit({ prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト点眼液", eye: "ou", timesPerDay: 1 }] });
  assert.equal(copied.prescriptions[0].carriedOver, true);
  const pending = evaluateFinalizeReadiness({ ...copied, chiefComplaint: "定期", plan: "継続", nextVisit: { intervalWeeks: 8 } });
  assert.deepEqual(pending.blockers, []);
  assert.deepEqual(pending.warnings.map((item) => [item.code, item.level]), [["prescription_carried_over", "high"]]);
  const confirmed = { ...copied, prescriptions: copied.prescriptions.map((item) => ({ ...item, carriedOver: false })) };
  assert.deepEqual(evaluateFinalizeReadiness({ ...confirmed, chiefComplaint: "定期", plan: "継続", nextVisit: { intervalWeeks: 8 } }).warnings, []);
});

test("document text helpers format chart data the same way the letter templates do", async () => {
  const { documentDiagnoses, documentDiagnosisText, documentFindingLines, documentIopLine, documentVaLine, isNormalFinding, documentAllergyText } = await import("../src/index.js");
  const exam = { od: { vaUncorrected: "0.9", vaCorrected: "1.2", iop: 14 }, os: { vaCorrected: "0.6", iop: null } };
  assert.equal(documentVaLine(exam), "視力 右 0.9（1.2）　左 —（0.6）");
  assert.equal(documentIopLine(exam), "眼圧 右 14 mmHg　左 —");
  const findings = { od: { anterior: "清明", lens: "IOL 嚢内固定", fundus: "異常なし。" }, os: { anterior: "", lens: "核白内障 NS2", fundus: "特記事項なし" } };
  assert.deepEqual(documentFindingLines(findings).map((item) => item.text), [
    "右眼 前眼部: 清明", "右眼 中間透光体: IOL 嚢内固定", "右眼 眼底: 異常なし。", "左眼 中間透光体: 核白内障 NS2", "左眼 眼底: 特記事項なし"
  ]);
  assert.deepEqual(documentFindingLines(findings, { abnormalOnly: true }).map((item) => item.text), ["右眼 中間透光体: IOL 嚢内固定", "左眼 中間透光体: 核白内障 NS2"]);
  assert.equal(isNormalFinding("前房深く清明"), false, "only whole-text normal phrases are treated as normal");
  const diagnoses = documentDiagnoses({ diagnoses: [{ name: "緑内障", eye: "ou", status: "suspected" }, { name: "結膜炎", eye: "od", status: "resolved" }, { name: "", eye: "os" }] });
  assert.deepEqual(diagnoses.map(documentDiagnosisText), ["両眼 緑内障（疑い）"]);
  assert.equal(documentAllergyText({ allergies: [{ substance: "ヨード", reaction: "発疹", severity: "severe" }] }), "ヨード（発疹・重篤）");
  assert.equal(documentAllergyText({ noKnownAllergies: true }), "なし");
  assert.equal(documentAllergyText(null), "未確認");
});

test("derives the printable staff name from the print name or the display name", async () => {
  const { printableStaffName } = await import("../src/index.js");
  assert.equal(printableStaffName("院長（管理者・医師）"), "院長");
  assert.equal(printableStaffName("山田 太郎 (医師)"), "山田 太郎");
  assert.equal(printableStaffName("院長（管理者・医師）", "  山田 一郎 "), "山田 一郎");
  assert.equal(printableStaffName("（医師）"), "（医師）");
  assert.equal(printableStaffName("佐藤（旧姓 鈴木）花子"), "佐藤（旧姓 鈴木）花子");
  assert.equal(printableStaffName(""), "");
});

test("revisit copy follows the no-measurement policy for the added fields", () => {
  const copied = copyContentForRevisit({
    exam: {
      od: { vaNear: "0.8", pupil: { sizeMm: 3, reaction: "brisk" }, keratometry: { k1: 43, k2: 44, axis: 90 } },
      binocular: { rapd: "none", alignment: "ortho" }
    },
    findings: { od: { fundus: "異常なし", other: "眼瞼正常", cdRatio: 0.6, angle: "3", angleNote: "開放" }, general: "全身状態良好" },
    counselling: { topics: ["dilation"], consent: "obtained" },
    adherence: { status: "good" }
  });
  assert.deepEqual(Object.keys(copied.exam), ["od", "os"], "binocular values are not copied");
  assert.equal("pupil" in copied.exam.od, false);
  assert.equal("vaNear" in copied.exam.od, false);
  assert.equal("keratometry" in copied.exam.od, false);
  assert.deepEqual(copied.findings.od, { anterior: "", lens: "", fundus: "異常なし", other: "眼瞼正常" }, "C/D and angle are re-measured, free text is copied");
  assert.equal(copied.findings.general, "全身状態良好");
  assert.equal("counselling" in copied, false);
  assert.equal("adherence" in copied, false);
});

test("labels changes in the added fields", () => {
  const changes = diffEncounterContent(
    { findings: { od: { other: "眼瞼浮腫" }, os: { cdRatio: 0.5 } } },
    {
      exam: { od: { pupil: { sizeMm: 3, reaction: "sluggish" } }, binocular: { rapd: "od", alignment: "exo", alignmentNote: "10Δ" } },
      findings: { od: { other: "眼瞼浮腫軽快" }, os: { cdRatio: 0.6 }, general: "血圧高め" },
      adherence: { status: "poor" },
      counselling: { topics: ["eye_drop"], recipient: "patient", consent: "not_required" }
    }
  );
  const byPath = Object.fromEntries(changes.map((change) => [change.path, change]));
  assert.equal(byPath["findings.od.other"].label, "右眼 所見その他");
  assert.equal(byPath["findings.general"].after, "血圧高め");
  assert.equal(byPath["findings.os.cdRatio"].label, "左眼 C/D 比");
  assert.equal(byPath["findings.os.cdRatio"].after, "0.6");
  assert.equal(byPath["exam.od.pupil"].after, "3mm 対光反射 緩慢");
  assert.equal(byPath["exam.binocular.rapd"].after, "右眼");
  assert.equal(byPath["exam.binocular.alignment"].after, "外斜位 10Δ");
  assert.equal(byPath.adherence.after, "不良");
  assert.equal(byPath.counselling.after, "点眼指導（本人） 同意不要");
  // 毎回測る値は今回まだ空なら数えない
  assert.deepEqual(diffEncounterContent({ findings: { od: { cdRatio: 0.5 } }, adherence: { status: "good" } }, {}), []);
});

test("finalize readiness adds no blockers for the added fields", () => {
  const { blockers } = evaluateFinalizeReadiness({
    exam: { od: { pupil: { sizeMm: 3 } }, binocular: { rapd: "none" } },
    counselling: { note: "説明" },
    adherence: { status: "unknown" }
  }, { examConfirmations: { od: null, os: null } });
  assert.deepEqual(blockers, []);
});

test("derives 再計待 and the legacy absent status for the reception list", () => {
  assert.equal(appointmentDisplayStatus({ status: "done" }, "changed"), "rebill_waiting");
  assert.equal(appointmentDisplayStatus({ status: "checkout" }, "changed"), "rebill_waiting");
  assert.equal(appointmentDisplayStatus({ status: "done" }, "handed_off"), "done");
  assert.equal(appointmentDisplayStatus({ status: "in_consult" }, "changed"), "in_consult");
  assert.equal(appointmentDisplayStatus({ status: "no_show" }), "absent");
  assert.equal(summarizeBillingState(["handed_off", "changed", "pending"]), "changed");
  assert.equal(summarizeBillingState(["handed_off", "draft"]), "draft");
  assert.equal(summarizeBillingState(["handed_off"]), "handed_off");
  assert.equal(summarizeBillingState([]), "none");
});

test("picks the patient who has waited longest for the doctor", () => {
  const appointments = [
    { appointmentId: "a", patientId: "p1", status: "waiting_doctor", queueNumber: 1, statusHistory: [{ status: "waiting_doctor", at: "2026-11-09T01:20:00Z" }] },
    { appointmentId: "b", patientId: "p2", status: "waiting_doctor", queueNumber: 2, statusHistory: [{ status: "waiting_doctor", at: "2026-11-09T01:05:00Z" }, { status: "in_exam", at: "2026-11-09T01:06:00Z" }, { status: "waiting_doctor", at: "2026-11-09T01:10:00Z" }] },
    { appointmentId: "c", patientId: "p3", status: "in_consult", queueNumber: 3, statusHistory: [{ status: "waiting_doctor", at: "2026-11-09T00:00:00Z" }] },
    { appointmentId: "d", patientId: "p4", status: "waiting_doctor", queueNumber: 4, checkedInAt: "2026-11-09T01:10:00Z" }
  ];
  assert.equal(enteredStatusAt(appointments[1]), "2026-11-09T01:10:00Z", "the last time it entered the status counts");
  assert.equal(pickNextWaitingAppointment(appointments).appointmentId, "b", "same time: smaller queue number first");
  assert.equal(pickNextWaitingAppointment(appointments, { excludePatientId: "p2" }).appointmentId, "d");
  assert.equal(pickNextWaitingAppointment([]), null);
});

test("counts appointments per day, hour and half hour for the booking grid", () => {
  assert.deepEqual(datesBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  const days = countAppointmentSlots([
    { date: "2026-11-02", time: "09:00", status: "booked" },
    { date: "2026-11-02", time: "09:59", status: "checked_in" },
    { date: "2026-11-02", time: "", status: "booked" },
    { date: "2026-11-02", time: "", status: "checked_in", walkIn: true },
    { date: "2026-11-02", time: "11:00", status: "waiting_doctor", walkIn: true },
    { date: "2026-11-02", time: "10:00", status: "cancelled" },
    { date: "2026-11-02", time: "10:00", status: "no_show" },
    { date: "2026-11-05", time: "10:00", status: "booked" }
  ], { from: "2026-11-02", to: "2026-11-03" });
  assert.deepEqual(days, [
    { date: "2026-11-02", total: 3, untimed: 1, slots: { "09": 2 }, halfSlots: { "09:00": 1, "09:30": 1 } },
    { date: "2026-11-03", total: 0, untimed: 0, slots: {}, halfSlots: {} }
  ]);
});

test("groups Rps, labels comment rows and suspected or modified diagnoses, and copies the free-text findings", async () => {
  const core = await import("../src/index.js");
  const groups = core.groupRps([
    { name: "A", rpId: "r1" }, { name: "legacy" }, { kind: "comment", rpId: "r1", text: "注" }, { name: "B", rpId: "r1" }
  ]);
  assert.deepEqual(groups.map((group) => [group.rpId, group.legacy, group.items.map((item) => item.index), group.comments.map((item) => item.index)]), [
    ["r1", false, [0, 3], [2]],
    ["row-1", true, [1], []]
  ]);
  assert.equal(groups[0].head.name, "A");
  assert.equal(prescriptionLabel({ kind: "comment", text: "一包化" }), "※一包化");
  assert.equal(core.diagnosisName({ name: "白内障", modifiers: [{ name: "右", position: "prefix" }, { name: "の疑い", position: "suffix" }] }), "右白内障の疑い");
  assert.equal(core.diagnosisName({ name: "右白内障", modifiers: [{ name: "右" }] }), "右白内障");

  const copied = copyContentForRevisit({ findingsText: "前房清明", prescriptions: [{ name: "A", rpId: "r1" }, { kind: "comment", rpId: "r1", text: "注" }] });
  assert.equal(copied.findingsText, "前房清明");
  assert.equal(copied.prescriptions[0].carriedOver, true);
  assert.equal("carriedOver" in copied.prescriptions[1], false, "comments are not prescriptions to confirm");
  assert.equal("findingsText" in copyContentForRevisit({}), false);
  const changes = diffEncounterContent({ findingsText: "前回", diagnoses: [{ name: "緑内障", status: "suspected" }] }, { findingsText: "今回", diagnoses: [{ name: "緑内障", suspected: true }] });
  assert.deepEqual(changes.map((item) => item.path), ["findingsText"], "the old suspected status and the new flag are the same diagnosis");
});
