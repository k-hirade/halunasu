import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPOINTMENT_STATUS_LABELS,
  APPOINTMENT_STATUS_MENU,
  APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITIONS,
  assertAppointmentTransition,
  isActiveAppointmentStatus,
  normalizeAppointmentStatus,
  validateAppointmentRangeInput,
  validateAppointmentStatusInput,
  validateBillingSendInput,
  validateCloseEncounterInput,
  validateCreateAppointmentInput,
  validatePatientProfileInput,
  validateUpdateAppointmentInput,
  validateCreateEncounterInput,
  validateDrugPresetInput,
  validateEncounterContent,
  validateStaffProfileInput,
  validateUpdateDocumentInput,
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

test("classifies audit events into the filter categories", async () => {
  const { AUDIT_CATEGORIES, auditEventCategory } = await import("../src/index.js");
  assert.equal(auditEventCategory("eye.chart_viewed"), "view");
  assert.equal(auditEventCategory("eye.encounter_finalized"), "finalize");
  assert.equal(auditEventCategory("eye.document_finalized"), "finalize");
  assert.equal(auditEventCategory("eye.clinic_exported"), "export");
  assert.equal(auditEventCategory("eye.billing_handed_off"), "export");
  assert.equal(auditEventCategory("eye.drug_preset_saved"), "settings");
  assert.equal(auditEventCategory("eye.phrase_saved"), "settings");
  assert.equal(auditEventCategory("eye.encounter_updated"), "change");
  assert.equal(auditEventCategory("eye.appointment_status_changed"), "change");
  assert.equal(auditEventCategory("eye.something_new"), "other");
  assert.equal(auditEventCategory(undefined), "other");
  for (const category of ["view", "change", "finalize", "export", "settings"]) assert.ok(AUDIT_CATEGORIES.includes(category));
});

test("keeps old optical data unchanged and accepts the prescription details", () => {
  const legacy = validateEncounterContent({ optical: { type: "glasses", od: { sphere: -1 }, os: { sphere: -1.5 }, pd: 62 } }).optical;
  for (const key of ["material", "coating", "tint", "wearMode", "wearSchedule", "replacement"]) {
    assert.equal(key in legacy, false, `${key} is absent on old data`);
  }
  const detailed = validateEncounterContent({
    optical: { type: "glasses", material: "polycarbonate", coating: " UVカット ", tint: "グレー", wearMode: "as_needed", wearSchedule: "", replacement: null }
  }).optical;
  assert.equal(detailed.material, "polycarbonate");
  assert.equal(detailed.coating, "UVカット");
  assert.equal(detailed.tint, "グレー");
  assert.equal(detailed.wearMode, "as_needed");
  assert.equal("wearSchedule" in detailed, false);
  assert.equal("replacement" in detailed, false);
  const contact = validateEncounterContent({ optical: { type: "contact", wearSchedule: "daily_wear", replacement: "two_weeks" } }).optical;
  assert.equal(contact.wearSchedule, "daily_wear");
  assert.equal(contact.replacement, "two_weeks");
  assert.throws(() => validateEncounterContent({ optical: { material: "glass" } }), /content.optical.material/u);
  assert.throws(() => validateEncounterContent({ optical: { wearMode: "sometimes" } }), /content.optical.wearMode/u);
  assert.throws(() => validateEncounterContent({ optical: { replacement: "weekly" } }), /content.optical.replacement/u);
  assert.throws(() => validateEncounterContent({ optical: { coating: "x".repeat(41) } }), /content.optical.coating/u);
});

test("accepts a recipient honorific and keeps old recipients without one", () => {
  const legacy = validateUpdateDocumentInput({ expectedRevision: 1, recipient: { institution: "県立病院" } });
  assert.deepEqual(legacy.recipient, { institution: "県立病院", department: "", doctor: "" });
  const withHonorific = validateUpdateDocumentInput({ expectedRevision: 1, recipient: { institution: "県立病院", honorific: "御中" } });
  assert.equal(withHonorific.recipient.honorific, "御中");
  assert.throws(() => validateUpdateDocumentInput({ expectedRevision: 1, recipient: { honorific: "様" } }), /recipient.honorific/u);
});

test("validates the print name length", () => {
  assert.deepEqual(validateStaffProfileInput({ printName: " 山田 太郎 " }), { printName: "山田 太郎" });
  assert.deepEqual(validateStaffProfileInput({}), { printName: "" });
  assert.throws(() => validateStaffProfileInput({ printName: "x".repeat(41) }), /printName/u);
});

// ---- 追加項目（2026-11: SOAP の目印と所見・検査の追加） ----

const OLD_CONTENT = {
  chiefComplaint: "見えにくい",
  exam: { od: { vaCorrected: "1.0", iop: 15, iopMethod: "nct" }, os: { vaUncorrected: "0.3" } },
  findings: { od: { anterior: "異常なし" }, os: { fundus: "C/D 0.6" } },
  plan: "経過観察"
};

test("old content without the new fields validates to exactly the same shape", () => {
  const content = validateEncounterContent(OLD_CONTENT);
  assert.deepEqual(Object.keys(content.exam), ["od", "os"]);
  assert.deepEqual(Object.keys(content.exam.od), ["vaUncorrected", "vaCorrected", "correction", "refraction", "iop", "iopMethod", "vaCorrectionType", "measuredAt"]);
  assert.deepEqual(Object.keys(content.findings), ["od", "os"]);
  assert.deepEqual(Object.keys(content.findings.od), ["anterior", "lens", "fundus"]);
  assert.equal("counselling" in content, false);
  assert.equal("adherence" in content, false);
  // 2 回通しても変わらない（確定時の内容ハッシュが変わらない）
  assert.deepEqual(validateEncounterContent(content), content);
});

test("round-trips the new exam fields (near VA, pupil, keratometry, binocular)", () => {
  const content = validateEncounterContent({
    exam: {
      od: { vaNear: "0.8", pupil: { sizeMm: "3.5", reaction: "brisk" }, keratometry: { k1: "43.25", k2: 44.5, axis: "180" } },
      os: { pupil: { sizeMm: 4, reaction: "sluggish" }, keratometry: {} },
      binocular: { rapd: "os", alignment: "exo", alignmentNote: "15Δ", motility: "limited", motilityNote: "外転制限" }
    }
  });
  assert.equal(content.exam.od.vaNear, "0.8");
  assert.deepEqual(content.exam.od.pupil, { sizeMm: 3.5, reaction: "brisk" });
  assert.deepEqual(content.exam.od.keratometry, { k1: 43.25, k2: 44.5, axis: 180 });
  assert.deepEqual(content.exam.os.pupil, { sizeMm: 4, reaction: "sluggish" });
  assert.equal("keratometry" in content.exam.os, false, "empty objects are not kept");
  assert.deepEqual(content.exam.binocular, { rapd: "os", alignment: "exo", alignmentNote: "15Δ", motility: "limited", motilityNote: "外転制限" });
  assert.deepEqual(validateEncounterContent(content), content);

  const cleared = validateEncounterContent({ exam: { od: { pupil: { sizeMm: null, reaction: "" } }, binocular: { rapd: "" } } });
  assert.equal("pupil" in cleared.exam.od, false);
  assert.equal("binocular" in cleared.exam, false);

  assert.throws(() => validateEncounterContent({ exam: { od: { pupil: { reaction: "fast" } } } }), (error) => error.field === "content.exam.od.pupil.reaction");
  assert.throws(() => validateEncounterContent({ exam: { binocular: { rapd: "ou" } } }), (error) => error.field === "content.exam.binocular.rapd");
  assert.throws(() => validateEncounterContent({ exam: { os: { keratometry: { k1: 90 } } } }), (error) => error.field === "content.exam.os.keratometry.k1");
});

test("round-trips the new findings fields (other, C/D, angle, general)", () => {
  const content = validateEncounterContent({
    findings: {
      od: { anterior: "清明", other: "眼瞼腫脹なし", cdRatio: "0.7", angle: "3", angleNote: "van Herick 1/2" },
      os: { cdRatio: 0, other: "" },
      general: "全身状態良好"
    }
  });
  assert.deepEqual(content.findings.od, { anterior: "清明", lens: "", fundus: "", other: "眼瞼腫脹なし", cdRatio: 0.7, angle: "3", angleNote: "van Herick 1/2" });
  assert.deepEqual(content.findings.os, { anterior: "", lens: "", fundus: "", cdRatio: 0 });
  assert.equal(content.findings.general, "全身状態良好");
  assert.deepEqual(validateEncounterContent(content), content);
  assert.throws(() => validateEncounterContent({ findings: { od: { cdRatio: 1.2 } } }), (error) => error.field === "content.findings.od.cdRatio");
});

test("round-trips counselling and adherence as optional top-level sections", () => {
  const content = validateEncounterContent({
    counselling: { topics: ["dilation", "eye_drop", "dilation"], recipient: "both", consent: "obtained", note: "運転しないよう説明" },
    adherence: { status: "sometimes", note: "夜を忘れる" }
  });
  assert.deepEqual(content.counselling, { topics: ["dilation", "eye_drop"], recipient: "both", consent: "obtained", note: "運転しないよう説明" });
  assert.deepEqual(content.adherence, { status: "sometimes", note: "夜を忘れる" });
  assert.deepEqual(validateEncounterContent(content), content);
  assert.deepEqual(validateEncounterContent({ counselling: null }).counselling, {});
  assert.throws(() => validateEncounterContent({ counselling: { topics: ["x"] } }), (error) => error.field === "content.counselling.topics.0");
  assert.throws(() => validateEncounterContent({ adherence: { status: "perfect" } }), (error) => error.field === "content.adherence.status");

  // 項目ごとの保存（sections）で新しい項目を送れる。消すときは空のオブジェクトになる。
  const update = validateUpdateEncounterInput({ expectedRevision: 1, sections: { counselling: { consent: "not_required" }, adherence: {} } });
  assert.deepEqual(update.sections, { counselling: { consent: "not_required" }, adherence: {} });
});

test("accepts the new phrase targets", async () => {
  const { validatePhraseInput, PHRASE_TARGETS, PER_EYE_PHRASE_TARGETS } = await import("../src/index.js");
  for (const target of ["findings.other", "findings.general", "counselling.note"]) {
    assert.equal(validatePhraseInput({ target, text: "x" }).target, target);
    assert.ok(PHRASE_TARGETS.includes(target));
  }
  assert.ok(PER_EYE_PHRASE_TARGETS.includes("findings.other"));
  assert.ok(!PER_EYE_PHRASE_TARGETS.includes("findings.general"));
});

test("next-visit plan items and exam records are optional and keep old content unchanged", async () => {
  const { validateExamRecordInput, PLAN_ITEM_EYES } = await import("../src/index.js");
  const old = validateEncounterContent({ nextVisit: { intervalWeeks: 4 }, examRecords: [] });
  assert.deepEqual(Object.keys(old.nextVisit), ["intervalWeeks", "date", "note"]);
  assert.equal("examRecords" in old, false);

  const planned = validateEncounterContent({ nextVisit: { intervalWeeks: 12, planItems: [{ code: "va", name: "視力検査", eye: "ou" }, { name: "説明", comment: "OP 説明" }] } });
  assert.deepEqual(planned.nextVisit.planItems, [{ code: "va", name: "視力検査", eye: "ou" }, { code: "", name: "説明", eye: "none", comment: "OP 説明" }]);
  assert.deepEqual(validateEncounterContent(planned), planned);
  assert.deepEqual(PLAN_ITEM_EYES, ["od", "os", "ou", "none"]);
  assert.throws(() => validateEncounterContent({ nextVisit: { planItems: [{ eye: "ou" }] } }), (error) => error.field === "content.nextVisit.planItems.0.name");
  assert.throws(() => validateEncounterContent({ nextVisit: { planItems: [{ code: "va", eye: "both" }] } }), (error) => error.field === "content.nextVisit.planItems.0.eye");

  // examRecords は PATCH の sections では送れない（専用の API だけで変える）
  assert.throws(() => validateUpdateEncounterInput({ expectedRevision: 1, sections: { examRecords: [] } }), (error) => error.field === "sections");

  const input = validateExamRecordInput({ expectedRevision: 3, at: "2026-11-09T09:00:00+09:00", values: { iop: { od: { readings: [12, 13] } } } });
  assert.equal(input.at, "2026-11-09T00:00:00.000Z");
  assert.equal(input.values.iop.od.average, 12.5);
  const patch = validateExamRecordInput({ expectedRevision: 3, note: "散瞳後" }, { partial: true });
  assert.equal(patch.values, undefined, "values not sent are left as they are");
  assert.equal(patch.note, "散瞳後");
  assert.throws(() => validateExamRecordInput({ expectedRevision: 0 }), (error) => error.field === "expectedRevision");
  assert.throws(() => validateExamRecordInput({ expectedRevision: 1, values: { vision: { far: { od: { iolCl: "glasses" } } } } }), (error) => error.field === "values.vision.far.od.iolCl");
});

test("exam records hold PD, the grid condition and the binocular / gaze / text tests (all optional)", async () => {
  const { validateExamRecordValues } = await import("../src/index.js");
  assert.deepEqual(validateExamRecordValues({ tests: {}, pd: {} }), {}, "empty tests are dropped");
  const values = validateExamRecordValues({
    vision: { condition: "5m 字ひとつ", far: { ou: { corrected: "1.2" } } },
    pd: { far: 62, near: "59" },
    tests: {
      worth: { fixingEye: "od", distance: "near", pattern: "four" },
      cover: { near: { fixingEye: "os", kind: "phoria", direction: "exo", amount: "8" }, far: {} },
      nineGaze: { condition: "裸眼", cells: { up_right: { od: "normal", os: "-2" }, center: {} } },
      color: { test: "石原", od: "正常", os: "" },
      other: { name: "涙液", text: "BUT 5秒" }
    }
  });
  assert.equal(values.vision.condition, "5m 字ひとつ");
  assert.deepEqual(values.pd, { far: 62, near: 59 });
  assert.deepEqual(values.tests.cover, { near: { fixingEye: "os", kind: "phoria", direction: "exo", amount: "8" } });
  assert.deepEqual(values.tests.nineGaze, { condition: "裸眼", cells: { up_right: { od: "normal", os: "-2" } } });
  assert.deepEqual(values.tests.color, { test: "石原", od: "正常" });
  assert.deepEqual(validateExamRecordValues(values), values, "validation is stable");
  assert.throws(() => validateExamRecordValues({ tests: { worth: { pattern: "six" } } }), (error) => error.field === "values.tests.worth.pattern");
  assert.throws(() => validateExamRecordValues({ tests: { nineGaze: { cells: { middle: { od: "normal" } } } } }), (error) => error.field === "values.tests.nineGaze.cells.middle");
  assert.throws(() => validateExamRecordValues({ pd: { far: 120 } }), (error) => error.field === "values.pd.far");
});

test("lists the eleven DigiKar reception statuses with labels and keeps no_show as a legacy alias of absent", () => {
  assert.deepEqual(APPOINTMENT_STATUS_MENU.map((status) => APPOINTMENT_STATUS_LABELS[status]), [
    "予約済", "受付中", "診察待", "診察中", "検査中", "処置中", "会計待", "会計済", "再計待", "不在", "取消"
  ]);
  assert.equal(APPOINTMENT_STATUS_LABELS.no_show, "不在");
  assert.ok(APPOINTMENT_STATUSES.includes("no_show"), "old data stays valid");
  assert.ok(!APPOINTMENT_STATUSES.includes("rebill_waiting"), "再計待 is derived, never stored");
  assert.equal(normalizeAppointmentStatus("no_show"), "absent");
  assert.equal(normalizeAppointmentStatus("checkout"), "checkout");
  assert.equal(isActiveAppointmentStatus("absent"), false);
  assert.equal(isActiveAppointmentStatus("no_show"), false);
  assert.equal(isActiveAppointmentStatus("done"), true);
  // どこからどこへでも移れる（自分自身と古い値 no_show へは移らない）
  assert.equal(APPOINTMENT_TRANSITIONS.done.length, 9);
  assert.ok(APPOINTMENT_TRANSITIONS.done.includes("checked_in"));
  assert.ok(!APPOINTMENT_TRANSITIONS.booked.includes("no_show"));
  assert.ok(!APPOINTMENT_TRANSITIONS.no_show.includes("absent"));
  assert.doesNotThrow(() => assertAppointmentTransition("done", "booked"));
  assert.doesNotThrow(() => assertAppointmentTransition("no_show", "absent"));
  assert.throws(() => assertAppointmentTransition("booked", "rebill_waiting"), { statusCode: 409 });
});

test("validates status changes and normalizes the legacy value", () => {
  assert.deepEqual(validateAppointmentStatusInput({ expectedRevision: 2, status: "in_treatment" }), { expectedRevision: 2, status: "in_treatment" });
  assert.equal(validateAppointmentStatusInput({ expectedRevision: 2, status: "no_show" }).status, "absent");
  assert.throws(() => validateAppointmentStatusInput({ expectedRevision: 2, status: "rebill_waiting" }), { field: "status", message: /derived/u });
  assert.throws(() => validateAppointmentStatusInput({ expectedRevision: 2, status: "away" }), { field: "status" });
  assert.throws(() => validateAppointmentStatusInput({ expectedRevision: 0, status: "booked" }), { field: "expectedRevision" });
});

test("accepts the doctor, department and reception memo (stored as note) on appointments", () => {
  const created = validateCreateAppointmentInput({ date: "2026-11-09", patientName: "x", doctorMemberId: "mem_1", department: "眼科", receptionMemo: "  紹介状あり\n" });
  assert.equal(created.note, "紹介状あり");
  assert.equal(created.doctorMemberId, "mem_1");
  assert.equal(created.department, "眼科");
  assert.equal(validateCreateAppointmentInput({ date: "2026-11-09", patientName: "x", note: "古い形" }).note, "古い形");
  assert.equal(validateCreateAppointmentInput({ date: "2026-11-09", patientName: "x", note: "a", receptionMemo: "b" }).note, "b", "receptionMemo wins");
  assert.equal(validateCreateAppointmentInput({ date: "2026-11-09", patientName: "x" }).note, "");
  assert.throws(() => validateCreateAppointmentInput({ date: "2026-11-09", patientName: "x", department: "a".repeat(41) }), { field: "department" });
  assert.throws(() => validateCreateAppointmentInput({ date: "2026-11-09", patientName: "x", receptionMemo: "a".repeat(1001) }), { field: "receptionMemo" });
  const update = validateUpdateAppointmentInput({ expectedRevision: 1 });
  assert.equal(update.note, undefined, "an update without a memo leaves it alone");
  assert.equal(update.doctorMemberId, undefined);
  assert.equal(validateUpdateAppointmentInput({ expectedRevision: 1, receptionMemo: "" }).note, "");
});

test("validates the close, single billing and range inputs", () => {
  assert.deepEqual(validateCloseEncounterInput({ expectedRevision: 3 }), { expectedRevision: 3, nextStatus: "checkout", appointmentId: "" });
  assert.equal(validateCloseEncounterInput({ expectedRevision: 3, nextStatus: "in_exam" }).nextStatus, "in_exam");
  assert.throws(() => validateCloseEncounterInput({ expectedRevision: 3, nextStatus: "cancelled" }), { field: "nextStatus" });
  assert.throws(() => validateCloseEncounterInput({ expectedRevision: 3, nextStatus: "rebill_waiting" }), { field: "nextStatus" });
  assert.throws(() => validateCloseEncounterInput({}), { field: "expectedRevision" });

  assert.deepEqual(validateBillingSendInput({ date: "2026-11-09", encounterId: "eenc_1" }), { date: "2026-11-09", encounterId: "eenc_1", appointmentId: "" });
  assert.throws(() => validateBillingSendInput({ date: "2026-11-09" }), { field: "encounterId" });
  assert.throws(() => validateBillingSendInput({ date: "11/09", encounterId: "x" }), { field: "date" });

  assert.equal(validateAppointmentRangeInput({ from: "2026-11-01", to: "2026-11-07" }).days, 7);
  assert.equal(validateAppointmentRangeInput({ from: "2026-11-01", to: "2026-12-12" }).days, 42);
  assert.throws(() => validateAppointmentRangeInput({ from: "2026-11-01", to: "2026-12-13" }), { field: "to" });
  assert.throws(() => validateAppointmentRangeInput({ from: "2026-11-07", to: "2026-11-01" }), { field: "to" });
  assert.throws(() => validateAppointmentRangeInput({ to: "2026-11-01" }), { field: "from" });
});

test("keeps the patient memo optional on the profile input", () => {
  assert.equal(validatePatientProfileInput({ expectedRevision: 0 }).patientMemo, undefined);
  assert.equal(validatePatientProfileInput({ expectedRevision: 0, patientMemo: "耳が遠い\r\n" }).patientMemo, "耳が遠い");
  assert.throws(() => validatePatientProfileInput({ expectedRevision: 0, patientMemo: 1 }), { field: "patientMemo" });
});

test("groups prescription rows into Rps and aligns the shared instructions", async () => {
  const { validateEncounterContent: validate } = await import("../src/index.js");
  const content = validate({
    prescriptions: [
      { name: "A", rpId: "rp1", eye: "ou", timesPerDay: 2, usage: "朝夕", days: 14, route: "inside" },
      { name: "legacy", eye: "od" },
      { name: "B", rpId: "rp1", eye: "os", timesPerDay: 4, days: 7 },
      { kind: "comment", rpId: "rp1", text: "一般名で記載", scope: "free" }
    ]
  });
  assert.deepEqual(content.prescriptions.map((row) => row.name || row.text), ["A", "B", "一般名で記載", "legacy"]);
  assert.deepEqual(["eye", "timesPerDay", "usage", "days", "route"].map((key) => content.prescriptions[1][key]), ["ou", 2, "朝夕", 14, "inside"]);
  assert.deepEqual(content.prescriptions[2], { kind: "comment", rpId: "rp1", text: "一般名で記載", scope: "free" });
  assert.equal("rpId" in content.prescriptions[3], false);
  assert.throws(() => validate({ orders: [{ orderId: "c", kind: "comment", text: "x" }] }), /rpId is required/u);
  assert.throws(() => validate({ prescriptions: [{ kind: "comment", rpId: "r", text: "x", scope: "everywhere" }] }), /scope/u);
});

test("diagnoses carry optional codes, modifiers, a separate suspicion flag, and a department", async () => {
  const { validateEncounterContent: validate, validatePatientProfileInput, isSuspectedDiagnosis } = await import("../src/index.js");
  const [legacy, coded, plain] = validate({
    diagnoses: [
      { name: "白内障", status: "suspected" },
      { name: "緑内障", code: "3659002", suspected: true, status: "resolved", department: "眼科", modifiers: [{ code: "2057", name: "両", position: "prefix" }] },
      { name: "結膜炎" }
    ]
  }).diagnoses;
  assert.deepEqual(legacy, { name: "白内障", eye: "ou", status: "active", onsetDate: "", suspected: true });
  assert.equal(coded.status, "resolved", "a suspected diagnosis can still be closed");
  assert.equal(coded.suspected, true);
  assert.deepEqual(coded.modifiers, [{ code: "2057", name: "両", position: "prefix" }]);
  assert.deepEqual(plain, { name: "結膜炎", eye: "ou", status: "active", onsetDate: "" }, "old-shaped rows keep their shape");
  assert.equal(isSuspectedDiagnosis({ status: "suspected" }), true);
  assert.throws(() => validate({ diagnoses: [{ name: "x", modifiers: [{}] }] }), /code or a name/u);
  const profile = validatePatientProfileInput({ expectedRevision: 0, diagnoses: [{ name: "緑内障", status: "suspected", code: "3659002" }] });
  assert.deepEqual([profile.diagnoses[0].status, profile.diagnoses[0].suspected, profile.diagnoses[0].code, profile.diagnoses[0].outcome], ["active", true, "3659002", ""]);
});

test("validates set folders, sets with folders and diagnoses, set-from-chart, and the optional amendment reason", async () => {
  const contracts = await import("../src/index.js");
  assert.deepEqual(contracts.validateSetFolderInput({ name: " 緑内障 " }), { folderId: "", name: "緑内障", parentId: "", sortOrder: 0, active: true });
  assert.throws(() => contracts.validateSetFolderInput({ folderId: "f1", name: "x", parentId: "f1" }), /own parent/u);
  const set = contracts.validateOrderSetInput({
    name: "緑内障", folderId: "f1", sortOrder: -2, findingsText: "眼圧高値",
    diagnoses: [{ name: "緑内障", code: "3659002", onsetDate: "2026-01-01" }],
    prescriptions: [{ name: "A", rpId: "r" }, { kind: "comment", rpId: "r", text: "注" }],
    orders: [{ kind: "comment", rpId: "o", text: "両側" }]
  });
  assert.equal(set.folderId, "f1");
  assert.equal(set.sortOrder, -2);
  assert.equal(set.findingsText, "眼圧高値");
  assert.deepEqual(set.diagnoses, [{ name: "緑内障", eye: "ou", status: "active", code: "3659002" }]);
  assert.equal(set.orders[0].kind, "comment");
  const plainSet = contracts.validateOrderSetInput({ name: "古い形" });
  assert.equal("folderId" in plainSet || "diagnoses" in plainSet || "findingsText" in plainSet, false);
  const fromChart = contracts.validateSetFromEncounterInput({ encounterId: "e1", include: { orders: false } });
  assert.deepEqual(fromChart.include, { prescriptions: true, orders: false, diagnoses: true, findingsText: true, plan: true });
  assert.equal(contracts.validateAmendEncounterInput({}).reason, "修正");
  assert.equal(contracts.validateAmendEncounterInput({ reason: " 誤記 " }).reason, "誤記");
  assert.equal(contracts.validateUpdateEncounterInput({ expectedRevision: 2, amendmentReason: "日付" }).amendmentReason, "日付");
  assert.equal(contracts.validateEncounterContent({ findingsText: "a\r\nb  " }).findingsText, "a\nb");
  assert.equal("findingsText" in contracts.validateEncounterContent({}), false);
});
