// カルテの承認（指導医の承認）の表示の判定。API（services/eye-api/src/approval.js）が返す approval の要約を読む。
// approval: { status: pending|approved|returned, version, current, requestedBy, requestedAt, decidedBy, decidedAt, comment, auto }
// current は「いまの版（確定済み）の承認か」。修正中（下書き）のときは false（前の版の承認の状態）。

export const APPROVAL_LABELS = Object.freeze({ pending: "承認待ち", approved: "承認済み", returned: "差し戻し" });
export const APPROVAL_EVENT_LABELS = Object.freeze({ requested: "承認待ちにした", approved: "承認", returned: "差し戻し", auto_approved: "承認（指導医が確定）" });

// カルテ全体（encounter.approval を持つもの）から、API と同じ形の要約を作る（画面で直した直後も正しく出すため）。
export function approvalBriefOf(encounter) {
  const approval = encounter?.approval;
  if (!approval) return null;
  return {
    status: approval.status,
    version: approval.version,
    current: encounter.status === "finalized" && !encounter.amendment && approval.version === encounter.versionCount,
    requestedBy: approval.requestedBy || null,
    requestedAt: approval.requestedAt || "",
    decidedBy: approval.decidedBy || null,
    decidedAt: approval.decidedAt || "",
    comment: approval.comment || "",
    auto: Boolean(approval.auto)
  };
}

// カルテガイドの最後に足す「承認」のボタン（承認の流れに入ったカルテだけ）。
export function approvalGuideItem(brief) {
  if (!brief) return null;
  if (!brief.current) return { id: "approval", label: "承認", state: "todo", hint: "修正中（確定後にもう一度承認）" };
  if (brief.status === "approved") return { id: "approval", label: "承認", state: "done", hint: "承認済み" };
  return { id: "approval", label: "承認", state: "warn", hint: brief.status === "returned" ? "差し戻し" : "承認待ち" };
}

// 一覧・見出しに出す札。承認を使っていないカルテ・修正中のカルテは null。
export function approvalTag(approval) {
  if (!approval || !approval.current) return null;
  if (approval.status === "approved") return { tone: "ok", label: "承認済み", title: approvedTitle(approval) };
  if (approval.status === "returned") return { tone: "danger", label: "差し戻し", title: approval.comment ? `差し戻しの理由: ${approval.comment}` : "差し戻されました" };
  return { tone: "warn", label: "承認待ち", title: `v${approval.version} の承認待ち` };
}

// 会計・印刷に出す「未承認」（承認の流れに入っていて、いまの版がまだ承認されていない）。
export function isUnapproved(approval) {
  return Boolean(approval && approval.current && approval.status !== "approved");
}

// 版ごとの承認（版履歴・印刷）。events は API の versions[].approvalEvents。
// 戻り値: null（承認の流れの外）・{ approved: true, by, at }・{ approved: false, returned, comment }
export function versionApproval(events = []) {
  if (!events?.length) return null;
  const approved = [...events].reverse().find((event) => event.action === "approved" || event.action === "auto_approved");
  if (approved) return { approved: true, by: approved.by?.displayName || "", at: approved.at, auto: approved.action === "auto_approved" };
  const returned = [...events].reverse().find((event) => event.action === "returned");
  return { approved: false, returned: Boolean(returned), comment: returned?.comment || "", by: returned?.by?.displayName || "", at: returned?.at || "" };
}

function approvedTitle(approval) {
  const who = approval.decidedBy?.displayName || "";
  return approval.auto ? `指導医（${who}）が確定した版` : `${who} が承認`;
}
