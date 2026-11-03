import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
