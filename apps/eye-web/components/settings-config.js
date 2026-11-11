"use client";

import { useCallback, useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { clearPrintSettings } from "./print-settings";
import { SectionHead, SettingsDialog } from "./settings-master";
import { formatDateTime } from "../lib/format";
import { DOC_TYPE_LABELS, hoursText, LABEL_TONE_OPTIONS, newRowKey, SLOT_MINUTE_OPTIONS, stripNewIds, TEMPLATE_PLACEHOLDERS, WEEKDAY_LABELS } from "../lib/admin";
import { HONORIFIC_OPTIONS } from "../lib/paper";

// 施設管理の追加の項目（デジカルの施設管理のメニューに合わせて増やしたもの）。
// どれも /v1/eye/clinic-config/<項目> を読み書きする。古い API（項目が無い）では「この環境ではまだ使えません」と出す。

export function useClinicConfig(section) {
  const api = useEyeApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api(`/v1/eye/clinic-config/${section}`)
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((nextError) => {
        if (cancelled) return;
        if (nextError.status === 404) setUnsupported(true);
        else setError(nextError.message);
      });
    return () => { cancelled = true; };
  }, [api, section]);

  const save = useCallback(async (value) => {
    const payload = await api(`/v1/eye/clinic-config/${section}`, { method: "PUT", body: { expectedRevision: data?.revision || 0, value } });
    setData(payload);
    return payload;
  }, [api, data?.revision, section]);

  return { data, error, unsupported, save };
}

function ConfigFrame({ title, description, config, action = null, children, count }) {
  const head = <SectionHead action={config.data ? action : null} count={count} title={title}>{description}</SectionHead>;
  let body = children;
  if (config.unsupported) body = <p className="alert alert-info">この環境の API はまだこの項目に対応していません。更新後に使えます。</p>;
  else if (config.error) body = <p className="alert alert-danger" role="alert">{config.error}</p>;
  else if (!config.data) body = <p className="loading">読み込み中…</p>;
  return (
    <section aria-label={title} className="settings-section admin-section">
      {head}
      {body}
      {config.data?.revision ? <p className="muted small admin-updated">最終更新 {formatDateTime(config.data.updatedAt)} {config.data.updatedBy?.displayName || ""}</p> : null}
    </section>
  );
}

function useFlash() {
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(""), 3000);
    return () => clearTimeout(timer);
  }, [flash]);
  return [flash, setFlash];
}

// 一覧（表）＋ 右上の［＋ 新規登録］＋ 行の［編集］→ ダイアログ。消さずに「使わない」にする（記録が参照しているため）。
function ConfigList({ label, items, idKey, columns, fields, emptyText, addLabel, canEdit, onSaveItems, newItem, validate }) {
  const [editing, setEditing] = useState(null); // { draft, isNew }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const inactiveCount = items.filter((item) => item.active === false).length;
  const shown = items.filter((item) => showInactive || item.active !== false);

  async function submit() {
    const message = validate?.(editing.draft, items) || fields.filter((field) => field.required && !String(editing.draft[field.key] || "").trim()).map((field) => `${field.label}を入れてください。`)[0];
    if (message) { setError(message); return; }
    setBusy(true);
    setError("");
    try {
      const next = editing.isNew ? [...items, editing.draft] : items.map((item) => (item[idKey] === editing.draft[idKey] ? editing.draft : item));
      await onSaveItems(stripNewIds(next, idKey));
      setEditing(null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-list">
      <div className="admin-list-head">
        <h3>{label}<span className="settings-head-count">{items.filter((item) => item.active !== false).length}</span></h3>
        {inactiveCount ? (
          <label className="field-check"><input checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} type="checkbox" />使わないものも表示（{inactiveCount}）</label>
        ) : null}
        {canEdit ? <button className="btn btn-primary btn-sm" onClick={() => { setError(""); setEditing({ isNew: true, draft: { ...newItem(), [idKey]: newRowKey(), active: true } }); }} type="button">＋ {addLabel}</button> : null}
      </div>
      {shown.length ? (
        <div className="admin-table-wrap">
          <table className="data-table admin-table">
            <thead><tr>{columns.map((column) => <th key={column.label} scope="col">{column.label}</th>)}<th scope="col">状態</th>{canEdit ? <th aria-label="操作" scope="col" /> : null}</tr></thead>
            <tbody>
              {shown.map((item) => (
                <tr className={item.active === false ? "is-off" : ""} key={item[idKey]}>
                  {columns.map((column) => <td className={column.className || ""} key={column.label}>{column.render(item)}</td>)}
                  <td className="admin-state">{item.active === false ? <span className="muted">使わない</span> : "使う"}</td>
                  {canEdit ? <td className="admin-edit"><button aria-label={`${columns[0].text?.(item) || ""}を編集`} className="btn btn-ghost btn-sm" onClick={() => { setError(""); setEditing({ isNew: false, draft: { ...item } }); }} type="button">✎ 編集</button></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="empty master-empty">{emptyText}</p>}
      {editing ? (
        <SettingsDialog busy={busy} error={error} onClose={() => setEditing(null)} onSubmit={submit} title={editing.isNew ? `${label}の登録` : `${label}の編集`} wide={fields.some((field) => field.type === "textarea")}>
          <div className="admin-form">
            {fields.map((field) => <ConfigField draft={editing.draft} field={field} key={field.key} setDraft={(patch) => setEditing((current) => ({ ...current, draft: { ...current.draft, ...patch } }))} />)}
            <label className="field-check admin-active">
              <input checked={editing.draft.active !== false} onChange={(event) => setEditing((current) => ({ ...current, draft: { ...current.draft, active: event.target.checked } }))} type="checkbox" />
              使う（外すと候補に出なくなります。これまでの記録はそのまま残ります）
            </label>
          </div>
        </SettingsDialog>
      ) : null}
    </div>
  );
}

function ConfigField({ field, draft, setDraft }) {
  const value = draft[field.key];
  const labelText = <span>{field.label}{field.required ? <em>必須</em> : null}</span>;
  if (field.type === "checkbox") {
    return <label className="field-check"><input checked={value !== false} onChange={(event) => setDraft({ [field.key]: event.target.checked })} type="checkbox" />{field.label}</label>;
  }
  if (field.type === "select") {
    return (
      <label className="field">
        {labelText}
        <select aria-label={field.label} className="input" onChange={(event) => setDraft({ [field.key]: event.target.value })} value={value ?? ""}>
          {field.options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
        </select>
      </label>
    );
  }
  if (field.type === "textarea") {
    return (
      <label className="field">
        {labelText}
        <textarea aria-label={field.label} className="input admin-textarea" maxLength={field.max} onChange={(event) => setDraft({ [field.key]: event.target.value })} rows={field.rows || 10} value={value || ""} />
        {field.hint ? <small className="muted">{field.hint}</small> : null}
      </label>
    );
  }
  return (
    <label className="field">
      {labelText}
      <input aria-label={field.label} autoComplete="off" className="input" maxLength={field.max} onChange={(event) => setDraft({ [field.key]: event.target.value })} placeholder={field.placeholder || ""} value={value || ""} />
      {field.hint ? <small className="muted">{field.hint}</small> : null}
    </label>
  );
}

function ToneChip({ tone, children }) {
  return <span className={`admin-chip tone-${tone || "gray"}`}>{children}</span>;
}

/* ───────── 文書雛形（デジカル p.212） ───────── */

export function DocTemplatesSection({ canEdit }) {
  const config = useClinicConfig("docTemplates");
  const [flash, setFlash] = useFlash();
  const templates = config.data?.value.templates || [];
  return (
    <ConfigFrame config={config} count={templates.filter((item) => item.active !== false).length} description="紹介状・返書・診断書などの本文のひな形です。文書の画面の「雛形から作る」で選ぶと、{{患者氏名}} などに患者とカルテの内容が入ります。" title="文書雛形">
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      <ConfigList
        addLabel="雛形を追加"
        canEdit={canEdit}
        columns={[
          { label: "表示名", render: (item) => <strong>{item.name}</strong>, text: (item) => item.name },
          { label: "種類", render: (item) => DOC_TYPE_LABELS[item.type] || "" },
          { label: "表題", render: (item) => item.title || <span className="muted">（文書の種類の表題）</span> },
          { label: "見出し", className: "admin-desc", render: (item) => headingsOf(item.body) || <span className="muted">—</span> }
        ]}
        emptyText="雛形はまだありません。よく書く紹介状の形を登録しておくと、項目を埋めるだけで作れます。"
        fields={[
          { key: "name", label: "表示名", required: true, max: 60, placeholder: "例: 白内障手術の紹介" },
          { key: "type", label: "文書の種類", type: "select", options: Object.entries(DOC_TYPE_LABELS) },
          { key: "title", label: "表題（空なら種類の表題）", max: 60, placeholder: "例: 診療情報提供書" },
          { key: "body", label: "本文", type: "textarea", max: 10000, rows: 12, hint: `【見出し】の行ごとに、文書の画面で入力欄になります。差し込み: ${TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(" ")}` }
        ]}
        idKey="templateId"
        items={templates}
        label="雛形"
        newItem={() => ({ name: "", type: "referral", title: "", body: "{{患者氏名}} 様（{{年齢}}・{{性別}}）について、下記の通りご紹介申し上げます。\n\n【傷病名】\n{{傷病名}}\n\n【紹介目的】\n\n【現病歴・経過】\n{{主訴}}\n\n【検査所見】\n{{視力}}\n{{眼圧}}\n{{所見}}\n\n【現在の処方】\n{{処方}}\n\n【アレルギー・副作用歴】\n{{アレルギー}}" })}
        onSaveItems={async (next) => { await config.save({ templates: next }); setFlash("雛形を保存しました。"); }}
      />
    </ConfigFrame>
  );
}

function headingsOf(body) {
  return [...String(body || "").matchAll(/^【([^】\n]+)】/gmu)].map((match) => match[1]).join("・");
}

/* ───────── 検査会社・院内検査項目 ───────── */

export function LabListsSection({ canEdit }) {
  const config = useClinicConfig("labLists");
  const [flash, setFlash] = useFlash();
  const value = config.data?.value || { companies: [], items: [] };
  const companyName = (id) => value.companies.find((item) => item.companyId === id)?.name || "";
  const save = async (patch, message) => { await config.save({ ...value, ...patch }); setFlash(message); };
  return (
    <ConfigFrame config={config} description="院内検査項目はカルテのオーダー（検査・処置）の候補の最後に加わります。外注する検査は検査会社を選んでおくと、候補に会社名が出ます。" title="検査会社・院内検査項目">
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      <ConfigList
        addLabel="院内検査項目を追加"
        canEdit={canEdit}
        columns={[
          { label: "項目名", render: (item) => <strong>{item.name}</strong>, text: (item) => item.name },
          { label: "区分", render: (item) => (item.kind === "procedure" ? "処置" : "検査") },
          { label: "眼の指定", render: (item) => (item.requiresEye !== false ? "右・左・両" : <span className="muted">なし</span>) },
          { label: "検査会社", render: (item) => companyName(item.companyId) || <span className="muted">院内</span> }
        ]}
        emptyText="院内検査項目はまだありません。カルテのオーダーには既定の眼科の検査・処置が出ます。"
        fields={[
          { key: "name", label: "項目名", required: true, max: 60, placeholder: "例: 血糖・HbA1c（外注）" },
          { key: "kind", label: "区分", type: "select", options: [["exam", "検査"], ["procedure", "処置"]] },
          { key: "companyId", label: "検査会社", type: "select", options: [["", "院内で行う"], ...value.companies.filter((item) => item.active !== false).map((item) => [item.companyId, item.name])] },
          { key: "requiresEye", label: "右眼・左眼・両眼を指定する", type: "checkbox" }
        ]}
        idKey="itemId"
        items={value.items}
        label="院内検査項目"
        newItem={() => ({ name: "", kind: "exam", companyId: "", requiresEye: true })}
        onSaveItems={(items) => save({ items }, "院内検査項目を保存しました。次にカルテを開いたときから候補に出ます。")}
      />
      <ConfigList
        addLabel="検査会社を追加"
        canEdit={canEdit}
        columns={[
          { label: "会社名", render: (item) => <strong>{item.name}</strong>, text: (item) => item.name },
          { label: "電話番号", render: (item) => item.phone || <span className="muted">—</span> },
          { label: "メモ", className: "admin-desc", render: (item) => item.note || <span className="muted">—</span> }
        ]}
        emptyText="検査会社はまだありません。"
        fields={[
          { key: "name", label: "会社名", required: true, max: 60 },
          { key: "phone", label: "電話番号", max: 30 },
          { key: "note", label: "メモ（集配の曜日など）", max: 200 }
        ]}
        idKey="companyId"
        items={value.companies}
        label="検査会社"
        newItem={() => ({ name: "", phone: "", note: "" })}
        onSaveItems={(companies) => save({ companies }, "検査会社を保存しました。")}
      />
    </ConfigFrame>
  );
}

/* ───────── 受付ラベル・患者マーク ───────── */

export function ReceptionLabelsSection({ canEdit }) {
  const config = useClinicConfig("receptionLabels");
  const [flash, setFlash] = useFlash();
  const value = config.data?.value || { labels: [], marks: [] };
  const save = async (patch, message) => { await config.save({ ...value, ...patch }); setFlash(message); };
  return (
    <ConfigFrame config={config} description="受付の画面で使う札です。受付ラベルは受付メモに付け（例: 要散瞳・検査のみ）、患者マークは氏名の横に出します（例: 車椅子・難聴）。" title="受付ラベル・患者マーク">
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      <ConfigList
        addLabel="ラベルを追加"
        canEdit={canEdit}
        columns={[
          { label: "ラベル", render: (item) => <ToneChip tone={item.tone}>{item.name}</ToneChip>, text: (item) => item.name },
          { label: "色", render: (item) => LABEL_TONE_OPTIONS.find(([tone]) => tone === item.tone)?.[1] || "" }
        ]}
        emptyText="受付ラベルはまだありません。"
        fields={[
          { key: "name", label: "ラベル名", required: true, max: 20, placeholder: "例: 要散瞳" },
          { key: "tone", label: "色", type: "select", options: LABEL_TONE_OPTIONS }
        ]}
        idKey="labelId"
        items={value.labels}
        label="受付ラベル"
        newItem={() => ({ name: "", tone: "teal" })}
        onSaveItems={(labels) => save({ labels }, "受付ラベルを保存しました。")}
      />
      <ConfigList
        addLabel="マークを追加"
        canEdit={canEdit}
        columns={[
          { label: "マーク", render: (item) => <span className="admin-mark-cell"><ToneChip tone={item.tone}>{item.symbol}</ToneChip>{item.name}</span>, text: (item) => item.name },
          { label: "色", render: (item) => LABEL_TONE_OPTIONS.find(([tone]) => tone === item.tone)?.[1] || "" }
        ]}
        emptyText="患者マークはまだありません。"
        fields={[
          { key: "name", label: "マークの名前", required: true, max: 20, placeholder: "例: 車椅子" },
          { key: "symbol", label: "表示する字（1〜2文字）", required: true, max: 2, placeholder: "例: 車" },
          { key: "tone", label: "色", type: "select", options: LABEL_TONE_OPTIONS }
        ]}
        idKey="markId"
        items={value.marks}
        label="患者マーク"
        newItem={() => ({ name: "", symbol: "", tone: "blue" })}
        onSaveItems={(marks) => save({ marks }, "患者マークを保存しました。")}
      />
    </ConfigFrame>
  );
}

/* ───────── 診療時間・予約枠 ───────── */

export function ClinicHoursSection({ canEdit }) {
  const config = useClinicConfig("clinicHours");
  const [flash, setFlash] = useFlash();
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = config.data?.value;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const days = Object.fromEntries(Object.entries(editing.days).map(([day, ranges]) => [day, ranges.filter((range) => range.from || range.to)]));
      await config.save({ ...editing, days });
      setEditing(null);
      setFlash("診療時間を保存しました。");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  const setRange = (day, index, patch) => setEditing((current) => ({ ...current, days: { ...current.days, [day]: current.days[day].map((range, at) => (at === index ? { ...range, ...patch } : range)) } }));
  return (
    <ConfigFrame
      action={canEdit ? <button className="btn btn-ghost" onClick={() => { setError(""); setEditing(JSON.parse(JSON.stringify(value))); }} type="button">✎ 編集</button> : null}
      config={config}
      description="曜日ごとの診療時間と、予約の1枠の長さです。予約の画面の時間の表と、受付の予約時刻の候補に使います。"
      title="診療時間・予約枠"
    >
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      {value ? (
        <div className="panel facility-panel">
          <dl className="kv-table">
            <div className="kv-row"><dt>予約の1枠</dt><dd>{value.slotMinutes}分</dd></div>
            {WEEKDAY_LABELS.map(([day, label]) => <div className="kv-row" key={day}><dt>{label}曜{day === "holiday" ? "（祝日）" : ""}</dt><dd>{value.days[day]?.length ? hoursText(value.days[day]) : <span className="muted">休診</span>}</dd></div>)}
            <div className="kv-row"><dt>備考</dt><dd>{value.note || <span className="muted">—</span>}</dd></div>
          </dl>
        </div>
      ) : null}
      {editing ? (
        <SettingsDialog busy={busy} error={error} onClose={() => setEditing(null)} onSubmit={submit} title="診療時間・予約枠の編集" wide>
          <label className="field admin-slot">
            <span>予約の1枠</span>
            <select aria-label="予約の1枠" className="input" onChange={(event) => setEditing((current) => ({ ...current, slotMinutes: Number(event.target.value) }))} value={editing.slotMinutes}>
              {SLOT_MINUTE_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes}分</option>)}
            </select>
          </label>
          <div className="admin-hours">
            {WEEKDAY_LABELS.map(([day, label]) => (
              <div className="admin-hours-row" key={day}>
                <span className="admin-hours-day">{label}</span>
                <div className="admin-hours-ranges">
                  {editing.days[day].length ? null : <span className="muted">休診</span>}
                  {editing.days[day].map((range, index) => (
                    <span className="admin-hours-range" key={index}>
                      <input aria-label={`${label}曜 ${index + 1}つ目 開始`} className="input input-time" onChange={(event) => setRange(day, index, { from: event.target.value })} type="time" value={range.from} />
                      <span aria-hidden="true">〜</span>
                      <input aria-label={`${label}曜 ${index + 1}つ目 終了`} className="input input-time" onChange={(event) => setRange(day, index, { to: event.target.value })} type="time" value={range.to} />
                      <button aria-label={`${label}曜 ${index + 1}つ目を消す`} className="btn btn-chip" onClick={() => setEditing((current) => ({ ...current, days: { ...current.days, [day]: current.days[day].filter((_, at) => at !== index) } }))} type="button">×</button>
                    </span>
                  ))}
                  {editing.days[day].length < 3 ? (
                    <button className="btn btn-chip" onClick={() => setEditing((current) => ({ ...current, days: { ...current.days, [day]: [...current.days[day], current.days[day].length ? { from: "14:00", to: "18:00" } : { from: "09:00", to: "12:30" }] } }))} type="button">＋ 時間</button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <label className="field">
            <span>備考</span>
            <input aria-label="備考" className="input" maxLength={200} onChange={(event) => setEditing((current) => ({ ...current, note: event.target.value }))} placeholder="例: 木曜午後・日曜・祝日は休診" value={editing.note} />
          </label>
        </SettingsDialog>
      ) : null}
    </ConfigFrame>
  );
}

/* ───────── 帳票設定・その他設定（キーと値の表 ＋［編集］） ───────── */

function KeyValueSettings({ section, title, description, rows, canEdit, flashText }) {
  const config = useClinicConfig(section);
  const [flash, setFlash] = useFlash();
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = config.data?.value;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await config.save(editing);
      if (section === "printSettings") clearPrintSettings();
      setEditing(null);
      setFlash(flashText);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfigFrame
      action={canEdit ? <button className="btn btn-ghost" onClick={() => { setError(""); setEditing({ ...value }); }} type="button">✎ 編集</button> : null}
      config={config}
      description={description}
      title={title}
    >
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      {value ? (
        <div className="panel facility-panel">
          <dl className="kv-table">
            {rows.map((row) => <div className="kv-row" key={row.key}><dt>{row.label}</dt><dd>{row.view(value[row.key]) || <span className="muted">—</span>}</dd></div>)}
          </dl>
        </div>
      ) : null}
      {editing ? (
        <SettingsDialog busy={busy} error={error} onClose={() => setEditing(null)} onSubmit={submit} title={`${title}の編集`}>
          <div className="admin-form">
            {rows.map((row) => (row.options ? (
              <fieldset className="admin-radio" key={row.key}>
                <legend>{row.label}</legend>
                {row.options.map(([optionValue, optionLabel]) => (
                  <label className="field-check" key={String(optionValue)}>
                    <input checked={editing[row.key] === optionValue} name={`${section}-${row.key}`} onChange={() => setEditing((current) => ({ ...current, [row.key]: optionValue }))} type="radio" />
                    {optionLabel}
                  </label>
                ))}
              </fieldset>
            ) : (
              <label className="field" key={row.key}>
                <span>{row.label}</span>
                <input aria-label={row.label} className="input" maxLength={row.max} onChange={(event) => setEditing((current) => ({ ...current, [row.key]: event.target.value }))} placeholder={row.placeholder || ""} value={editing[row.key] || ""} />
              </label>
            )))}
          </div>
        </SettingsDialog>
      ) : null}
    </ConfigFrame>
  );
}

const yesNo = [[true, "する"], [false, "しない"]];
const optionText = (options) => (value) => options.find(([optionValue]) => optionValue === value)?.[1] || "";

export function PrintSettingsSection({ canEdit }) {
  const honorifics = HONORIFIC_OPTIONS.map(([value, label]) => [value, label]);
  return (
    <KeyValueSettings
      canEdit={canEdit}
      description="紙（紹介状・会計連絡票）の印字を医院ごとに選びます。"
      flashText="帳票設定を保存しました。これから印刷する紙に反映されます。"
      rows={[
        { key: "defaultHonorific", label: "紹介状の宛名の敬称（新しい文書の既定）", options: honorifics, view: optionText(honorifics) },
        { key: "letterSeal", label: "紹介状に印の欄を出す", options: yesNo, view: optionText(yesNo) },
        { key: "billingSlipDiagnoses", label: "会計連絡票に病名を出す", options: yesNo, view: optionText(yesNo) },
        { key: "footerNote", label: "紙の下の一言（紹介状・会計連絡票）", max: 200, placeholder: "例: お問い合わせは受付まで（9:00〜18:00）", view: (value) => value }
      ]}
      section="printSettings"
      title="帳票設定"
    />
  );
}

export function OtherSettingsSection({ canEdit }) {
  const inputModes = [["fields", "項目ごとの入力欄（雛形の見出しごと）"], ["text", "本文をまとめて編集"]];
  const ranges = [["today", "今日"], ["7d", "7日間"], ["30d", "30日間"]];
  return (
    <KeyValueSettings
      canEdit={canEdit}
      description="画面の既定の動きを選びます。"
      flashText="その他設定を保存しました。"
      rows={[
        { key: "documentInputMode", label: "文書を開いたときの入力の形", options: inputModes, view: optionText(inputModes) },
        { key: "auditDefaultRange", label: "操作記録を開いたときの期間", options: ranges, view: optionText(ranges) }
      ]}
      section="otherSettings"
      title="その他設定"
    />
  );
}
