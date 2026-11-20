"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { SectionHead, SettingsDialog } from "./settings-master";
import { formatDateTime } from "../lib/format";
import { BUILTIN_CHART_TEMPLATES } from "../lib/chart-soap";

const MAX_TEXT = 2000;

// 記載の型（要望 #40）。医師ごとの主訴・所見のひな形。新しいカルテの主訴・所見が空なら、担当医の型が入る。
// 管理者はすべての医師の型を、医師は自分の型だけを直せる（セットと同じく医師も設定画面に入れる）。
export function ChartTemplatesSection({ context }) {
  const api = useEyeApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // { template, draft: { text, active } }
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [flash, setFlash] = useState("");

  useEffect(() => {
    let cancelled = false;
    api("/v1/eye/chart-templates")
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((nextError) => { if (!cancelled) setError(nextError.status === 404 ? "この環境の API はまだこの項目に対応していません。更新後に使えます。" : nextError.message); });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(""), 3000);
    return () => clearTimeout(timer);
  }, [flash]);

  const canEdit = (template) => Boolean(data?.canEditAll || (data?.canEditOwn && template.memberId === context.memberId));
  // 管理者でない医師には自分の型だけを出す
  const shown = (data?.templates || []).filter((template) => data.canEditAll || !data.canEditOwn || template.memberId === context.memberId);

  function open(template) {
    setDialogError("");
    setEditing({ template, draft: { text: template.text || "", active: template.revision ? template.active : true } });
  }

  async function submit() {
    setBusy(true);
    setDialogError("");
    try {
      const { template } = await api(`/v1/eye/chart-templates/${encodeURIComponent(editing.template.memberId)}`, {
        method: "PUT",
        body: { expectedRevision: editing.template.revision || 0, text: editing.draft.text, active: editing.draft.active }
      });
      setData((current) => ({ ...current, templates: current.templates.map((item) => (item.memberId === template.memberId ? template : item)) }));
      setEditing(null);
      setFlash(`${template.resolvedName || template.displayName}の記載の型を保存しました。これから作るカルテに入ります。`);
    } catch (nextError) {
      setDialogError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  const setDraft = (patch) => setEditing((current) => ({ ...current, draft: { ...current.draft, ...patch } }));

  return (
    <section aria-label="記載の型" className="settings-section admin-section">
      <SectionHead count={shown.filter((item) => item.active && item.text).length} title="記載の型">
        医師ごとの、カルテの主訴・所見のひな形です（例: S)・O)・A)・P) の見出し）。新しいカルテの主訴・所見が空のとき、担当医の型が入ります。カルテの「型を入れる」でも入れられます。
        {data && !data.canEditAll ? (data.canEditOwn ? " 自分の型だけを変えられます。" : " 変更は医師本人か管理者が行います。") : ""}
      </SectionHead>
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {!data && !error ? <p className="loading">読み込み中…</p> : null}
      {data ? (
        shown.length ? (
          <div className="admin-table-wrap">
            <table className="data-table admin-table chart-template-table">
              <thead><tr><th scope="col">医師</th><th scope="col">型</th><th scope="col">状態</th><th aria-label="操作" scope="col" /></tr></thead>
              <tbody>
                {shown.map((template) => (
                  <tr className={template.active && template.text ? "" : "is-off"} key={template.memberId}>
                    <td>
                      {template.resolvedName || template.displayName}
                      {template.memberId === context.memberId ? <span className="tag master-tag">自分</span> : null}
                      {template.updatedAt ? <span className="muted small chart-template-updated">{formatDateTime(template.updatedAt)}</span> : null}
                    </td>
                    <td className="admin-desc"><span className="chart-template-preview">{template.text || <span className="muted">未設定</span>}</span></td>
                    <td className="admin-state">{template.text ? (template.active ? "使う" : <span className="muted">使わない</span>) : <span className="muted">—</span>}</td>
                    <td className="admin-edit">
                      {canEdit(template) ? <button aria-label={`${template.resolvedName || template.displayName}の記載の型を編集`} className="btn btn-ghost btn-sm" onClick={() => open(template)} type="button">✎ 編集</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty master-empty">医師の役割を持つ利用者がいません。利用者管理で医師を登録すると、ここに並びます。</p>
      ) : null}
      {editing ? (
        <SettingsDialog busy={busy} error={dialogError} onClose={() => setEditing(null)} onSubmit={submit} title={`記載の型（${editing.template.resolvedName || editing.template.displayName}）`} wide>
          <div className="admin-form">
            <div className="field">
              <span>例から入れる</span>
              <div className="chart-template-examples">
                {BUILTIN_CHART_TEMPLATES.map((example) => (
                  <button className="btn btn-chip" key={example.id} onClick={() => setDraft({ text: example.text })} title={example.text} type="button">{example.label}</button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>型の文</span>
              <textarea aria-label="記載の型の文" className="input chart-template-input" maxLength={MAX_TEXT} onChange={(event) => setDraft({ text: event.target.value })} placeholder={"S)\nO)\nA)\nP)"} rows={8} value={editing.draft.text} />
              <small className="muted">{editing.draft.text.length} / {MAX_TEXT} 文字。主訴・所見がすでに書かれているカルテ（前回から写ったものを含む）には入りません。</small>
            </label>
            <label className="field-check admin-active">
              <input checked={editing.draft.active} onChange={(event) => setDraft({ active: event.target.checked })} type="checkbox" />
              使う（外すと新しいカルテに入らず、「型を入れる」にも出ません）
            </label>
          </div>
        </SettingsDialog>
      ) : null}
    </section>
  );
}
