// 眼科カルテの入力検証と列挙値。計算や版管理は eye-core に置く。

export const EYE_PRODUCT_ID = "eye";
export const EYE_SIDES = Object.freeze(["od", "os"]);
export const EYE_TARGETS = Object.freeze(["od", "os", "ou"]);
export const EYE_TARGET_LABELS = Object.freeze({ od: "右眼", os: "左眼", ou: "両眼" });
export const VISIT_TYPES = Object.freeze(["initial", "revisit"]);
export const ENCOUNTER_STATUSES = Object.freeze(["draft", "finalized"]);
export const PRESCRIPTION_KINDS = Object.freeze(["eye_drop", "eye_ointment", "oral", "injection", "other"]);
export const IOP_METHODS = Object.freeze(["nct", "goldmann", "icare", "other"]);
export const PRESCRIPTION_ROUTES = Object.freeze(["outside", "inside"]);
export const PHRASE_TARGETS = Object.freeze([
  "chiefComplaint", "history", "assessment", "plan", "staffNote", "findings.anterior", "findings.lens", "findings.fundus"
]);
export const SKETCH_TEMPLATES = Object.freeze(["anterior", "fundus", "blank"]);
export const DIAGNOSIS_STATUSES = Object.freeze(["active", "resolved", "suspected"]);
export const VA_CORRECTION_TYPES = Object.freeze(["", "glasses", "contact", "pinhole", "trial"]);
export const ORDER_KINDS = Object.freeze(["exam", "procedure"]);
export const ORDER_STATUSES = Object.freeze(["planned", "performed", "cancelled"]);
// 受診カルテの項目。保存と衝突判定はこの単位で行う。
export const ENCOUNTER_SECTIONS = Object.freeze([
  "chiefComplaint", "history", "exam", "findings", "sketches", "diagnoses", "assessment", "plan",
  "prescriptions", "nextVisit", "staffNote", "orders", "flags"
]);
// 検査・処置の標準カタログ。医院ごとの追加はセットで行う。
export const DEFAULT_ORDER_CATALOG = Object.freeze([
  { code: "va", name: "視力検査", kind: "exam", requiresEye: true },
  { code: "refraction", name: "屈折検査（他覚）", kind: "exam", requiresEye: true },
  { code: "iop", name: "眼圧検査", kind: "exam", requiresEye: true },
  { code: "iop_gat", name: "精密眼圧測定（GAT）", kind: "exam", requiresEye: true },
  { code: "slit_lamp", name: "細隙灯顕微鏡検査", kind: "exam", requiresEye: true },
  { code: "fundus_dilated", name: "精密眼底検査（散瞳）", kind: "exam", requiresEye: true },
  { code: "vf_static", name: "静的視野検査", kind: "exam", requiresEye: true },
  { code: "vf_kinetic", name: "動的視野検査", kind: "exam", requiresEye: true },
  { code: "oct_retina", name: "OCT（網膜）", kind: "exam", requiresEye: true },
  { code: "oct_disc", name: "OCT（視神経乳頭）", kind: "exam", requiresEye: true },
  { code: "fundus_photo", name: "眼底写真", kind: "exam", requiresEye: true },
  { code: "keratometry", name: "角膜曲率測定", kind: "exam", requiresEye: true },
  { code: "axial_length", name: "眼軸長測定", kind: "exam", requiresEye: true },
  { code: "endothelium", name: "角膜内皮細胞検査", kind: "exam", requiresEye: true },
  { code: "tear", name: "涙液検査（BUT・シルマー）", kind: "exam", requiresEye: true },
  { code: "dilation", name: "散瞳", kind: "procedure", requiresEye: true },
  { code: "ivi", name: "硝子体内注射", kind: "procedure", requiresEye: true },
  { code: "foreign_body", name: "角膜異物除去", kind: "procedure", requiresEye: true }
]);
export const DIAGNOSIS_OUTCOMES = Object.freeze(["", "cured", "discontinued", "transferred", "deceased", "other"]);
export const ALLERGY_CATEGORIES = Object.freeze(["drug", "food", "contrast", "latex", "other"]);
export const ALLERGY_SEVERITIES = Object.freeze(["unknown", "mild", "moderate", "severe"]);
// 傷病名の変更は医師（と管理者）だけ。アレルギー・既往は問診を取る職種も更新できる。
export const EYE_PROFILE_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse", "medical_clerk"]);

export const EYE_READ_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse", "medical_clerk", "viewer"]);
export const EYE_WRITE_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse"]);
export const EYE_FINALIZE_ROLES = Object.freeze(["admin", "doctor"]);
export const EYE_SETTINGS_ROLES = Object.freeze(["admin"]);
export const EYE_RECEPTION_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse", "medical_clerk"]);

export const APPOINTMENT_PURPOSES = Object.freeze(["revisit", "initial", "exam", "injection", "postop", "contact_lens", "other"]);
export const APPOINTMENT_STATUSES = Object.freeze([
  "booked", "checked_in", "in_exam", "waiting_doctor", "in_consult", "checkout", "done", "cancelled", "no_show"
]);
// 受付から会計までの順番。戻す操作（取り違え）も1段だけ許す。
export const APPOINTMENT_TRANSITIONS = Object.freeze({
  booked: ["checked_in", "cancelled", "no_show"],
  checked_in: ["in_exam", "waiting_doctor", "booked", "cancelled"],
  in_exam: ["waiting_doctor", "checked_in"],
  waiting_doctor: ["in_consult", "in_exam"],
  in_consult: ["checkout", "waiting_doctor"],
  checkout: ["done", "in_consult"],
  done: ["checkout"],
  cancelled: ["booked"],
  no_show: ["booked"]
});

const MAX_TEXT = 4000;
const MAX_SHORT_TEXT = 200;
const MAX_LIST = 40;
const MAX_SKETCHES = 8;
const MAX_STROKES = 600;
const MAX_POINTS_PER_STROKE = 2000;
const MAX_TOTAL_POINTS = 60000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function validateCreateEncounterInput(input = {}) {
  return {
    patientId: requiredString(input.patientId, "patientId", MAX_SHORT_TEXT),
    encounterDate: requiredDate(input.encounterDate, "encounterDate"),
    visitType: optionalEnum(input.visitType, VISIT_TYPES, "visitType") || "revisit",
    copyFromEncounterId: optionalString(input.copyFromEncounterId, "copyFromEncounterId", MAX_SHORT_TEXT),
    content: input.content === undefined ? undefined : validateEncounterContent(input.content)
  };
}

export function validateUpdateEncounterInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return {
    expectedRevision,
    encounterDate: input.encounterDate === undefined ? undefined : requiredDate(input.encounterDate, "encounterDate"),
    visitType: input.visitType === undefined ? undefined : requiredEnum(input.visitType, VISIT_TYPES, "visitType"),
    sections: validateEncounterSections(input)
  };
}

// 保存は変更した項目だけを送る（sections）。content を丸ごと送る古い形も受け付ける。
function validateEncounterSections(input) {
  const source = isPlainObject(input.sections) ? input.sections : isPlainObject(input.content) ? input.content : {};
  const keys = Object.keys(source).filter((key) => ENCOUNTER_SECTIONS.includes(key));
  const unknown = Object.keys(source).filter((key) => !ENCOUNTER_SECTIONS.includes(key));
  if (unknown.length) throw validationError(`unknown section: ${unknown.join(", ")}`, "sections");
  const validated = validateEncounterContent(Object.fromEntries(keys.map((key) => [key, source[key]])));
  return Object.fromEntries(keys.map((key) => [key, validated[key]]));
}

export function validateFinalizeEncounterInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return { expectedRevision };
}

export function validateAmendEncounterInput(input = {}) {
  return {
    reason: requiredString(input.reason, "reason", MAX_TEXT)
  };
}

export function validateDrugPresetInput(input = {}) {
  const dropsPerBottle = optionalNumber(input.dropsPerBottle, "dropsPerBottle", { min: 1, max: 2000, integer: true });
  return {
    presetId: optionalString(input.presetId, "presetId", MAX_SHORT_TEXT),
    name: requiredString(input.name, "name", MAX_SHORT_TEXT),
    kind: optionalEnum(input.kind, PRESCRIPTION_KINDS, "kind") || "eye_drop",
    defaultTimesPerDay: optionalNumber(input.defaultTimesPerDay, "defaultTimesPerDay", { min: 0, max: 24, integer: true }),
    bottleVolumeMl: optionalNumber(input.bottleVolumeMl, "bottleVolumeMl", { min: 0.1, max: 100 }),
    dropsPerBottle: dropsPerBottle ?? null,
    defaultUsage: optionalString(input.defaultUsage, "defaultUsage", MAX_SHORT_TEXT),
    route: optionalEnum(input.route, PRESCRIPTION_ROUTES, "route") || "outside",
    active: input.active === undefined ? true : Boolean(input.active)
  };
}

// セット: よく使う処方・オーダー・方針文の組み合わせ。カルテに一括で追加する。
export function validateOrderSetInput(input = {}) {
  const content = validateEncounterContent({
    prescriptions: input.prescriptions,
    orders: (input.orders || []).map((order, index) => ({ ...order, orderId: order.orderId || `set-${index}` }))
  });
  return {
    setId: optionalString(input.setId, "setId", MAX_SHORT_TEXT),
    name: requiredString(input.name, "name", MAX_SHORT_TEXT),
    description: optionalString(input.description, "description", MAX_SHORT_TEXT),
    prescriptions: content.prescriptions.map((item, index) => {
      if (!item.name) throw validationError("set prescriptions need a name", `prescriptions.${index}.name`);
      return item;
    }),
    orders: content.orders.map(({ orderId, statusChangedAt, statusChangedBy, ...order }) => ({ ...order, status: "planned" })),
    plan: optionalText(input.plan, "plan"),
    active: input.active === undefined ? true : Boolean(input.active)
  };
}

// 定型文: 指定した欄に差し込む文。
export function validatePhraseInput(input = {}) {
  return {
    phraseId: optionalString(input.phraseId, "phraseId", MAX_SHORT_TEXT),
    target: requiredEnum(input.target, PHRASE_TARGETS, "target"),
    label: optionalString(input.label, "label", 60),
    text: requiredString(input.text, "text", MAX_TEXT),
    active: input.active === undefined ? true : Boolean(input.active)
  };
}

export function validateEncounterContent(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("content must be an object", "content");
  }
  return {
    chiefComplaint: optionalText(input.chiefComplaint, "content.chiefComplaint"),
    history: optionalText(input.history, "content.history"),
    exam: validateExam(input.exam || {}),
    findings: validateFindings(input.findings || {}),
    sketches: validateSketches(input.sketches),
    diagnoses: validateDiagnoses(input.diagnoses),
    assessment: optionalText(input.assessment, "content.assessment"),
    plan: optionalText(input.plan, "content.plan"),
    prescriptions: validatePrescriptions(input.prescriptions),
    nextVisit: validateNextVisit(input.nextVisit || {}),
    staffNote: optionalText(input.staffNote, "content.staffNote"),
    orders: validateOrders(input.orders),
    flags: validateFlags(input.flags || {})
  };
}

function validateOrders(value) {
  return optionalList(value, "content.orders", MAX_LIST).map((item, index) => {
    const field = `content.orders.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    return {
      orderId: requiredString(item.orderId, `${field}.orderId`, MAX_SHORT_TEXT),
      code: optionalString(item.code, `${field}.code`, 60),
      name: optionalString(item.name, `${field}.name`, MAX_SHORT_TEXT),
      kind: optionalEnum(item.kind, ORDER_KINDS, `${field}.kind`) || "exam",
      eye: optionalEnum(item.eye, EYE_TARGETS, `${field}.eye`),
      status: optionalEnum(item.status, ORDER_STATUSES, `${field}.status`) || "planned",
      note: optionalString(item.note, `${field}.note`, MAX_SHORT_TEXT),
      statusChangedAt: optionalString(item.statusChangedAt, `${field}.statusChangedAt`, 40),
      statusChangedBy: isPlainObject(item.statusChangedBy) ? {
        memberId: optionalString(item.statusChangedBy.memberId, `${field}.statusChangedBy.memberId`, MAX_SHORT_TEXT),
        displayName: optionalString(item.statusChangedBy.displayName, `${field}.statusChangedBy.displayName`, MAX_SHORT_TEXT)
      } : null
    };
  });
}

function validateFlags(input) {
  if (!isPlainObject(input)) throw validationError("flags must be an object", "content.flags");
  const startedAt = optionalString(input.dilationStartedAt, "content.flags.dilationStartedAt", 40);
  if (startedAt && Number.isNaN(Date.parse(startedAt))) {
    throw validationError("content.flags.dilationStartedAt must be an ISO timestamp", "content.flags.dilationStartedAt");
  }
  return {
    dilated: Boolean(input.dilated) || Boolean(startedAt),
    dilationStartedAt: startedAt,
    dilationEye: optionalEnum(input.dilationEye, EYE_TARGETS, "content.flags.dilationEye"),
    myopiaTreatment: Boolean(input.myopiaTreatment)
  };
}

export function validateExamConfirmInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  const eye = String(input.eye || "");
  if (!["od", "os", "both"].includes(eye)) throw validationError("eye must be od, os, or both", "eye");
  return { expectedRevision, eye, confirmed: input.confirmed !== false };
}

function validateExam(input) {
  if (!isPlainObject(input)) throw validationError("exam must be an object", "content.exam");
  return Object.fromEntries(EYE_SIDES.map((side) => [side, validateEyeExam(input[side] || {}, `content.exam.${side}`)]));
}

function validateEyeExam(input, field) {
  if (!isPlainObject(input)) throw validationError(`${field} must be an object`, field);
  return {
    vaUncorrected: optionalString(input.vaUncorrected, `${field}.vaUncorrected`, 40),
    vaCorrected: optionalString(input.vaCorrected, `${field}.vaCorrected`, 40),
    correction: validateRefraction(input.correction || {}, `${field}.correction`),
    refraction: validateRefraction(input.refraction || {}, `${field}.refraction`),
    iop: optionalNumber(input.iop, `${field}.iop`, { min: 0, max: 90 }),
    iopMethod: optionalEnum(input.iopMethod, IOP_METHODS, `${field}.iopMethod`),
    vaCorrectionType: optionalEnum(input.vaCorrectionType, VA_CORRECTION_TYPES, `${field}.vaCorrectionType`),
    measuredAt: optionalTime(input.measuredAt, `${field}.measuredAt`)
  };
}

function validateRefraction(input, field) {
  if (!isPlainObject(input)) throw validationError(`${field} must be an object`, field);
  return {
    sphere: optionalNumber(input.sphere, `${field}.sphere`, { min: -40, max: 40 }),
    cylinder: optionalNumber(input.cylinder, `${field}.cylinder`, { min: -20, max: 20 }),
    axis: optionalNumber(input.axis, `${field}.axis`, { min: 0, max: 180, integer: true })
  };
}

function validateFindings(input) {
  if (!isPlainObject(input)) throw validationError("findings must be an object", "content.findings");
  return Object.fromEntries(EYE_SIDES.map((side) => {
    const value = input[side] || {};
    if (!isPlainObject(value)) throw validationError(`findings.${side} must be an object`, `content.findings.${side}`);
    return [side, {
      anterior: optionalText(value.anterior, `content.findings.${side}.anterior`),
      lens: optionalText(value.lens, `content.findings.${side}.lens`),
      fundus: optionalText(value.fundus, `content.findings.${side}.fundus`)
    }];
  }));
}

function validateSketches(value) {
  const list = optionalList(value, "content.sketches", MAX_SKETCHES);
  let totalPoints = 0;
  return list.map((sketch, index) => {
    const field = `content.sketches.${index}`;
    if (!isPlainObject(sketch)) throw validationError(`${field} must be an object`, field);
    const strokes = optionalList(sketch.strokes, `${field}.strokes`, MAX_STROKES).map((stroke, strokeIndex) => {
      const strokeField = `${field}.strokes.${strokeIndex}`;
      if (!isPlainObject(stroke)) throw validationError(`${strokeField} must be an object`, strokeField);
      const points = normalizeStrokePoints(stroke.points, `${strokeField}.points`);
      totalPoints += points.length / 2;
      return {
        color: optionalColor(stroke.color, `${strokeField}.color`) || "#1f2937",
        width: optionalNumber(stroke.width, `${strokeField}.width`, { min: 1, max: 40 }) ?? 3,
        points
      };
    });
    if (totalPoints > MAX_TOTAL_POINTS) {
      throw validationError("sketches are too detailed", "content.sketches");
    }
    return {
      sketchId: requiredString(sketch.sketchId, `${field}.sketchId`, MAX_SHORT_TEXT),
      template: optionalEnum(sketch.template, SKETCH_TEMPLATES, `${field}.template`) || "blank",
      eye: optionalEnum(sketch.eye, EYE_TARGETS, `${field}.eye`) || "ou",
      caption: optionalString(sketch.caption, `${field}.caption`, MAX_SHORT_TEXT),
      strokes
    };
  });
}

// Firestore は配列の入れ子を保存できないため、座標は [x1, y1, x2, y2, ...] の平らな配列で持つ。
// 入力は [[x, y], ...] の形も受け付ける。座標は 0〜1000 に正規化する。
function normalizeStrokePoints(value, field) {
  const list = value === undefined || value === null ? [] : value;
  if (!Array.isArray(list)) throw validationError(`${field} must be an array`, field);
  const flat = list.length > 0 && Array.isArray(list[0])
    ? list.flatMap((point) => {
      if (!Array.isArray(point) || point.length < 2) throw validationError(`${field} must contain [x, y] pairs`, field);
      return [point[0], point[1]];
    })
    : list;
  if (flat.length % 2 !== 0) throw validationError(`${field} must contain an even number of coordinates`, field);
  if (flat.length / 2 > MAX_POINTS_PER_STROKE) {
    throw validationError(`${field} must contain at most ${MAX_POINTS_PER_STROKE} points`, field);
  }
  return flat.map((coordinate) => clampInteger(coordinate, 0, 1000));
}

function validateDiagnoses(value) {
  return optionalList(value, "content.diagnoses", MAX_LIST).map((diagnosis, index) => {
    const field = `content.diagnoses.${index}`;
    if (!isPlainObject(diagnosis)) throw validationError(`${field} must be an object`, field);
    return {
      name: optionalString(diagnosis.name, `${field}.name`, MAX_SHORT_TEXT),
      eye: optionalEnum(diagnosis.eye, EYE_TARGETS, `${field}.eye`) || "ou",
      status: optionalEnum(diagnosis.status, DIAGNOSIS_STATUSES, `${field}.status`) || "active",
      onsetDate: optionalDate(diagnosis.onsetDate, `${field}.onsetDate`)
    };
  });
}

function validatePrescriptions(value) {
  return optionalList(value, "content.prescriptions", MAX_LIST).map((item, index) => {
    const field = `content.prescriptions.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    return {
      kind: optionalEnum(item.kind, PRESCRIPTION_KINDS, `${field}.kind`) || "eye_drop",
      name: optionalString(item.name, `${field}.name`, MAX_SHORT_TEXT),
      presetId: optionalString(item.presetId, `${field}.presetId`, MAX_SHORT_TEXT),
      eye: optionalEnum(item.eye, EYE_TARGETS, `${field}.eye`),
      timesPerDay: optionalNumber(item.timesPerDay, `${field}.timesPerDay`, { min: 0, max: 24, integer: true }),
      quantity: optionalNumber(item.quantity, `${field}.quantity`, { min: 0, max: 999 }),
      unit: optionalString(item.unit, `${field}.unit`, 20),
      days: optionalNumber(item.days, `${field}.days`, { min: 0, max: 365, integer: true }),
      note: optionalString(item.note, `${field}.note`, MAX_SHORT_TEXT),
      route: optionalEnum(item.route, PRESCRIPTION_ROUTES, `${field}.route`) || "outside",
      usage: optionalString(item.usage, `${field}.usage`, MAX_SHORT_TEXT),
      issued: item.issued === undefined ? true : Boolean(item.issued)
    };
  });
}

function validateNextVisit(input) {
  if (!isPlainObject(input)) throw validationError("nextVisit must be an object", "content.nextVisit");
  return {
    intervalWeeks: optionalNumber(input.intervalWeeks, "content.nextVisit.intervalWeeks", { min: 0, max: 104 }),
    date: optionalDate(input.date, "content.nextVisit.date"),
    note: optionalString(input.note, "content.nextVisit.note", MAX_SHORT_TEXT)
  };
}

export function validatePatientProfileInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw validationError("expectedRevision must be zero or a positive integer", "expectedRevision");
  }
  const allergies = optionalList(input.allergies, "allergies", MAX_LIST).map((item, index) => {
    const field = `allergies.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    return {
      allergyId: optionalString(item.allergyId, `${field}.allergyId`, MAX_SHORT_TEXT),
      category: optionalEnum(item.category, ALLERGY_CATEGORIES, `${field}.category`) || "drug",
      substance: requiredString(item.substance, `${field}.substance`, MAX_SHORT_TEXT),
      reaction: optionalString(item.reaction, `${field}.reaction`, MAX_SHORT_TEXT),
      severity: optionalEnum(item.severity, ALLERGY_SEVERITIES, `${field}.severity`) || "unknown"
    };
  });
  const noKnownAllergies = Boolean(input.noKnownAllergies);
  if (noKnownAllergies && allergies.length > 0) {
    throw validationError("noKnownAllergies cannot be set together with allergies", "noKnownAllergies");
  }
  const diagnoses = optionalList(input.diagnoses, "diagnoses", MAX_LIST).map((item, index) => {
    const field = `diagnoses.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    const status = optionalEnum(item.status, DIAGNOSIS_STATUSES, `${field}.status`) || "active";
    const startDate = optionalDate(item.startDate, `${field}.startDate`);
    const endDate = optionalDate(item.endDate, `${field}.endDate`);
    if (startDate && endDate && endDate < startDate) {
      throw validationError(`${field}.endDate must be on or after startDate`, `${field}.endDate`);
    }
    return {
      diagnosisId: optionalString(item.diagnosisId, `${field}.diagnosisId`, MAX_SHORT_TEXT),
      name: requiredString(item.name, `${field}.name`, MAX_SHORT_TEXT),
      eye: optionalEnum(item.eye, EYE_TARGETS, `${field}.eye`) || "ou",
      status,
      startDate,
      endDate,
      outcome: optionalEnum(item.outcome, DIAGNOSIS_OUTCOMES, `${field}.outcome`) || (status === "resolved" ? "cured" : ""),
      primary: Boolean(item.primary),
      note: optionalString(item.note, `${field}.note`, MAX_SHORT_TEXT)
    };
  });
  return {
    expectedRevision,
    allergies,
    noKnownAllergies,
    diagnoses,
    medicalHistory: optionalText(input.medicalHistory, "medicalHistory"),
    ophthalmicHistory: optionalText(input.ophthalmicHistory, "ophthalmicHistory"),
    contactLensUser: Boolean(input.contactLensUser)
  };
}

export function validateCreateAppointmentInput(input = {}) {
  const patientId = optionalString(input.patientId, "patientId", MAX_SHORT_TEXT);
  const patientName = optionalString(input.patientName, "patientName", MAX_SHORT_TEXT);
  if (!patientId && !patientName) {
    throw validationError("patientId or patientName is required", "patientId");
  }
  return {
    date: requiredDate(input.date, "date"),
    time: optionalTime(input.time, "time"),
    patientId,
    patientName,
    purpose: optionalEnum(input.purpose, APPOINTMENT_PURPOSES, "purpose") || "revisit",
    note: optionalString(input.note, "note", MAX_SHORT_TEXT),
    walkIn: Boolean(input.walkIn),
    sourceEncounterId: optionalString(input.sourceEncounterId, "sourceEncounterId", MAX_SHORT_TEXT)
  };
}

export function validateUpdateAppointmentInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return {
    expectedRevision,
    date: input.date === undefined ? undefined : requiredDate(input.date, "date"),
    time: input.time === undefined ? undefined : optionalTime(input.time, "time"),
    patientId: input.patientId === undefined ? undefined : optionalString(input.patientId, "patientId", MAX_SHORT_TEXT),
    patientName: input.patientName === undefined ? undefined : optionalString(input.patientName, "patientName", MAX_SHORT_TEXT),
    purpose: input.purpose === undefined ? undefined : requiredEnum(input.purpose, APPOINTMENT_PURPOSES, "purpose"),
    note: input.note === undefined ? undefined : optionalString(input.note, "note", MAX_SHORT_TEXT)
  };
}

export function validateAppointmentStatusInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return {
    expectedRevision,
    status: requiredEnum(input.status, APPOINTMENT_STATUSES, "status")
  };
}

export function assertAppointmentTransition(from, to) {
  if (!(APPOINTMENT_TRANSITIONS[from] || []).includes(to)) {
    const error = validationError(`appointment cannot move from ${from} to ${to}`, "status");
    error.name = "ConflictError";
    error.statusCode = 409;
    throw error;
  }
}

export function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalList(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${field} must be an array`, field);
  if (value.length > max) throw validationError(`${field} must contain at most ${max} items`, field);
  return value;
}

function requiredString(value, field, max) {
  const normalized = optionalString(value, field, max);
  if (!normalized) throw validationError(`${field} is required`, field);
  return normalized;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw validationError(`${field} must be a string`, field);
  }
  const normalized = String(value).trim();
  if (normalized.length > max) throw validationError(`${field} must be at most ${max} characters`, field);
  return normalized;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw validationError(`${field} must be a string`, field);
  const normalized = value.replace(/\r\n?/gu, "\n").trimEnd();
  if (normalized.length > MAX_TEXT) throw validationError(`${field} must be at most ${MAX_TEXT} characters`, field);
  return normalized;
}

function optionalNumber(value, field, { min, max, integer = false }) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw validationError(`${field} must be a number`, field);
  if (integer && !Number.isInteger(number)) throw validationError(`${field} must be an integer`, field);
  if (number < min || number > max) throw validationError(`${field} must be between ${min} and ${max}`, field);
  return number;
}

function clampInteger(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function requiredDate(value, field) {
  const normalized = optionalDate(value, field);
  if (!normalized) throw validationError(`${field} is required`, field);
  return normalized;
}

function optionalDate(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!DATE_PATTERN.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw validationError(`${field} must be YYYY-MM-DD`, field);
  }
  return normalized;
}

function optionalTime(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(normalized)) throw validationError(`${field} must be HH:MM`, field);
  return normalized;
}

function requiredEnum(value, allowed, field) {
  const normalized = optionalEnum(value, allowed, field);
  if (!normalized) throw validationError(`${field} is required`, field);
  return normalized;
}

function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!allowed.includes(normalized)) {
    throw validationError(`${field} must be one of: ${allowed.join(", ")}`, field);
  }
  return normalized;
}

function optionalColor(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!/^#[0-9a-fA-F]{6}$/u.test(normalized)) throw validationError(`${field} must be #RRGGBB`, field);
  return normalized.toLowerCase();
}
