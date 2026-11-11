"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APPOINTMENT_STATUS_MENU } from "@halunasu/eye-contracts";
import { usePopoverPlacement } from "./popover-placement";
import { APPOINTMENT_PURPOSE_LABELS, APPOINTMENT_STATUS_LABELS } from "../lib/format";
import { HISTORY_FIELD_LABELS, historyTime, historyValueLabel, MARK_TONES, marksOf } from "../lib/reception-extras";
import { queueLabel } from "../lib/reception-table";

// 受付の設定（受付メモのラベル・患者マークの定義）。読めなくても受付は使える（空の一覧になる）。
export function useReceptionSettings(api) {
  const [settings, setSettings] = useState({ labels: [], marks: [], revision: 0, loaded: false });
  const reload = useCallback(async () => {
    const payload = await api("/v1/eye/reception-settings");
    setSettings({ ...payload.settings, loaded: true });
    return payload.settings;
  }, [api]);
  useEffect(() => { reload().catch(() => setSettings((current) => ({ ...current, loaded: true }))); }, [reload]);
  // ラベルを 1 つ足す（ほかの端末で変わっていたら読み直して足し直す）
  const addLabel = useCallback(async (label) => {
    const attempt = async (current) => api("/v1/eye/reception-settings", { method: "PUT", body: { expectedRevision: current.revision, labels: [...current.labels.filter((item) => item !== label), label] } });
    let payload;
    try {
      payload = await attempt(settings);
    } catch (error) {
      if (error.status !== 409) throw error;
      payload = await attempt(await reload());
    }
    setSettings({ ...payload.settings, loaded: true });
    return payload.settings;
  }, [api, reload, settings]);
  return { settings, reload, addLabel };
}

// 患者マーク（行頭の小さな印）。押せるときは押すとマークのダイアログ
export function MarkBadges({ keys = [], definitions = [], name = "", onOpen = null }) {
  const marks = marksOf(keys, definitions);
  const badges = marks.length ? marks.map((mark) => (
    <span className={`rc-mark tone-${MARK_TONES.includes(mark.tone) ? mark.tone : "neutral"}`} key={mark.key} title={mark.label}>{mark.symbol}</span>
  )) : null;
  const label = marks.length ? marks.map((mark) => mark.label).join("・") : "なし";
  if (!onOpen) return <span aria-label={`マーク: ${label}`} className="rc-marks">{badges}</span>;
  return (
    <button aria-label={`${name} のマーク: ${label}`} className="rc-marks rc-marks-edit" onClick={onOpen} title={marks.length ? label : "マークを付ける"} type="button">
      {badges || <span aria-hidden="true" className="rc-mark-empty">＋</span>}
    </button>
  );
}

// ステータスのボタンとメニュー（デジカルの「診察待 ▾」）。全ステータスを並べ、取消は最後（確認してから）。再計待は表示だけ。
export function StatusMenu({ appointment, display, disabled, onChange, onRequestCancel }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const panelRef = useRef(null);
  usePopoverPlacement(panelRef, open, { anchorRef });
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (panelRef.current?.contains(event.target) || anchorRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector("[aria-checked='true'], [role='menuitemradio']:not(:disabled)")?.focus();
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  function choose(status) {
    setOpen(false);
    if (status === display) return;
    if (status === "cancelled") onRequestCancel();
    else onChange(status);
  }

  function onMenuKey(event) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const items = [...panelRef.current.querySelectorAll("[role='menuitemradio']:not(:disabled)")];
    const index = items.indexOf(document.activeElement);
    const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  }

  return (
    <span className="rc-status-wrap">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${appointment.patientName} のステータス`}
        className={`rc-status is-${display}`}
        data-status={display}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        ref={anchorRef}
        type="button"
      >
        {APPOINTMENT_STATUS_LABELS[display] || display}
        <span aria-hidden="true" className="rc-status-caret">▾</span>
      </button>
      {open ? (
        <div aria-label={`${appointment.patientName} のステータスを変える`} className="rc-status-menu" onKeyDown={onMenuKey} ref={panelRef} role="menu">
          {APPOINTMENT_STATUS_MENU.map((status) => (
            <button
              aria-checked={status === display}
              className={`rc-status-item${status === "cancelled" ? " is-cancel" : ""}`}
              disabled={status === "rebill_waiting"}
              key={status}
              onClick={() => choose(status)}
              role="menuitemradio"
              title={status === "rebill_waiting" ? "会計連携の後にカルテが変わると自動で再計待になります" : undefined}
              type="button"
            >
              <span aria-hidden="true" className={`rc-dot is-${status}`} />
              {status === "cancelled" ? "受付取消" : APPOINTMENT_STATUS_LABELS[status]}
              {status === display ? <span aria-hidden="true" className="rc-status-check">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

// 受付取消の確認。受付は消さず「取消」にする（絞り込みで取消を選ぶと見える）
export function CancelReceptionDialog({ appointment, busy, onCancel, onConfirm }) {
  useEscape(onCancel, busy);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="rc-cancel-heading" aria-modal="true" className="dialog" role="alertdialog">
        <h2 id="rc-cancel-heading">受付を取り消しますか？</h2>
        <p>{appointment.patientName}（{queueLabel(appointment) === "-" ? `予約 ${appointment.time || "時刻なし"}` : `受付 ${queueLabel(appointment)}`}）を取消にします。</p>
        <p className="muted small">記録は消えません。受付一覧の絞り込みで「取消」を選ぶと表示でき、ステータスを選び直すと元に戻せます。</p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">戻る</button>
          <button autoFocus className="btn btn-danger" disabled={busy} onClick={onConfirm} type="button">{busy ? "取り消しています…" : "受付を取り消す"}</button>
        </div>
      </div>
    </div>
  );
}

// 受付メモ（デジカルの受付メモ）: 上にラベルのチップと［＋］（医院のラベルから選ぶ・新しく足す）、下に自由記述
export function ReceptionMemoDialog({ appointment, labels: allLabels, onAddLabel, onCancel, onSave }) {
  const initialLabels = appointment.receptionLabels || [];
  const initialText = appointment.receptionMemo ?? appointment.note ?? "";
  const [labels, setLabels] = useState(initialLabels);
  const [text, setText] = useState(initialText);
  const [picking, setPicking] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEscape(() => (picking ? setPicking(false) : onCancel()), busy);
  const unchanged = text.trim() === initialText.trim() && labels.join("\n") === initialLabels.join("\n");
  const choices = allLabels.filter((label) => !labels.includes(label));

  async function addNew(event) {
    event.preventDefault();
    const label = newLabel.replace(/\s+/gu, " ").trim();
    if (!label || adding) return;
    setError("");
    setAdding(true);
    try {
      if (!allLabels.includes(label)) await onAddLabel(label);
      setLabels((current) => (current.includes(label) ? current : [...current, label]));
      setNewLabel("");
      setPicking(false);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setAdding(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({ labels, text: text.trim(), labelsChanged: labels.join("\n") !== initialLabels.join("\n"), textChanged: text.trim() !== initialText.trim() });
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="rc-memo-heading" aria-modal="true" className="dialog rc-memo-dialog rc-memo-dialog-wide" onSubmit={submit} role="dialog">
        <h2 id="rc-memo-heading">受付メモ（{appointment.patientName}）</h2>
        <p className="muted small">この日の受付だけのメモです。ラベルは医院で決めた語から選ぶか、［＋］で足します。</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <div className="rc-label-bar">
          <div aria-label="受付のラベル" className="rc-label-chips" role="list">
            {labels.length ? labels.map((label) => (
              <span className="rc-label-chip" key={label} role="listitem">
                {label}
                <button aria-label={`ラベル「${label}」を外す`} className="rc-label-remove" onClick={() => setLabels(labels.filter((item) => item !== label))} type="button">×</button>
              </span>
            )) : <span className="muted small">ラベルなし</span>}
          </div>
          <button aria-expanded={picking} aria-label="ラベルを追加" className="btn btn-ghost btn-sm rc-label-add" onClick={() => setPicking(!picking)} type="button">＋</button>
        </div>
        {picking ? (
          <div className="rc-label-picker" role="group" aria-label="ラベルを選ぶ">
            <div className="rc-label-choices">
              {choices.length ? choices.map((label) => (
                <button className="btn btn-chip" key={label} onClick={() => { setLabels([...labels, label]); }} type="button">{label}</button>
              )) : <span className="muted small">医院のラベルはすべて付いています。</span>}
            </div>
            <div className="rc-label-new">
              <input
                aria-label="新しいラベル"
                className="input"
                maxLength={20}
                onChange={(event) => setNewLabel(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) addNew(event); }}
                placeholder="新しいラベル（医院の一覧に足します）"
                value={newLabel}
              />
              <button className="btn btn-ghost btn-sm" disabled={!newLabel.trim() || adding} onClick={addNew} type="button">{adding ? "足しています…" : "足す"}</button>
            </div>
          </div>
        ) : null}
        <textarea aria-label="受付メモ" autoFocus className="input" maxLength={1000} onChange={(event) => setText(event.target.value)} rows={8} value={text} />
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || adding || unchanged} type="submit">登録</button>
        </div>
      </form>
    </div>
  );
}

// 患者マーク（トプコンの患者マーキング）: 医院で決めたマークを付け外しする
export function MarksDialog({ patientName, definitions, selected, onCancel, onSave }) {
  const [keys, setKeys] = useState(selected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEscape(onCancel, busy);
  const toggle = (key) => setKeys(keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(definitions.map((mark) => mark.key).filter((key) => keys.includes(key)));
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="rc-marks-heading" aria-modal="true" className="dialog rc-marks-dialog" onSubmit={submit} role="dialog">
        <h2 id="rc-marks-heading">患者マーク（{patientName}）</h2>
        <p className="muted small">患者に付ける印です。毎回の受付の行頭に出ます。</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <div className="rc-marks-grid">
          {definitions.map((mark) => (
            <label className={`rc-mark-option${keys.includes(mark.key) ? " is-on" : ""}`} key={mark.key}>
              <input checked={keys.includes(mark.key)} onChange={() => toggle(mark.key)} type="checkbox" />
              <span aria-hidden="true" className={`rc-mark tone-${MARK_TONES.includes(mark.tone) ? mark.tone : "neutral"}`}>{mark.symbol}</span>
              {mark.label}
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || keys.slice().sort().join() === selected.slice().sort().join()} type="submit">登録</button>
        </div>
      </form>
    </div>
  );
}

// 受付編集履歴（その日の一覧）: 取消を含むその日の受付と、作成・最終編集の日時と人。［詳細］で 1 件の履歴
export function DayHistoryDialog({ api, date, appointments, doctorName, onClose }) {
  const [detail, setDetail] = useState(null);
  useEscape(() => (detail ? setDetail(null) : onClose()), false);
  const rows = [...appointments].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="rc-history-heading" aria-modal="true" className="dialog rc-history-dialog" role="dialog">
        <div className="rc-history-head">
          <h2 id="rc-history-heading">受付編集履歴（{date.replaceAll("-", "/")}）</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">閉じる</button>
        </div>
        <p className="muted small">取り消した受付も出ます（最終編集はいちばん新しい変更の日時です）。</p>
        <div className="rc-history-wrap">
          <table className="rc-history-table">
            <thead>
              <tr>
                <th scope="col">番号</th><th scope="col">予約時間</th><th scope="col">ステータス</th><th scope="col">氏名</th>
                <th scope="col">作成</th><th scope="col">作成者</th><th scope="col">最終編集</th><th scope="col">編集者</th><th scope="col"><span className="sr-only">詳細</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.appointmentId}>
                  <td className="mono">{queueLabel(item)}</td>
                  <td className="mono">{item.time || "-"}</td>
                  <td><span className={`rc-status-tag is-${item.displayStatus || item.status}`}>{APPOINTMENT_STATUS_LABELS[item.displayStatus || item.status]}</span></td>
                  <td>{item.patientName}</td>
                  <td className="mono">{historyTime(item.createdAt)}</td>
                  <td>{actorName(item.createdBy)}</td>
                  <td className="mono">{historyTime(item.updatedAt)}</td>
                  <td>{actorName(item.updatedBy)}</td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => setDetail(item)} type="button">詳細</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <p className="muted">この日の受付はありません。</p> : null}
        </div>
        {detail ? <ReceptionHistoryDialog api={api} appointment={detail} doctorName={doctorName} onClose={() => setDetail(null)} /> : null}
      </div>
    </div>
  );
}

// 1 件の受付の詳細履歴（作成・ステータス・項目の変更）
export function ReceptionHistoryDialog({ api, appointment, doctorName, onClose }) {
  const [state, setState] = useState({ loading: true, error: "", history: [], appointment: null });
  useEscape(onClose, false);
  useEffect(() => {
    let alive = true;
    api(`/v1/eye/appointments/${appointment.appointmentId}`)
      .then((payload) => { if (alive) setState({ loading: false, error: "", history: payload.history || [], appointment: payload.appointment }); })
      .catch((error) => { if (alive) setState({ loading: false, error: error.message, history: [], appointment: null }); });
    return () => { alive = false; };
  }, [api, appointment.appointmentId]);
  const describe = (entry) => {
    if (entry.kind === "created") return "受付を作成";
    if (entry.kind === "status") return `ステータスを「${APPOINTMENT_STATUS_LABELS[entry.status] || entry.status}」に変更`;
    return (entry.changes || []).map((change) => `${HISTORY_FIELD_LABELS[change.field] || change.field}: ${historyValueLabel(change.field, change.from, { doctorName, purposeLabels: APPOINTMENT_PURPOSE_LABELS })} → ${historyValueLabel(change.field, change.to, { doctorName, purposeLabels: APPOINTMENT_PURPOSE_LABELS })}`).join(" / ");
  };
  return (
    <div className="dialog-backdrop rc-history-detail-backdrop" role="presentation">
      <div aria-labelledby="rc-history-detail-heading" aria-modal="true" className="dialog rc-history-dialog" role="dialog">
        <div className="rc-history-head">
          <h2 id="rc-history-detail-heading">受付の詳細履歴（{appointment.patientName}）</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">閉じる</button>
        </div>
        {state.error ? <p className="alert alert-danger" role="alert">{state.error}</p> : null}
        {state.loading ? <p className="muted">読み込み中…</p> : (
          <div className="rc-history-wrap">
            <table className="rc-history-table">
              <thead><tr><th scope="col">日時</th><th scope="col">操作した人</th><th scope="col">内容</th></tr></thead>
              <tbody>
                {state.history.map((entry, index) => (
                  <tr key={`${entry.at}-${index}`}>
                    <td className="mono">{historyTime(entry.at)}</td>
                    <td>{actorName(entry.by)}</td>
                    <td className="rc-history-change">{describe(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function actorName(actor) {
  return actor?.displayName || actor?.loginId || "-";
}

function useEscape(handler, busy) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.stopPropagation();
      ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);
}
