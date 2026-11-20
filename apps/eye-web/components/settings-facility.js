"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { FACILITY_CHANGED_EVENT } from "./patient-search";
import { SectionHead, SettingsDialog } from "./settings-master";
import { formatDateTime } from "../lib/format";
import { facilityBaseValue } from "../lib/settings";
import { facilityDisplayValue, FACILITY_EDIT_FIELDS as FACILITY_FIELDS } from "../lib/admin";

// 古い API（追加の欄を返さない）では、追加の欄を出さない
const ADDED_FIELDS = new Set(["nameKana", "representative", "representativeKana", "prescriptionRoute", "invoiceRegistrationNumber"]);
function fieldsFor(data) {
  return FACILITY_FIELDS.filter((field) => !ADDED_FIELDS.has(field.key) || (data?.facilitySettings && field.key in data.facilitySettings));
}

// 医療機関情報（デジカルの施設管理の「医療機関情報」と同じく、キーと値の表 + 右上の［編集］→ ダイアログ）。
// 編集はデジカル p.200 と同じ 1 列（左に項目名・必須の印、右に入力欄）。フリガナ・代表者・院内院外・適格事業者番号を含む。
// ここで入れた値が紹介状・カルテの印刷・眼鏡処方箋・会計連絡票に載る。空欄は基本の施設情報（契約時の登録）を使う。
export function FacilitySection({ canEdit }) {
  const api = useEyeApi();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");

  useEffect(() => {
    let cancelled = false;
    api("/v1/eye/facility-settings")
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((nextError) => { if (!cancelled) setLoadError(nextError.message); });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(""), 3000);
    return () => clearTimeout(timer);
  }, [flash]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/facility-settings", { method: "PUT", body: { expectedRevision: data.facilitySettings.revision, ...editing } });
      setData(payload);
      setEditing(null);
      setFlash("医療機関情報を保存しました。これから印刷する紙に反映されます。");
      // ヘッダーの医療機関名を取り直させる
      window.dispatchEvent(new CustomEvent(FACILITY_CHANGED_EVENT));
    } catch (nextError) {
      const field = FACILITY_FIELDS.find((item) => item.key === nextError.field);
      setError(field ? `「${field.label}」: ${nextError.message}` : nextError.message);
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <SectionHead
      action={canEdit && data ? <button className="btn btn-ghost" onClick={() => { setError(""); setEditing(Object.fromEntries(fieldsFor(data).map((field) => [field.key, data.facilitySettings[field.key] || ""]))); }} type="button">✎ 編集</button> : null}
      title="医療機関情報"
    >
      紹介状・カルテの印刷・眼鏡処方箋・会計連絡票に載ります。空欄の項目は基本の施設情報を使います。{canEdit ? "" : "変更は管理者が行います。"}
    </SectionHead>
  );

  if (loadError) return <section aria-label="医療機関情報" className="settings-section">{head}<p className="alert alert-danger" role="alert">{loadError}</p></section>;
  if (!data) return <section aria-label="医療機関情報" className="settings-section">{head}<p className="loading">読み込み中…</p></section>;

  const settings = data.facilitySettings;
  return (
    <section aria-label="医療機関情報" className="settings-section">
      {head}
      {flash ? <p className="alert alert-ok" role="status">{flash}</p> : null}
      <div className="panel facility-panel">
        <dl className="kv-table">
          {fieldsFor(data).map((field) => {
            const own = facilityDisplayValue(field.key, settings[field.key]);
            const base = facilityBaseValue(data.baseFacility, field.key);
            return (
              <div className="kv-row" data-field={field.key} key={field.key}>
                <dt>{field.label}</dt>
                <dd>
                  {own ? <span className="kv-value">{own}</span> : base ? (
                    <span className="kv-value is-base">{base}<span className="kv-note">基本情報</span></span>
                  ) : <span className="muted">未記入</span>}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="muted small facility-updated">
          {settings.revision ? `最終更新 ${formatDateTime(settings.updatedAt)} ${settings.updatedBy?.displayName || ""}` : "まだこの画面で入力していません（基本の施設情報を使っています）。"}
        </p>
      </div>

      {editing ? (
        <SettingsDialog busy={busy} error={error} onClose={() => setEditing(null)} onSubmit={save} title="医療機関情報の編集" wide>
          <div className="facility-form admin-facility-form">
            {fieldsFor(data).map((field) => (
              <label className="field admin-row-field" key={field.key}>
                <span className="admin-row-label">{field.label}{field.required ? <em className="admin-required">必須</em> : null}</span>
                {field.options ? (
                  <select aria-label={field.label} className="input" onChange={(event) => setEditing((current) => ({ ...current, [field.key]: event.target.value }))} value={editing[field.key] || ""}>
                    {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                ) : (
                  <input
                    aria-label={field.label}
                    autoComplete="off"
                    className="input"
                    inputMode={field.inputMode}
                    maxLength={field.max}
                    onChange={(event) => setEditing((current) => ({ ...current, [field.key]: event.target.value }))}
                    placeholder={facilityBaseValue(data.baseFacility, field.key) || field.placeholder || ""}
                    type={field.type || "text"}
                    value={editing[field.key] || ""}
                  />
                )}
              </label>
            ))}
          </div>
          <p className="muted small">空欄にすると基本の施設情報（薄い字の値）を使います。住所は都道府県から 1 行で入れてください。</p>
        </SettingsDialog>
      ) : null}
    </section>
  );
}
