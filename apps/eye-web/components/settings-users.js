"use client";

import { useEffect, useState } from "react";
import { printableStaffName } from "@halunasu/eye-core";
import { useEyeApi } from "./eye-api";
import { MasterEditorPanel, MasterRows, MasterToolbar, SectionHead, useMasterEditor } from "./settings-master";
import { clearPrintNames } from "./use-print-names";
import { EYE_ROLE_LABELS, matchesSearch, MEMBER_STATUS_LABELS, memberRoleText, sortMembers, staffSearchValues } from "../lib/settings";

const PRINT_NAME_MAX = 40;

// 利用者（デジカルの施設管理の「利用者管理」の一覧に合わせる）。眼科の役割を持つ職員と、紙に載せる氏名。
// ここで直せるのは印刷用の氏名だけ。利用者の追加・無効化・パスワードは契約の管理画面で行う（platform 側）。
export function UsersSection({ onDirtyChange }) {
  const api = useEyeApi();
  const [staff, setStaff] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [hideInactive, setHideInactive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api("/v1/eye/staff-profiles")
      .then((payload) => { if (!cancelled) setStaff(payload.staff || []); })
      .catch((nextError) => { if (!cancelled) setLoadError(nextError.message); });
    return () => { cancelled = true; };
  }, [api]);

  const editor = useMasterEditor({
    idKey: "memberId",
    toDraft: (item) => ({ memberId: item?.memberId || "", printName: item?.printName || "" }),
    toBody: (draft) => draft,
    validate: (draft) => (draft.printName.trim().length > PRINT_NAME_MAX ? `${PRINT_NAME_MAX}文字以内で入れてください。` : ""),
    fieldLabels: { printName: "印刷用の氏名" },
    onDirtyChange,
    save: async ({ memberId, printName }) => {
      const { staffProfile } = await api(`/v1/eye/staff-profiles/${encodeURIComponent(memberId)}`, { method: "PUT", body: { printName: printName.trim() } });
      setStaff((items) => (items || []).map((item) => (item.memberId === staffProfile.memberId ? staffProfile : item)));
      clearPrintNames();
      return staffProfile;
    }
  });

  const head = (
    <SectionHead count={staff ? staff.filter((item) => isActive(item)).length : undefined} title="利用者">
      眼科の役割を持つ職員です。［編集］で紙（眼鏡処方箋・カルテの印刷・紹介状）に載せる氏名を決めます。利用者の追加・無効化・パスワードの再設定は契約の管理画面で行います。
    </SectionHead>
  );
  if (loadError) return <section aria-label="利用者" className="settings-section">{head}<p className="alert alert-danger" role="alert">{loadError}</p></section>;
  if (!staff) return <section aria-label="利用者" className="settings-section">{head}<p className="loading">読み込み中…</p></section>;

  const shown = sortMembers(staff.filter((item) => matchesSearch(query, staffSearchValues(item)) && (!hideInactive || isActive(item))));
  const selected = editor.selection ? staff.find((item) => item.memberId === editor.selection.id) : null;
  const hiddenCount = staff.filter((item) => !isActive(item)).length;
  const renderRow = (item) => (
    <>
      <span className="user-login mono" title={item.loginId}>{item.loginId}</span>
      <span className="master-name"><strong title={item.displayName}>{item.displayName}</strong></span>
      <span className="user-role">{memberRoleText(item.eyeRoles)}</span>
      {/* スマホは見出しの行がないので「設定権限」を前に付ける */}
      <span className="user-admin"><span className="user-cell-label">設定権限</span>{item.eyeRoles.includes("admin") ? "あり" : <span className="muted">なし</span>}</span>
      <span className="user-print" title={item.printName || `${printableStaffName(item.displayName)}（自動）`}>{item.printName ? item.printName : <span className="muted">{printableStaffName(item.displayName)}（自動）</span>}</span>
      <span className={`user-status${isActive(item) ? "" : " is-off"}`}>{MEMBER_STATUS_LABELS[item.status] || item.status || "有効"}</span>
    </>
  );

  return (
    <section aria-label="利用者" className="settings-section">
      {head}
      <div className="master-list">
        <div className="user-toolbar">
          <MasterToolbar onQuery={setQuery} placeholder="氏名・ログイン ID・役割で検索" query={query} searchLabel="利用者を検索" />
          <label className="field-check">
            <input checked={hideInactive} onChange={(event) => setHideInactive(event.target.checked)} type="checkbox" />
            無効な利用者を表示しない{hiddenCount ? `（${hiddenCount}人）` : ""}
          </label>
        </div>
        {shown.length ? (
          <div className="master-table">
            <div aria-hidden="true" className="master-head user-cols"><span>ログイン ID</span><span>利用者名</span><span>役割</span><span>設定権限</span><span>印刷用の氏名</span><span>状態</span></div>
            <MasterRows className="user-cols" idKey="memberId" items={shown} onOpen={editor.open} renderRow={renderRow} selectedId={editor.selection?.id} />
          </div>
        ) : <p className="empty master-empty">{staff.length ? "該当する利用者はいません。" : "眼科の役割を持つ職員がいません。"}</p>}
      </div>
      <MasterEditorPanel allowToggle={false} canEdit editor={editor} label="利用者の編集" title={selected?.displayName || "利用者"}>
        {editor.selection && selected ? <UserForm draft={editor.selection.draft} member={selected} setDraft={editor.setDraft} /> : null}
      </MasterEditorPanel>
    </section>
  );
}

function isActive(member) {
  return !member.status || member.status === "active";
}

function UserForm({ draft, setDraft, member }) {
  const preview = printableStaffName(member.displayName, draft.printName);
  return (
    <>
      <dl className="staff-facts">
        <div><dt>利用者名</dt><dd>{member.displayName}</dd></div>
        <div><dt>ログイン ID</dt><dd>{member.loginId}</dd></div>
        <div><dt>役割</dt><dd>{member.eyeRoles.map((role) => EYE_ROLE_LABELS[role] || role).join("・")}</dd></div>
        <div><dt>状態</dt><dd>{MEMBER_STATUS_LABELS[member.status] || member.status || "有効"}</dd></div>
      </dl>
      <label className="field">
        <span>印刷用の氏名</span>
        <input
          aria-label="印刷用の氏名"
          autoComplete="off"
          className="input"
          maxLength={PRINT_NAME_MAX}
          onChange={(event) => setDraft((current) => ({ ...current, printName: event.target.value }))}
          placeholder={printableStaffName(member.displayName)}
          value={draft.printName}
        />
      </label>
      <p className="muted small">紙には「<strong>{preview || "（空欄）"}</strong>」と出ます。空にすると利用者名から役割の（ ）を除いた名前に戻ります。</p>
    </>
  );
}
