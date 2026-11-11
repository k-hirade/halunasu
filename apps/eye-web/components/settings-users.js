"use client";

import { useCallback, useEffect, useState } from "react";
import { printableStaffName } from "@halunasu/eye-core";
import { useEyeApi } from "./eye-api";
import { usePlatformAuth } from "./platform-auth";
import { MasterToolbar, SectionHead, SettingsDialog } from "./settings-master";
import { clearPrintNames } from "./use-print-names";
import { formatDateTime } from "../lib/format";
import { eyeRolesOf, LOGIN_ID_PATTERN, nextProductRoles, temporaryPassword, USER_ROLE_OPTIONS } from "../lib/admin";
import { matchesSearch, MEMBER_STATUS_LABELS, memberRoleText, sortMembers, staffSearchValues } from "../lib/settings";

const PRINT_NAME_MAX = 40;

// 利用者管理（デジカル p.201-203）。表: ログインID・利用者名・役割・施設管理権限・状態・最終更新・最終ログイン・パスワード更新・印刷用の氏名。
// 右上の［＋ 新規登録］と行の［編集］でダイアログ（役割・施設管理権限・メール・状態［無効化］・［パスワードリセット］）。
// 利用者そのもの（追加・役割・無効化・パスワード）は共通の契約の基盤（platform）の利用者管理を使う。基盤に接続できない・
// 権限が無いときは、以前と同じく印刷用の氏名だけを直せる表にする。
export function UsersSection({ onDirtyChange, context }) {
  const api = useEyeApi();
  const platform = usePlatformAuth();
  const [staff, setStaff] = useState(null);
  const [members, setMembers] = useState(undefined); // undefined = 確認中, null = 使えない
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [hideInactive, setHideInactive] = useState(true);
  const [dialog, setDialog] = useState(null); // { mode: "new" | "edit", memberId }
  const [flash, setFlash] = useState("");
  const orgId = context?.orgId;

  const loadMembers = useCallback(async () => {
    if (!orgId || !platform?.api) { setMembers(null); return; }
    try {
      const payload = await platform.api(`/v1/organizations/${encodeURIComponent(orgId)}/members`);
      setMembers(Array.isArray(payload.members) ? payload.members : null);
    } catch {
      setMembers(null);
    }
  }, [orgId, platform?.api]);

  useEffect(() => {
    let cancelled = false;
    api("/v1/eye/staff-profiles")
      .then((payload) => { if (!cancelled) setStaff(payload.staff || []); })
      .catch((nextError) => { if (!cancelled) setLoadError(nextError.message); });
    loadMembers();
    return () => { cancelled = true; };
  }, [api, loadMembers]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(""), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  const manageable = Array.isArray(members);
  const head = (
    <SectionHead
      action={manageable ? <button className="btn btn-primary" onClick={() => setDialog({ mode: "new" })} type="button">＋ 新規登録</button> : null}
      count={staff ? rowsOf(staff, members).filter(isActive).length : undefined}
      title="利用者管理"
    >
      {manageable
        ? "眼科を使う職員です。［編集］で役割・施設管理権限・メール・印刷用の氏名を直し、無効化やパスワードのリセットができます。"
        : "眼科の役割を持つ職員です。［編集］で紙に載せる氏名を決めます。利用者の追加・無効化・パスワードの再設定は契約の管理画面で行います。"}
    </SectionHead>
  );
  if (loadError) return <section aria-label="利用者管理" className="settings-section">{head}<p className="alert alert-danger" role="alert">{loadError}</p></section>;
  if (!staff || members === undefined) return <section aria-label="利用者管理" className="settings-section">{head}<p className="loading">読み込み中…</p></section>;

  const rows = rowsOf(staff, members);
  const shown = sortMembers(rows.filter((item) => matchesSearch(query, staffSearchValues(item)) && (!hideInactive || isActive(item))));
  const hiddenCount = rows.filter((item) => !isActive(item)).length;
  const selected = dialog?.memberId ? rows.find((item) => item.memberId === dialog.memberId) : null;

  async function afterSave(message) {
    setDialog(null);
    setFlash(message);
    const [payload] = await Promise.all([api("/v1/eye/staff-profiles").catch(() => null), loadMembers()]);
    if (payload) setStaff(payload.staff || []);
    clearPrintNames();
  }

  return (
    <section aria-label="利用者管理" className="settings-section">
      {head}
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      <div className="master-list">
        <div className="user-toolbar">
          <MasterToolbar onQuery={setQuery} placeholder="氏名・ログイン ID・役割で検索" query={query} searchLabel="利用者を検索" />
          <label className="field-check">
            <input checked={hideInactive} onChange={(event) => setHideInactive(event.target.checked)} type="checkbox" />
            無効な利用者を表示しない{hiddenCount ? `（${hiddenCount}人）` : ""}
          </label>
        </div>
        {shown.length ? (
          <div className="admin-table-wrap">
            <table className="data-table admin-table users-table">
              <thead>
                <tr>
                  <th scope="col">ログイン ID</th><th scope="col">利用者名</th><th scope="col">役割</th><th scope="col">施設管理権限</th><th scope="col">状態</th>
                  {manageable ? <><th scope="col">最終更新</th><th scope="col">最終ログイン</th><th scope="col">パスワード更新</th></> : null}
                  <th scope="col">印刷用の氏名</th><th scope="col">承認</th><th aria-label="操作" scope="col" />
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr className={isActive(item) ? "" : "is-off"} key={item.memberId}>
                    <td className="mono">{item.loginId}</td>
                    <td><strong>{item.displayName}</strong>{item.memberId === context?.memberId ? <span className="muted small user-self">（自分）</span> : null}</td>
                    <td>{memberRoleText(item.eyeRoles)}</td>
                    <td>{item.eyeRoles.includes("admin") ? "あり" : <span className="muted">なし</span>}</td>
                    <td className={isActive(item) ? "" : "user-off"}>{MEMBER_STATUS_LABELS[item.status] || item.status || "有効"}</td>
                    {manageable ? (
                      <>
                        <td className="nowrap">{item.updatedAt ? formatDateTime(item.updatedAt) : <span className="muted">—</span>}</td>
                        <td className="nowrap">{item.lastLoginAt ? formatDateTime(item.lastLoginAt) : <span className="muted">—</span>}</td>
                        <td className="nowrap">{item.passwordUpdatedAt ? formatDateTime(item.passwordUpdatedAt) : <span className="muted">—</span>}</td>
                      </>
                    ) : null}
                    <td>{item.printName ? item.printName : <span className="muted">{printableStaffName(item.displayName)}（自動）</span>}</td>
                    <td className="users-approval">{[item.approver ? "承認者" : "", item.requiresApproval ? "承認が必要" : ""].filter(Boolean).join("・") || <span className="muted">—</span>}</td>
                    <td className="admin-edit"><button aria-label={`${item.displayName}を編集`} className="btn btn-ghost btn-sm" onClick={() => setDialog({ mode: "edit", memberId: item.memberId })} type="button">✎ 編集</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty master-empty">{rows.length ? "該当する利用者はいません。" : "眼科の役割を持つ職員がいません。"}</p>}
      </div>
      {dialog?.mode === "new" ? <NewUserDialog onClose={() => setDialog(null)} onSaved={afterSave} orgId={orgId} platformApi={platform.api} /> : null}
      {dialog?.mode === "edit" && selected ? (
        <EditUserDialog
          api={api}
          manageable={manageable}
          member={selected}
          onClose={() => { setDialog(null); onDirtyChange?.(false); }}
          onSaved={afterSave}
          orgId={orgId}
          platformApi={platform.api}
          self={selected.memberId === context?.memberId}
        />
      ) : null}
    </section>
  );
}

// 眼科の職員（印刷用の氏名つき）と、基盤の利用者（役割・状態・日時）を memberId で重ねる。
// 基盤の一覧が読めるときは、眼科の役割を持つ人に加えて、眼科の役割を外した人（無効と同じ扱い）も並べる。
function rowsOf(staff, members) {
  if (!Array.isArray(members)) return staff;
  const byId = new Map(staff.map((item) => [item.memberId, item]));
  return members
    .filter((member) => eyeRolesOf(member).length || byId.has(member.memberId))
    .map((member) => {
      const profile = byId.get(member.memberId) || {};
      return {
        ...profile,
        memberId: member.memberId,
        loginId: member.loginId,
        displayName: member.displayName || member.loginId,
        email: member.email || "",
        eyeRoles: eyeRolesOf(member),
        status: eyeRolesOf(member).length ? member.status || "active" : "disabled",
        updatedAt: member.updatedAt,
        lastLoginAt: member.lastLoginAt,
        passwordUpdatedAt: member.passwordUpdatedAt,
        printName: profile.printName || "",
        platformMember: member
      };
    });
}

function isActive(member) {
  return !member.status || member.status === "active";
}

function RoleFields({ draft, setDraft, self }) {
  return (
    <>
      <fieldset className="admin-radio">
        <legend>役割</legend>
        {USER_ROLE_OPTIONS.map(([value, label]) => (
          <label className="field-check" key={value}>
            <input checked={draft.roles.includes(value)} onChange={(event) => setDraft({ roles: event.target.checked ? [...draft.roles, value] : draft.roles.filter((item) => item !== value) })} type="checkbox" />
            {label}
          </label>
        ))}
      </fieldset>
      <fieldset className="admin-radio">
        <legend>施設管理権限</legend>
        <label className="field-check"><input checked={draft.admin} name="user-admin" onChange={() => setDraft({ admin: true })} type="radio" />あり</label>
        <label className="field-check"><input checked={!draft.admin} disabled={self} name="user-admin" onChange={() => setDraft({ admin: false })} type="radio" />なし</label>
        {self ? <small className="muted">自分の施設管理権限は外せません。</small> : null}
      </fieldset>
    </>
  );
}

function PasswordNotice({ password }) {
  return (
    <div className="admin-password" role="status">
      <p>仮のパスワード: <code className="mono">{password}</code></p>
      <p className="muted small">この画面を閉じると二度と表示されません。本人に伝え、ログイン後に「パスワード変更」で変えてもらってください。</p>
    </div>
  );
}

function NewUserDialog({ orgId, platformApi, onClose, onSaved }) {
  const [draft, setDraftState] = useState({ loginId: "", displayName: "", email: "", roles: ["doctor"], admin: false });
  const [password] = useState(() => temporaryPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setDraft = (patch) => setDraftState((current) => ({ ...current, ...patch }));

  async function submit() {
    if (!LOGIN_ID_PATTERN.test(draft.loginId.trim())) { setError("ログイン ID は半角の英数字と . _ @ - で3〜64文字にしてください。"); return; }
    if (!draft.displayName.trim()) { setError("利用者名を入れてください。"); return; }
    if (!draft.roles.length && !draft.admin) { setError("役割を1つ以上選んでください。"); return; }
    setBusy(true);
    setError("");
    try {
      await platformApi(`/v1/organizations/${encodeURIComponent(orgId)}/members`, {
        method: "POST",
        csrf: true,
        body: { loginId: draft.loginId.trim(), displayName: draft.displayName.trim(), ...(draft.email.trim() ? { email: draft.email.trim() } : {}), status: "active", productRoles: nextProductRoles(null, draft), password }
      });
      await onSaved(`${draft.displayName.trim()} を登録しました。仮のパスワードを本人に伝えてください: ${password}`);
    } catch (nextError) {
      setError(nextError.status === 409 ? "このログイン ID はすでに使われています。" : nextError.status === 403 ? "利用者を登録する権限がありません（契約の管理者のみ）。" : nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsDialog busy={busy} error={error} onClose={onClose} onSubmit={submit} submitLabel="登録" title="利用者の新規登録" wide>
      <div className="admin-form admin-user-form">
        <label className="field admin-row-field"><span className="admin-row-label">ログイン ID<em className="admin-required">必須</em></span><input aria-label="ログイン ID" autoCapitalize="none" autoComplete="off" className="input" maxLength={64} onChange={(event) => setDraft({ loginId: event.target.value })} spellCheck={false} value={draft.loginId} /></label>
        <label className="field admin-row-field"><span className="admin-row-label">利用者名<em className="admin-required">必須</em></span><input aria-label="利用者名" autoComplete="off" className="input" maxLength={100} onChange={(event) => setDraft({ displayName: event.target.value })} placeholder="例: 山田 花子" value={draft.displayName} /></label>
        <RoleFields draft={draft} setDraft={setDraft} />
        <label className="field admin-row-field"><span className="admin-row-label">メールアドレス</span><input aria-label="メールアドレス" autoComplete="off" className="input" maxLength={200} onChange={(event) => setDraft({ email: event.target.value })} type="email" value={draft.email} /></label>
        <PasswordNotice password={password} />
      </div>
    </SettingsDialog>
  );
}

function EditUserDialog({ member, manageable, self, api, orgId, platformApi, onClose, onSaved }) {
  const platformMember = member.platformMember;
  const [draft, setDraftState] = useState({
    displayName: member.displayName || "",
    email: member.email || "",
    roles: (member.eyeRoles || []).filter((role) => role !== "admin"),
    admin: (member.eyeRoles || []).includes("admin"),
    printName: member.printName || "",
    approver: member.approver === true,
    requiresApproval: member.requiresApproval === true
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const setDraft = (patch) => setDraftState((current) => ({ ...current, ...patch }));
  const membersPath = `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(member.memberId)}`;
  const active = isActive(member);

  async function submit() {
    if (draft.printName.trim().length > PRINT_NAME_MAX) { setError(`印刷用の氏名は${PRINT_NAME_MAX}文字以内で入れてください。`); return; }
    if (manageable && !draft.displayName.trim()) { setError("利用者名を入れてください。"); return; }
    if (manageable && !draft.roles.length && !draft.admin) { setError("役割を1つ以上選んでください。"); return; }
    setBusy(true);
    setError("");
    try {
      if (manageable) {
        const patch = {};
        if (draft.displayName.trim() !== (platformMember.displayName || "")) patch.displayName = draft.displayName.trim();
        if (draft.email.trim() !== (platformMember.email || "")) patch.email = draft.email.trim();
        const roles = nextProductRoles(platformMember, draft);
        if (JSON.stringify(roles) !== JSON.stringify(platformMember.productRoles || {})) patch.productRoles = roles;
        if (Object.keys(patch).length) await platformApi(membersPath, { method: "PATCH", csrf: true, body: patch });
      }
      if (draft.printName.trim() !== (member.printName || "") && (member.eyeRoles || []).length) {
        await api(`/v1/eye/staff-profiles/${encodeURIComponent(member.memberId)}`, { method: "PUT", body: { printName: draft.printName.trim() } });
      }
      // カルテの承認の印（承認者・承認が必要）。変えたものだけ送る
      const flags = Object.fromEntries(["approver", "requiresApproval"].filter((key) => draft[key] !== (member[key] === true)).map((key) => [key, draft[key]]));
      if (Object.keys(flags).length && (member.eyeRoles || []).length) {
        await api(`/v1/eye/staff-profiles/${encodeURIComponent(member.memberId)}`, { method: "PUT", body: flags });
      }
      await onSaved(`${draft.displayName.trim() || member.displayName} を保存しました。`);
    } catch (nextError) {
      setError(nextError.status === 403 ? "この利用者を変更する権限がありません。" : nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function runAction(kind) {
    setBusy(true);
    setError("");
    try {
      if (kind === "reset") {
        const next = temporaryPassword();
        await platformApi(membersPath, { method: "PATCH", csrf: true, body: { password: next } });
        setPassword(next);
      } else {
        await platformApi(membersPath, { method: "PATCH", csrf: true, body: { status: kind === "disable" ? "disabled" : "active" } });
        await onSaved(kind === "disable" ? `${member.displayName} を無効にしました。ログインできなくなります。` : `${member.displayName} を有効に戻しました。`);
      }
      setConfirm("");
    } catch (nextError) {
      setError(nextError.status === 403 ? "この操作を行う権限がありません（最後の管理者は無効にできません）。" : nextError.message);
    } finally {
      setBusy(false);
    }
  }

  const preview = printableStaffName(draft.displayName || member.displayName, draft.printName);
  return (
    <SettingsDialog busy={busy} error={error} onClose={onClose} onSubmit={submit} title="利用者の編集" wide>
      <div className="admin-form admin-user-form">
        <div className="admin-row-field field"><span className="admin-row-label">ログイン ID</span><span className="mono admin-static">{member.loginId}</span></div>
        {manageable ? (
          <>
            <div className="admin-row-field field">
              <span className="admin-row-label">パスワード</span>
              <span className="admin-static admin-inline">
                <span aria-hidden="true">••••••••</span>
                {confirm === "reset" ? (
                  <>
                    <span className="muted small">今のパスワードは使えなくなります。</span>
                    <button className="btn btn-primary btn-sm" onClick={() => runAction("reset")} type="button">リセットする</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirm("")} type="button">やめる</button>
                  </>
                ) : <button className="btn btn-ghost btn-sm" disabled={!active} onClick={() => setConfirm("reset")} type="button">パスワードリセット</button>}
              </span>
            </div>
            {password ? <PasswordNotice password={password} /> : null}
            <label className="field admin-row-field"><span className="admin-row-label">利用者名<em className="admin-required">必須</em></span><input aria-label="利用者名" autoComplete="off" className="input" maxLength={100} onChange={(event) => setDraft({ displayName: event.target.value })} value={draft.displayName} /></label>
            <RoleFields draft={draft} self={self} setDraft={setDraft} />
            <label className="field admin-row-field"><span className="admin-row-label">メールアドレス</span><input aria-label="メールアドレス" autoComplete="off" className="input" maxLength={200} onChange={(event) => setDraft({ email: event.target.value })} type="email" value={draft.email} /></label>
          </>
        ) : (
          <>
            <div className="admin-row-field field"><span className="admin-row-label">利用者名</span><span className="admin-static">{member.displayName}</span></div>
            <div className="admin-row-field field"><span className="admin-row-label">役割</span><span className="admin-static">{memberRoleText(member.eyeRoles)}{(member.eyeRoles || []).includes("admin") ? "（施設管理権限あり）" : ""}</span></div>
          </>
        )}
        <label className="field admin-row-field">
          <span className="admin-row-label">印刷用の氏名</span>
          <input aria-label="印刷用の氏名" autoComplete="off" className="input" maxLength={PRINT_NAME_MAX} onChange={(event) => setDraft({ printName: event.target.value })} placeholder={printableStaffName(member.displayName)} value={draft.printName} />
        </label>
        <p className="muted small">紙には「<strong>{preview || "（空欄）"}</strong>」と出ます。空にすると利用者名から役割の（ ）を除いた名前に戻ります。</p>
        {(member.eyeRoles || []).some((role) => role === "doctor" || role === "admin") ? (
          <div className="admin-row-field field">
            <span className="admin-row-label">カルテの承認</span>
            <span className="admin-static admin-inline">
              <label className="field-check"><input checked={draft.approver} onChange={(event) => setDraft({ approver: event.target.checked })} type="checkbox" />承認者（指導医）</label>
              <label className="field-check"><input checked={draft.requiresApproval} onChange={(event) => setDraft({ requiresApproval: event.target.checked })} type="checkbox" />承認が必要（研修医など）</label>
            </span>
          </div>
        ) : null}
        <div className="admin-row-field field">
          <span className="admin-row-label">状態</span>
          <span className="admin-static admin-inline">
            <span className={active ? "" : "user-off"}>{MEMBER_STATUS_LABELS[member.status] || member.status || "有効"}</span>
            {manageable && !self ? (
              confirm === "status" ? (
                <>
                  <span className="muted small">{active ? "ログインできなくなります。記録は残ります。" : "またログインできるようになります。"}</span>
                  <button className={`btn btn-sm ${active ? "btn-danger" : "btn-primary"}`} onClick={() => runAction(active ? "disable" : "enable")} type="button">{active ? "無効にする" : "有効に戻す"}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirm("")} type="button">やめる</button>
                </>
              ) : <button className={`btn btn-sm ${active ? "btn-ghost danger-text" : "btn-ghost"}`} disabled={!member.platformMember?.status && !active} onClick={() => setConfirm("status")} type="button">{active ? "無効化" : "有効に戻す"}</button>
            ) : null}
          </span>
        </div>
      </div>
    </SettingsDialog>
  );
}
