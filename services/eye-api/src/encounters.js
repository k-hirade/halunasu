import { createHash } from "node:crypto";
import { assertEncounterReadyToFinalize, validateEncounterContent } from "../../../packages/eye-contracts/src/index.js";
import {
  calculateEyeDropBottles,
  copyContentForRevisit,
  daysUntilNextVisit,
  emptyEncounterContent,
  sortByDate
} from "../../../packages/eye-core/src/index.js";

// カルテの状態遷移。draft で編集し、finalize で版を確定する。確定後の修正は amend で draft に戻し、次の版として確定する。

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

export function applyEncounterUpdate(current, input, { actor, now }) {
  requireDraft(current);
  return {
    ...current,
    encounterDate: input.encounterDate ?? current.encounterDate,
    visitType: input.visitType ?? current.visitType,
    content: input.content,
    revision: current.revision + 1,
    updatedBy: actor,
    updatedAt: now
  };
}

export function finalizeEncounter(current, { actor, now }) {
  requireDraft(current);
  const version = current.versionCount + 1;
  const content = validateEncounterContent(current.content);
  assertEncounterReadyToFinalize(content);
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
    if (item.kind !== "eye_drop") return { index, applicable: false };
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
