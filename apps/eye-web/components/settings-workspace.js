"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { formatDateTime, PRESCRIPTION_KIND_LABELS } from "../lib/format";

const EVENT_LABELS = {
  "eye.chart_viewed": "患者カルテを閲覧",
  "eye.encounter_viewed": "カルテを閲覧",
  "eye.version_viewed": "確定版を閲覧",
  "eye.encounter_created": "カルテを作成",
  "eye.encounter_updated": "カルテを更新",
  "eye.encounter_finalized": "カルテを確定",
  "eye.encounter_amend_started": "確定版の修正を開始",
  "eye.encounter_discarded": "下書きを破棄",
  "eye.drug_preset_saved": "薬剤設定を保存"
};
const EMPTY_PRESET = { name: "", kind: "eye_drop", defaultTimesPerDay: "", dropsPerBottle: "", bottleVolumeMl: "" };

export function SettingsWorkspace() {
  const api = useEyeApi();
  const [context, setContext] = useState(null);
  const [presets, setPresets] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [draft, setDraft] = useState(EMPTY_PRESET);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const { context: nextContext, drugPresets } = await api("/v1/eye/bootstrap");
    setContext(nextContext);
    setPresets(drugPresets);
    if (nextContext.canManageSettings) {
      setAuditLogs((await api("/v1/eye/audit-logs")).auditLogs);
    }
  }

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function savePreset(event, preset = draft) {
    event?.preventDefault();
    setError("");
    try {
      await api("/v1/eye/drug-presets", {
        method: "POST",
        body: {
          ...preset,
          defaultTimesPerDay: preset.defaultTimesPerDay === "" ? null : Number(preset.defaultTimesPerDay),
          dropsPerBottle: preset.dropsPerBottle === "" ? null : Number(preset.dropsPerBottle),
          bottleVolumeMl: preset.bottleVolumeMl === "" ? null : Number(preset.bottleVolumeMl)
        }
      });
      setDraft(EMPTY_PRESET);
      setNotice(`「${preset.name}」を保存しました。`);
      await load();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  if (!context) return <main className="eye-page">{error ? <p className="alert alert-danger">{error}</p> : <p className="loading">読み込み中…</p>}</main>;

  return (
    <main className="eye-page">
      <header className="page-head"><h1>設定</h1></header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {notice ? <p className="alert alert-ok" role="status">{notice}</p> : null}

      <section className="panel">
        <h2>よく使う薬剤</h2>
        <p className="muted small">処方入力の候補に出ます。「1本あたりの滴数」は点眼本数の計算に使います（未設定なら100滴で計算します）。</p>
        <table className="data-table">
          <thead><tr><th>薬剤名</th><th>種類</th><th>1日の回数</th><th>1本の滴数</th><th>容量(mL)</th><th>状態</th></tr></thead>
          <tbody>
            {presets.map((preset) => (
              <tr key={preset.presetId}>
                <td>{preset.name}</td>
                <td>{PRESCRIPTION_KIND_LABELS[preset.kind]}</td>
                <td>{preset.defaultTimesPerDay ?? "—"}</td>
                <td>{preset.dropsPerBottle ?? "—"}</td>
                <td>{preset.bottleVolumeMl ?? "—"}</td>
                <td>
                  {context.canManageSettings ? (
                    <button className="btn btn-chip" onClick={() => savePreset(null, { ...preset, active: preset.active === false })} type="button">
                      {preset.active === false ? "再開する" : "使用中・停止する"}
                    </button>
                  ) : (preset.active === false ? "停止" : "使用中")}
                </td>
              </tr>
            ))}
            {presets.length === 0 ? <tr><td className="empty" colSpan={6}>まだ登録されていません。</td></tr> : null}
          </tbody>
        </table>
        {context.canManageSettings ? (
          <form className="add-row" onSubmit={savePreset}>
            <input aria-label="薬剤名" className="input grow" onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="薬剤名" required value={draft.name} />
            <select aria-label="種類" className="input" onChange={(event) => setDraft({ ...draft, kind: event.target.value })} value={draft.kind}>
              {Object.entries(PRESCRIPTION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <input aria-label="1日の回数" className="input input-num" min="0" onChange={(event) => setDraft({ ...draft, defaultTimesPerDay: event.target.value })} placeholder="回/日" type="number" value={draft.defaultTimesPerDay} />
            <input aria-label="1本あたりの滴数" className="input input-num" min="1" onChange={(event) => setDraft({ ...draft, dropsPerBottle: event.target.value })} placeholder="滴/本" type="number" value={draft.dropsPerBottle} />
            <input aria-label="容量" className="input input-num" min="0" onChange={(event) => setDraft({ ...draft, bottleVolumeMl: event.target.value })} placeholder="mL" step="any" type="number" value={draft.bottleVolumeMl} />
            <button className="btn btn-primary" type="submit">追加</button>
          </form>
        ) : <p className="muted small">薬剤の登録は管理者が行います。</p>}
      </section>

      {context.canManageSettings ? (
        <section className="panel">
          <h2>操作記録（直近200件）</h2>
          <table className="data-table">
            <thead><tr><th>日時</th><th>操作</th><th>担当</th><th>対象</th></tr></thead>
            <tbody>
              {auditLogs.map((log) => (
                <tr key={log.auditLogId}>
                  <td>{formatDateTime(log.createdAt)}</td>
                  <td>{EVENT_LABELS[log.eventType] || log.eventType}</td>
                  <td>{log.actorLoginId}</td>
                  <td className="mono small">{log.patientId || log.targetId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </main>
  );
}
