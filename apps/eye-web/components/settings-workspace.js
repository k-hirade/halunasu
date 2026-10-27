"use client";

import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { downloadJson, EYE_LABELS, formatDateTime, PHRASE_TARGET_LABELS, PRESCRIPTION_KIND_LABELS } from "../lib/format";

const EVENT_LABELS = {
  "eye.chart_viewed": "患者カルテを閲覧",
  "eye.encounter_viewed": "カルテを閲覧",
  "eye.version_viewed": "確定版を閲覧",
  "eye.encounter_created": "カルテを作成",
  "eye.encounter_updated": "カルテを更新",
  "eye.encounter_finalized": "カルテを確定",
  "eye.encounter_amend_started": "確定版の修正を開始",
  "eye.encounter_discarded": "下書きを破棄",
  "eye.drug_preset_saved": "薬剤設定を保存",
  "eye.order_set_saved": "セットを保存",
  "eye.phrase_saved": "定型文を保存",
  "eye.profile_updated": "アレルギー・病名を更新",
  "eye.exam_confirmed": "検査値を確認",
  "eye.exam_unconfirmed": "検査値の確認を取消",
  "eye.appointment_created": "予約・受付を登録",
  "eye.appointment_updated": "予約を変更",
  "eye.appointment_status_changed": "受付の状態を変更"
};
const EMPTY_PRESET = { name: "", kind: "eye_drop", defaultTimesPerDay: "", dropsPerBottle: "", bottleVolumeMl: "", defaultUsage: "", route: "outside" };

export function SettingsWorkspace() {
  const api = useEyeApi();
  const [context, setContext] = useState(null);
  const [presets, setPresets] = useState([]);
  const [orderSets, setOrderSets] = useState([]);
  const [phrases, setPhrases] = useState([]);
  const [orderCatalog, setOrderCatalog] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [draft, setDraft] = useState(EMPTY_PRESET);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const payload = await api("/v1/eye/bootstrap");
    const nextContext = payload.context;
    setContext(nextContext);
    setPresets(payload.drugPresets);
    setOrderSets(payload.orderSets || []);
    setPhrases(payload.phrases || []);
    setOrderCatalog(payload.orderCatalog || []);
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
          <thead><tr><th>薬剤名</th><th>種類</th><th>1日の回数</th><th>用法</th><th>院内外</th><th>1本の滴数</th><th>容量(mL)</th><th>状態</th></tr></thead>
          <tbody>
            {presets.map((preset) => (
              <tr key={preset.presetId}>
                <td>{preset.name}</td>
                <td>{PRESCRIPTION_KIND_LABELS[preset.kind]}</td>
                <td>{preset.defaultTimesPerDay ?? "—"}</td>
                <td>{preset.defaultUsage || "—"}</td>
                <td>{preset.route === "inside" ? "院内" : "院外"}</td>
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
            {presets.length === 0 ? <tr><td className="empty" colSpan={8}>まだ登録されていません。</td></tr> : null}
          </tbody>
        </table>
        {context.canManageSettings ? (
          <form className="add-row" onSubmit={savePreset}>
            <input aria-label="薬剤名" className="input grow" onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="薬剤名" required value={draft.name} />
            <select aria-label="種類" className="input" onChange={(event) => setDraft({ ...draft, kind: event.target.value })} value={draft.kind}>
              {Object.entries(PRESCRIPTION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <input aria-label="1日の回数" className="input input-num" min="0" onChange={(event) => setDraft({ ...draft, defaultTimesPerDay: event.target.value })} placeholder="回/日" type="number" value={draft.defaultTimesPerDay} />
            <input aria-label="既定の用法" className="input" onChange={(event) => setDraft({ ...draft, defaultUsage: event.target.value })} placeholder="用法" value={draft.defaultUsage} />
            <select aria-label="院内・院外" className="input" onChange={(event) => setDraft({ ...draft, route: event.target.value })} value={draft.route}>
              <option value="outside">院外</option>
              <option value="inside">院内</option>
            </select>
            <input aria-label="1本あたりの滴数" className="input input-num" min="1" onChange={(event) => setDraft({ ...draft, dropsPerBottle: event.target.value })} placeholder="滴/本" type="number" value={draft.dropsPerBottle} />
            <input aria-label="容量" className="input input-num" min="0" onChange={(event) => setDraft({ ...draft, bottleVolumeMl: event.target.value })} placeholder="mL" step="any" type="number" value={draft.bottleVolumeMl} />
            <button className="btn btn-primary" type="submit">追加</button>
          </form>
        ) : <p className="muted small">薬剤の登録は管理者が行います。</p>}
      </section>

      <OrderSetsSection canEdit={context.canManageSettings} catalog={orderCatalog} onSaved={load} orderSets={orderSets} presets={presets} />
      <PhrasesSection canEdit={context.canManageSettings} onSaved={load} phrases={phrases} />

      {context.canManageSettings ? (
        <section className="panel">
          <h2>医院データの出力</h2>
          <p className="muted small">全患者の記録と設定を JSON（halunasu-eye-export-v1）で保存します。システム移行・保管用です。ファイル本体は含まず、保管場所を載せます。</p>
          <button className="btn btn-ghost" onClick={async () => {
            try {
              downloadJson(await api("/v1/eye/export"), `eye-clinic-export-${new Date().toISOString().slice(0, 10)}.json`);
            } catch (nextError) {
              setError(nextError.message);
            }
          }} type="button">医院データを出力</button>
        </section>
      ) : null}

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

const EMPTY_SET = { name: "", description: "", plan: "", prescriptions: [], orders: [] };

function OrderSetsSection({ orderSets, presets, catalog, canEdit, onSaved }) {
  const api = useEyeApi();
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");

  async function save(event) {
    event.preventDefault();
    setError("");
    try {
      await api("/v1/eye/order-sets", { method: "POST", body: draft });
      setDraft(null);
      await onSaved();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <section className="panel">
      <h2>セット（処方・検査・方針の組み合わせ）</h2>
      <p className="muted small">カルテ画面の「候補」から一括で追加できます。例: 緑内障の定期受診、白内障術後1週。</p>
      <ul className="plain">
        {orderSets.map((item) => (
          <li className="set-row" key={item.setId}>
            <strong>{item.name}</strong>
            <span className="muted small"> 処方 {item.prescriptions.map((row) => row.name).join("・") || "—"} ／ 検査 {item.orders.map((row) => row.name).join("・") || "—"}</span>
            {item.active === false ? <span className="tag">停止中</span> : null}
            {canEdit ? <button className="btn btn-chip" onClick={() => setDraft({ ...item })} type="button">編集</button> : null}
          </li>
        ))}
        {orderSets.length === 0 ? <li className="empty">まだ登録されていません。</li> : null}
      </ul>
      {canEdit && !draft ? <button className="btn btn-ghost" onClick={() => setDraft({ ...EMPTY_SET })} type="button">セットを追加</button> : null}
      {draft ? (
        <form className="set-editor" onSubmit={save}>
          {error ? <p className="alert alert-danger">{error}</p> : null}
          <label className="field"><span>セット名</span><input className="input" onChange={(event) => setDraft({ ...draft, name: event.target.value })} required value={draft.name} /></label>
          <h3>処方</h3>
          {draft.prescriptions.map((row, index) => (
            <div className="row-line" key={index}>
              <input aria-label="薬剤名" className="input grow" list="settings-drugs" onChange={(event) => {
                const preset = presets.find((item) => item.name === event.target.value);
                const next = [...draft.prescriptions];
                next[index] = { ...row, name: event.target.value, presetId: preset?.presetId || "", kind: preset?.kind || row.kind, timesPerDay: row.timesPerDay ?? preset?.defaultTimesPerDay ?? null, usage: row.usage || preset?.defaultUsage || "" };
                setDraft({ ...draft, prescriptions: next });
              }} placeholder="薬剤名" value={row.name} />
              <select aria-label="眼" className="input" onChange={(event) => setDraft({ ...draft, prescriptions: draft.prescriptions.map((item, i) => (i === index ? { ...item, eye: event.target.value } : item)) })} value={row.eye || ""}>
                <option value="">眼</option>
                {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input aria-label="1日の回数" className="input input-num" min="0" onChange={(event) => setDraft({ ...draft, prescriptions: draft.prescriptions.map((item, i) => (i === index ? { ...item, timesPerDay: event.target.value === "" ? null : Number(event.target.value) } : item)) })} placeholder="回/日" type="number" value={row.timesPerDay ?? ""} />
              <input aria-label="用法" className="input" onChange={(event) => setDraft({ ...draft, prescriptions: draft.prescriptions.map((item, i) => (i === index ? { ...item, usage: event.target.value } : item)) })} placeholder="用法" value={row.usage || ""} />
              <button className="btn btn-chip danger-text" onClick={() => setDraft({ ...draft, prescriptions: draft.prescriptions.filter((_, i) => i !== index) })} type="button">削除</button>
            </div>
          ))}
          <datalist id="settings-drugs">{presets.map((item) => <option key={item.presetId} value={item.name} />)}</datalist>
          <button className="btn btn-chip" onClick={() => setDraft({ ...draft, prescriptions: [...draft.prescriptions, { kind: "eye_drop", name: "", eye: "ou", timesPerDay: null, usage: "", route: "outside" }] })} type="button">処方を追加</button>
          <h3>検査・処置</h3>
          {draft.orders.map((row, index) => (
            <div className="row-line" key={index}>
              <select aria-label="検査" className="input grow" onChange={(event) => {
                const item = catalog.find((entry) => entry.code === event.target.value);
                setDraft({ ...draft, orders: draft.orders.map((order, i) => (i === index ? { ...order, code: item.code, name: item.name, kind: item.kind } : order)) });
              }} value={row.code}>
                {catalog.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select>
              <select aria-label="眼" className="input" onChange={(event) => setDraft({ ...draft, orders: draft.orders.map((order, i) => (i === index ? { ...order, eye: event.target.value } : order)) })} value={row.eye || "ou"}>
                {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button className="btn btn-chip danger-text" onClick={() => setDraft({ ...draft, orders: draft.orders.filter((_, i) => i !== index) })} type="button">削除</button>
            </div>
          ))}
          <button className="btn btn-chip" onClick={() => setDraft({ ...draft, orders: [...draft.orders, { code: catalog[0]?.code, name: catalog[0]?.name, kind: catalog[0]?.kind, eye: "ou" }] })} type="button">検査を追加</button>
          <label className="field"><span>方針に追加する文</span><textarea className="input" onChange={(event) => setDraft({ ...draft, plan: event.target.value })} rows={2} value={draft.plan} /></label>
          <label className="check-line"><input checked={draft.active !== false} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} type="checkbox" />使用中</label>
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={() => setDraft(null)} type="button">キャンセル</button>
            <button className="btn btn-primary" type="submit">セットを保存</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function PhrasesSection({ phrases, canEdit, onSaved }) {
  const api = useEyeApi();
  const [draft, setDraft] = useState({ target: "plan", label: "", text: "" });
  const [error, setError] = useState("");

  async function save(event, phrase = draft) {
    event?.preventDefault();
    setError("");
    try {
      await api("/v1/eye/phrases", { method: "POST", body: phrase });
      setDraft({ target: draft.target, label: "", text: "" });
      await onSaved();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <section className="panel">
      <h2>定型文</h2>
      {error ? <p className="alert alert-danger">{error}</p> : null}
      <table className="data-table">
        <thead><tr><th>差し込む欄</th><th>表示名</th><th>文</th><th>状態</th></tr></thead>
        <tbody>
          {phrases.map((item) => (
            <tr key={item.phraseId}>
              <td>{PHRASE_TARGET_LABELS[item.target]}</td>
              <td>{item.label || "—"}</td>
              <td className="small">{item.text}</td>
              <td>{canEdit ? <button className="btn btn-chip" onClick={() => save(null, { ...item, active: item.active === false })} type="button">{item.active === false ? "再開する" : "使用中・停止する"}</button> : (item.active === false ? "停止" : "使用中")}</td>
            </tr>
          ))}
          {phrases.length === 0 ? <tr><td className="empty" colSpan={4}>まだ登録されていません。</td></tr> : null}
        </tbody>
      </table>
      {canEdit ? (
        <form className="add-row" onSubmit={save}>
          <select aria-label="差し込む欄" className="input" onChange={(event) => setDraft({ ...draft, target: event.target.value })} value={draft.target}>
            {Object.entries(PHRASE_TARGET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input aria-label="表示名" className="input" onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="表示名（任意）" value={draft.label} />
          <input aria-label="定型文" className="input grow" onChange={(event) => setDraft({ ...draft, text: event.target.value })} placeholder="差し込む文" required value={draft.text} />
          <button className="btn btn-primary" type="submit">追加</button>
        </form>
      ) : null}
    </section>
  );
}
