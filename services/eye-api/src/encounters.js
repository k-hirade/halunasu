import { createHash } from "node:crypto";
import { COMMENT_KIND, DEFAULT_AMENDMENT_REASON, ENCOUNTER_SECTIONS, validateEncounterContent } from "../../../packages/eye-contracts/src/index.js";
import {
  calculateEyeDropBottles,
  copyContentForRevisit,
  daysUntilNextVisit,
  emptyEncounterContent,
  evaluateFinalizeReadiness,
  sortByDate
} from "../../../packages/eye-core/src/index.js";

// カルテの状態遷移。draft で編集し、finalize で版を確定する。確定後の修正は amend で draft に戻し、次の版として確定する。
// デジカルと同じく、確定済みのカルテもそのまま編集できる: 確定済みへの保存（PATCH）は自動で修正を始め（理由は任意、
// 既定は「修正」）、次の確定で新しい版になる。確定した版は消さない・書き換えない（真正性）。

export function buildDraftEncounter({ encounterId, orgId, patientSnapshot, input, copySource, actor, now }) {
  const content = input.content
    ? input.content
    : copySource
      ? copyContentForRevisit(copySource.content)
      : emptyEncounterContent();
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
export function applyEncounterUpdate(loaded, input, { actor, now }) {
  const changed = ENCOUNTER_SECTIONS.filter((key) => (
    Object.hasOwn(input.sections, key) && stableStringify(input.sections[key]) !== stableStringify(loaded.content[key])
  ));
  const metaChanged = (input.encounterDate !== undefined && input.encounterDate !== loaded.encounterDate)
    || (input.visitType !== undefined && input.visitType !== loaded.visitType);
  const keys = metaChanged ? [...changed, "meta"] : changed;
  if (keys.length === 0) return { encounter: loaded, changed: false, amendStarted: false };

  // 確定済みへの保存は、確定後の内容を見たうえでの編集（expectedRevision が確定後の版以上）のときだけ修正を始める。
  // 確定前に開いていた画面からの遅れた保存は、確定した内容を知らないので止める。
  let current = loaded;
  let amendStarted = false;
  if (loaded.status === "finalized") {
    if (input.expectedRevision < loaded.revision) {
      const error = conflict("このカルテは確定されました。画面を読み込み直してください。");
      error.details = { sections: keys };
      throw error;
    }
    current = amendEncounter(loaded, { reason: input.amendmentReason || DEFAULT_AMENDMENT_REASON, actor, now, auto: true });
    amendStarted = true;
  }

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

  const examConfirmations = { ...(current.examConfirmations || { od: null, os: null }) };
  if (changed.includes("exam")) {
    for (const side of ["od", "os"]) {
      if (stableStringify(content.exam[side]) !== stableStringify(current.content.exam?.[side])) examConfirmations[side] = null;
    }
  }

  return {
    changed: true,
    amendStarted,
    encounter: {
      ...current,
      encounterDate: input.encounterDate ?? current.encounterDate,
      visitType: input.visitType ?? current.visitType,
      content,
      examConfirmations,
      sectionRevisions: { ...(current.sectionRevisions || {}), ...Object.fromEntries(keys.map((key) => [key, revision])) },
      revision,
      updatedBy: actor,
      updatedAt: now
    }
  };
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
    if (order.kind === COMMENT_KIND) return order;
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

// 確定。止めるのは記録として成り立たない入力（blockers）だけで、確認を促す項目（warnings）は返して確定する。
export function finalizeEncounter(current, { actor, now }) {
  requireDraft(current);
  const version = current.versionCount + 1;
  const content = validateEncounterContent(current.content);
  const { blockers, warnings } = evaluateFinalizeReadiness(content, { examConfirmations: current.examConfirmations });
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
    // 確定したときに出ていた確認事項（コードだけ。止めずに確定したことの記録）
    warningCodes: [...new Set(warnings.map((item) => item.code))],
    finalizedBy: actor,
    finalizedAt: now,
    schemaVersion: 1
  };
  return { encounter: finalized, version: versionDocument, warnings };
}

export function amendEncounter(current, { reason, actor, now, auto = false }) {
  if (current.status !== "finalized") {
    throw conflict("only a finalized encounter can be amended");
  }
  return {
    ...current,
    status: "draft",
    revision: current.revision + 1,
    sectionRevisions: Object.fromEntries(Object.keys(current.sectionRevisions || {}).map((key) => [key, current.sectionRevisions[key]])),
    amendment: { reason: reason || DEFAULT_AMENDMENT_REASON, requestedBy: actor, requestedAt: now, ...(auto ? { auto: true } : {}) },
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
