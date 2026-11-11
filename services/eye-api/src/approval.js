// カルテの承認（指導医の承認）。トプコン IMAGEnet eカルテの「承認」、研修医のカルテを指導医が承認する流れに倣う。
//
// - 施設の設定（clinic-config の approval.enabled）で使うかどうかを決める。既定は使わない（従来の動きのまま）。
// - 職員ごとの印（eye_staff_profiles）: approver = 承認者（指導医）、requiresApproval = 承認が必要（研修医など）。
// - 承認が要るのは、設定が有効で「確定した人が承認が必要」か「前に承認の流れに入ったカルテを承認者でない人が確定した」とき。
//   承認者が確定したとき（指導医が直して確定した）は、その版をそのまま承認済みにする（auto）。
// - 承認・差し戻しは、承認者（医師・管理者の役割＋承認者の印）だけ。自分が確定した版は承認できない。
//   承認するのは「画面で見ている版」で、その後に新しい版ができていたら 409。
// - 差し戻しはカルテを確定済みのまま「差し戻し」にする（会計を止めないため）。書いた人が直して確定すると、次の版が承認待ちになる。
// - 確定した版（eye_encounter_versions）は書き換えない。承認の記録はカルテの approval.history に足していく。

export const APPROVAL_STATUSES = Object.freeze(["pending", "approved", "returned"]);
export const APPROVAL_STATUS_LABELS = Object.freeze({ pending: "承認待ち", approved: "承認済み", returned: "差し戻し" });
const MAX_COMMENT = 1000;
const MAX_HISTORY = 100;

export function defaultApprovalSettings() {
  return { enabled: false };
}

export function validateApprovalSettings(value = {}) {
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw invalid("enabled must be a boolean", "enabled");
  return { enabled: value.enabled === true };
}

// 職員の印（staff-profiles の PUT）。送られたものだけを返す（送られていない印は今の値のまま）。
export function validateStaffApprovalFlags(input = {}) {
  const flags = {};
  for (const key of ["approver", "requiresApproval"]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw invalid(`${key} must be a boolean`, key);
    flags[key] = input[key];
  }
  return flags;
}

export function validateApprovalActionInput(input = {}, { requireComment = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("body must be an object", "body");
  const { expectedRevision, version } = input;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw invalid("expectedRevision must be a non-negative integer", "expectedRevision");
  if (!Number.isInteger(version) || version < 1) throw invalid("version must be a positive integer", "version");
  if (input.comment !== undefined && typeof input.comment !== "string") throw invalid("comment must be a string", "comment");
  const comment = String(input.comment || "").replace(/\r\n?/gu, "\n").trim();
  if (comment.length > MAX_COMMENT) throw invalid(`comment must be at most ${MAX_COMMENT} characters`, "comment");
  if (requireComment && !comment) throw invalid("差し戻しの理由を入れてください。", "comment");
  return { expectedRevision, version, comment };
}

// 確定のときに、この版の承認をどうするか。null = 承認の流れに入らない。
export function approvalRequirement({ enabled, staffProfile, current }) {
  if (!enabled) return null;
  const isApprover = staffProfile?.approver === true;
  const needs = staffProfile?.requiresApproval === true;
  const inFlow = Boolean(current?.approval);
  if (isApprover && !needs) return inFlow ? "auto_approved" : null;
  if (needs || inFlow) return "pending";
  return null;
}

// 確定した直後のカルテに承認の状態を付ける（版の内容は変えない）。
export function applyFinalizeApproval(encounter, version, { requirement, actor, now }) {
  if (!requirement) return encounter;
  const by = actorBrief(actor);
  const entry = requirement === "auto_approved"
    ? { action: "auto_approved", version: version.version, contentHash: version.contentHash, by, at: now, comment: "" }
    : { action: "requested", version: version.version, contentHash: version.contentHash, by, at: now, comment: "" };
  const approval = requirement === "auto_approved"
    ? { status: "approved", version: version.version, contentHash: version.contentHash, requestedBy: by, requestedAt: now, decidedBy: by, decidedAt: now, comment: "", auto: true }
    : { status: "pending", version: version.version, contentHash: version.contentHash, requestedBy: by, requestedAt: now, decidedBy: null, decidedAt: "", comment: "" };
  return { ...encounter, approval: { ...approval, history: appendHistory(encounter.approval?.history, entry) } };
}

// 承認・差し戻し。止める条件: 確定済みでない・承認待ちでない・見ている版が最新でない・自分が確定した版。
export function decideApproval(current, { decision, version, comment, actor, now }) {
  if (current.status !== "finalized") throw conflict("確定していないカルテは承認できません（修正中です）。");
  const approval = current.approval;
  if (!approval || approval.status !== "pending") throw conflict("このカルテは承認待ちではありません。画面を読み込み直してください。");
  if (version !== current.versionCount || approval.version !== current.versionCount) throw conflict("このカルテには新しい版があります。画面を読み込み直してください。");
  if (current.finalizedBy?.memberId && current.finalizedBy.memberId === actor.memberId) {
    throw forbidden("自分が確定したカルテは承認・差し戻しできません。");
  }
  const by = actorBrief(actor);
  const status = decision === "approve" ? "approved" : "returned";
  const entry = { action: status, version, contentHash: approval.contentHash, by, at: now, comment };
  return {
    ...current,
    approval: { ...approval, status, decidedBy: by, decidedAt: now, comment, auto: false, history: appendHistory(approval.history, entry) },
    revision: current.revision + 1,
    sectionRevisions: { ...(current.sectionRevisions || {}), approval: current.revision + 1 },
    updatedAt: now
  };
}

// 一覧・見出しに出す要約。修正中（draft）のときは、前の版の承認の状態を stale として返す。
export function approvalBrief(encounter) {
  const approval = encounter?.approval;
  if (!approval) return null;
  const current = encounter.status === "finalized" && approval.version === encounter.versionCount;
  return {
    status: approval.status,
    version: approval.version,
    current,
    requestedBy: approval.requestedBy || null,
    requestedAt: approval.requestedAt || "",
    decidedBy: approval.decidedBy || null,
    decidedAt: approval.decidedAt || "",
    comment: approval.comment || "",
    auto: Boolean(approval.auto)
  };
}

// 版ごとの承認の記録（版履歴に出す）。
export function versionApprovalEvents(encounter, versionNumber) {
  return (encounter?.approval?.history || []).filter((entry) => entry.version === versionNumber);
}

// 承認待ちの一覧の 1 行。本文は返さない。
export function approvalListItem(encounter) {
  return {
    encounterId: encounter.encounterId,
    patientId: encounter.patientId,
    patientName: encounter.patientSnapshot?.displayName || "",
    patientNameKana: encounter.patientSnapshot?.displayNameKana || "",
    encounterDate: encounter.encounterDate,
    version: encounter.approval?.version || encounter.versionCount,
    status: encounter.approval?.status || "",
    requestedAt: encounter.approval?.requestedAt || "",
    requestedBy: encounter.approval?.requestedBy?.displayName || "",
    finalizedBy: encounter.finalizedBy?.displayName || ""
  };
}

// 承認待ち（今の版が承認待ちのもの）だけ。修正中（draft）は書いた人の手元にあるので出さない。
export function isAwaitingApproval(encounter) {
  return encounter?.status === "finalized" && encounter.approval?.status === "pending" && encounter.approval.version === encounter.versionCount;
}

function appendHistory(history = [], entry) {
  return [...history, entry].slice(-MAX_HISTORY);
}

function actorBrief(actor) {
  return { memberId: actor.memberId, loginId: actor.loginId || "", displayName: actor.displayName || "" };
}

function invalid(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.name = "ForbiddenError";
  error.statusCode = 403;
  return error;
}
