import { createHash } from "node:crypto";
import { ENCOUNTER_SECTIONS, validateEncounterContent, validateExamRecords } from "../../../packages/eye-contracts/src/index.js";
import {
  applyChartExamEdit,
  calculateEyeDropBottles,
  deriveExamFromRecords,
  hasExamRecords,
  plannedOrdersFromPlan,
  seedExamRecordFromExam,
  copyContentForRevisit,
  daysUntilNextVisit,
  emptyEncounterContent,
  evaluateFinalizeReadiness,
  sortByDate
} from "../../../packages/eye-core/src/index.js";

// カルテの状態遷移。draft で編集し、finalize で版を確定する。確定後の修正は amend で draft に戻し、次の版として確定する。

export function buildDraftEncounter({ encounterId, orgId, patientSnapshot, input, copySource, planSource = null, createOrderId, actor, now }) {
  let content = input.content
    ? input.content
    : copySource
      ? copyContentForRevisit(copySource.content)
      : emptyEncounterContent();
  // 検査記録つきで作るとき（取り込みなど）は、exam を記録から作る。
  if (hasExamRecords(content)) content = { ...content, exam: deriveExamFromRecords(content.examRecords) };
  // 前回立てた次回の診療予定を、今回のオーダー（予定）にする。同じ項目・同じ眼がすでにあれば足さない。
  const planItems = planSource?.content?.nextVisit?.planItems || [];
  if (planItems.length && createOrderId) {
    const planned = plannedOrdersFromPlan(planItems, content.orders || [], { sourceEncounterId: planSource.encounterId, createOrderId });
    if (planned.length) content = validateEncounterContent({ ...content, orders: [...(content.orders || []), ...planned] });
  }
  return {
    encounterId,
    orgId,
    patientId: patientSnapshot.patientId,
    patientSnapshot,
    encounterDate: input.encounterDate,
    visitType: input.visitType,
    status: "draft",
    revision: 1,
    versionCount: 0,
    content,
    copiedFromEncounterId: copySource?.encounterId || "",
    sectionRevisions: {},
    examConfirmations: { od: null, os: null },
    amendment: null,
    createdBy: actor,
    updatedBy: actor,
    finalizedBy: null,
    finalizedAt: "",
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

// 項目ごとの版で衝突を判定する。読み込み後に他の人が同じ項目を変えていた場合だけ止める。
// 変更のない項目は送られてきても書き込まない。
export function applyEncounterUpdate(current, input, { actor, now }) {
  requireDraft(current);
  const changed = ENCOUNTER_SECTIONS.filter((key) => (
    Object.hasOwn(input.sections, key) && stableStringify(input.sections[key]) !== stableStringify(current.content[key])
  ));
  const metaChanged = (input.encounterDate !== undefined && input.encounterDate !== current.encounterDate)
    || (input.visitType !== undefined && input.visitType !== current.visitType);
  const keys = metaChanged ? [...changed, "meta"] : changed;
  if (keys.length === 0) return { encounter: current, changed: false };

  const conflicts = keys.filter((key) => sectionRevision(current, key) > input.expectedRevision);
  if (conflicts.length > 0) {
    const error = conflict("ほかの端末で同じ項目が更新されました。画面を読み込み直してください。");
    error.details = { sections: conflicts };
    throw error;
  }

  const revision = current.revision + 1;
  const content = { ...current.content };
  for (const key of changed) content[key] = input.sections[key];
  if (changed.includes("orders")) content.orders = stampOrderStatus(current.content.orders || [], content.orders, { actor, now });
  // 検査記録のあるカルテでは、exam の直接編集を「いまの記録」（最後の記録）へ写し、exam は記録から作り直す。
  // 記録のないカルテ（古いカルテ・記録を使っていないカルテ）は、これまでどおり exam をそのまま保存する。
  const recordKeys = [];
  if (changed.includes("exam") && hasExamRecords(current.content)) {
    const { records } = applyChartExamEdit(current.content.examRecords, content.exam, { actor, now });
    content.examRecords = validateExamRecords(records);
    content.exam = deriveExamFromRecords(content.examRecords);
    recordKeys.push("examRecords");
  }

  return {
    changed: true,
    encounter: {
      ...current,
      encounterDate: input.encounterDate ?? current.encounterDate,
      visitType: input.visitType ?? current.visitType,
      content,
      examConfirmations: resetExamConfirmations(current, content.exam),
      sectionRevisions: { ...(current.sectionRevisions || {}), ...Object.fromEntries([...keys, ...recordKeys].map((key) => [key, revision])) },
      revision,
      updatedBy: actor,
      updatedAt: now
    }
  };
}

// 値の変わった眼だけ確認を外す（確認後に値を変えると確認は外れる）。
function resetExamConfirmations(current, exam) {
  const examConfirmations = { ...(current.examConfirmations || { od: null, os: null }) };
  for (const side of ["od", "os"]) {
    if (stableStringify(exam?.[side]) !== stableStringify(current.content.exam?.[side])) examConfirmations[side] = null;
  }
  return examConfirmations;
}

// 検査記録を 1 件足す。記録のないカルテに exam の値があれば、先にそれを最初の記録にする（値を失わないため）。
export function addExamRecord(current, input, { actor, now, recordId, seedRecordId }) {
  requireDraft(current);
  requireExamRevision(current, input.expectedRevision);
  const at = input.at || now;
  const existing = current.content.examRecords || [];
  const seed = existing.length ? null : seedExamRecordFromExam(current.content.exam, {
    recordId: seedRecordId,
    at: [current.createdAt, at].filter(Boolean).sort()[0],
    actor,
    now
  });
  const record = {
    recordId,
    at,
    source: input.source || "manual",
    examinerMemberId: input.examinerMemberId || actor.memberId || "",
    examinerName: input.examinerName || (input.examinerMemberId ? "" : actor.displayName || ""),
    note: input.note || "",
    values: input.values || {},
    recordedBy: actor,
    recordedAt: now
  };
  const records = [...existing, ...(seed ? [seed] : []), record];
  const encounter = commitExamRecords(current, records, { actor, now });
  return { encounter, record: findRecord(encounter.content.examRecords, recordId) };
}

// 検査記録を変える。送った項目だけを変え、values を送ったときは値をまとめて置き換える（カルテ画面で消した印も外す）。
export function updateExamRecord(current, recordId, input, { actor, now }) {
  requireDraft(current);
  requireExamRevision(current, input.expectedRevision);
  const existing = current.content.examRecords || [];
  const index = existing.findIndex((record) => record.recordId === recordId);
  if (index < 0) {
    const error = new Error("exam record not found");
    error.name = "NotFoundError";
    error.statusCode = 404;
    throw error;
  }
  const before = existing[index];
  const patched = { ...before, updatedBy: actor, updatedAt: now };
  if (input.at !== undefined) patched.at = input.at;
  for (const key of ["source", "examinerMemberId", "examinerName", "note"]) {
    if (input[key] !== undefined) patched[key] = input[key];
  }
  if (input.values !== undefined) {
    patched.values = input.values;
    delete patched.cleared;
  }
  const records = existing.map((record, position) => (position === index ? patched : record));
  const encounter = commitExamRecords(current, records, { actor, now });
  return { encounter, record: findRecord(encounter.content.examRecords, recordId) };
}

function commitExamRecords(current, records, { actor, now }) {
  const examRecords = validateExamRecords(records);
  const exam = deriveExamFromRecords(examRecords);
  const revision = current.revision + 1;
  return {
    ...current,
    content: { ...current.content, examRecords, exam },
    examConfirmations: resetExamConfirmations(current, exam),
    sectionRevisions: { ...(current.sectionRevisions || {}), exam: revision, examRecords: revision },
    revision,
    updatedBy: actor,
    updatedAt: now
  };
}

function findRecord(records, recordId) {
  return records.find((record) => record.recordId === recordId) || null;
}

// 記録の追加・変更は、読み込んだあとに他の人が検査値（exam か記録）を変えていたら止める。
function requireExamRevision(current, expectedRevision) {
  const stale = ["exam", "examRecords"].filter((key) => sectionRevision(current, key) > expectedRevision);
  if (stale.length) {
    const error = conflict("ほかの端末で検査値が更新されました。画面を読み込み直してください。");
    error.details = { sections: stale };
    throw error;
  }
}

// 検査値の確認（視能訓練士・医師）。確認後に値を変えると確認は外れる。
export function confirmExam(current, { eye, confirmed, expectedRevision, actor, now }) {
  requireDraft(current);
  if (sectionRevision(current, "exam") > expectedRevision) {
    const error = conflict("確認する前に検査値が更新されました。画面を読み込み直してください。");
    error.details = { sections: ["exam"] };
    throw error;
  }
  const sides = eye === "both" ? ["od", "os"] : [eye];
  const revision = current.revision + 1;
  const examConfirmations = { ...(current.examConfirmations || { od: null, os: null }) };
  for (const side of sides) examConfirmations[side] = confirmed ? { by: actor, at: now } : null;
  return {
    ...current,
    examConfirmations,
    sectionRevisions: { ...(current.sectionRevisions || {}), examConfirmations: revision },
    revision,
    updatedBy: actor,
    updatedAt: now
  };
}

function stampOrderStatus(before, after, { actor, now }) {
  const previous = new Map(before.map((order) => [order.orderId, order]));
  return after.map((order) => {
    const old = previous.get(order.orderId);
    if (old && old.status === order.status) {
      return { ...order, statusChangedAt: old.statusChangedAt || "", statusChangedBy: old.statusChangedBy || null };
    }
    if (!old && order.status === "planned") return { ...order, statusChangedAt: "", statusChangedBy: null };
    return { ...order, statusChangedAt: now, statusChangedBy: { memberId: actor.memberId, displayName: actor.displayName } };
  });
}

// 項目ごとの版を持たない古いカルテは、全項目が最新の版で変わったものとして扱う（安全側）。
function sectionRevision(encounter, key) {
  if (!encounter.sectionRevisions) return encounter.revision;
  return encounter.sectionRevisions[key] || 0;
}

export function finalizeEncounter(current, { actor, now }) {
  requireDraft(current);
  const version = current.versionCount + 1;
  const content = validateEncounterContent(current.content);
  const { blockers } = evaluateFinalizeReadiness(content, { examConfirmations: current.examConfirmations });
  if (blockers.length > 0) {
    const error = new Error(blockers.map((item) => item.message).join(" "));
    error.name = "FinalizeBlockedError";
    error.statusCode = 400;
    error.field = blockers[0].field;
    error.details = { blockers };
    throw error;
  }
  const finalized = {
    ...current,
    content,
    status: "finalized",
    revision: current.revision + 1,
    versionCount: version,
    amendment: null,
    finalizedBy: actor,
    finalizedAt: now,
    updatedBy: actor,
    updatedAt: now
  };
  const versionDocument = {
    versionId: `${current.encounterId}_v${version}`,
    encounterId: current.encounterId,
    orgId: current.orgId,
    patientId: current.patientId,
    version,
    encounterDate: current.encounterDate,
    visitType: current.visitType,
    content,
    contentHash: contentHash(content),
    amendmentReason: current.amendment?.reason || "",
    finalizedBy: actor,
    finalizedAt: now,
    schemaVersion: 1
  };
  return { encounter: finalized, version: versionDocument };
}

export function amendEncounter(current, { reason, actor, now }) {
  if (current.status !== "finalized") {
    throw conflict("only a finalized encounter can be amended");
  }
  return {
    ...current,
    status: "draft",
    revision: current.revision + 1,
    sectionRevisions: Object.fromEntries(Object.keys(current.sectionRevisions || {}).map((key) => [key, current.sectionRevisions[key]])),
    amendment: { reason, requestedBy: actor, requestedAt: now },
    updatedBy: actor,
    updatedAt: now
  };
}

export function previousFinalizedEncounter(encounters, current) {
  return sortByDate(encounters.filter((encounter) => (
    encounter.status === "finalized"
    && encounter.encounterId !== current.encounterId
    && encounter.encounterDate <= current.encounterDate
  ))).at(-1) || null;
}

// 処方ごとの点眼本数の目安。日数は処方の日数、なければ次回受診までの日数を使う。
export function eyeDropBottleSuggestions(encounter, drugPresets = []) {
  const presets = new Map(drugPresets.map((preset) => [preset.presetId, preset]));
  const fallbackDays = daysUntilNextVisit(encounter.encounterDate, encounter.content?.nextVisit || {});
  return (encounter.content?.prescriptions || []).map((item, index) => {
    if (item.kind !== "eye_drop" || item.issued === false) return { index, applicable: false };
    const preset = item.presetId ? presets.get(item.presetId) : null;
    const days = item.days || fallbackDays;
    const result = calculateEyeDropBottles({
      timesPerDay: item.timesPerDay,
      eye: item.eye,
      days,
      dropsPerBottle: preset?.dropsPerBottle
    });
    return {
      index,
      applicable: true,
      days: days || null,
      daysSource: item.days ? "prescription" : fallbackDays ? "next_visit" : "unknown",
      ...result
    };
  });
}

export function encounterSummary(encounter) {
  return {
    encounterId: encounter.encounterId,
    patientId: encounter.patientId,
    patientSnapshot: encounter.patientSnapshot,
    encounterDate: encounter.encounterDate,
    visitType: encounter.visitType,
    status: encounter.status,
    revision: encounter.revision,
    versionCount: encounter.versionCount,
    amending: Boolean(encounter.amendment),
    diagnoses: encounter.content?.diagnoses || [],
    chiefComplaint: encounter.content?.chiefComplaint || "",
    finalizedAt: encounter.finalizedAt,
    updatedAt: encounter.updatedAt
  };
}

export function contentHash(content) {
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function requireDraft(encounter) {
  if (encounter.status !== "draft") {
    throw conflict("a finalized encounter cannot be edited; amend it first");
  }
}

function conflict(message) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  return error;
}
