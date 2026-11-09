"use client";

import { useState } from "react";
import { prescriptionText } from "../lib/format";

// 保存状態。自動保存なので「いま保存されているか」だけをはっきり見せる。
export function SaveIndicator({ state, onRetry }) {
  if (state === "saving") return <span aria-live="polite" className="save-state is-saving">保存中…</span>;
  if (state === "dirty") return <span aria-live="polite" className="save-state is-dirty" title="⌘/Ctrl + S ですぐ保存">● 未保存</span>;
  if (state === "error") return <button className="btn btn-chip danger-text" onClick={onRetry} type="button">保存に失敗・再試行</button>;
  return <span aria-live="polite" className="save-state is-saved">✓ 保存済み</span>;
}

// このダイアログの中で解消できる確認（検査値の確認・引き継ぎ処方の確認）。
export const RESOLVED_IN_DIALOG = new Set(["exam_unconfirmed", "prescription_carried_over"]);

const WARNING_KINDS = {
  exam_unconfirmed: ["検査値", "未確認"],
  order_planned: ["検査・処置", "予定のまま"],
  prescription_eye_missing: ["処方", "眼の指定"],
  prescription_carried_over: ["処方", "前回から引き継ぎ"],
  prescription_name_missing: ["処方", "薬剤名なし"],
  diagnosis_name_missing: ["病名", "病名なし"],
  comment_text_missing: ["コメント", "文なし"],
  chief_complaint_empty: ["記載", "主訴なし"],
  plan_empty: ["記載", "方針なし"],
  next_visit_missing: ["次回", "未設定"]
};

function warningKind(item) {
  if (WARNING_KINDS[item.code]) return WARNING_KINDS[item.code];
  if (String(item.code || "").startsWith("optical")) return ["眼鏡・CL", "値の確認"];
  return ["カルテ", "確認"];
}

// 警告一覧（デジカルの保存時の警告一覧）。止めるのは記録として成り立たない行（blockers）だけで、確認事項（warnings）は
// 見たうえでそのまま進める。検査値の確認と引き継ぎ処方の確認は、進むときにまとめて済ませる。
export function WarningsDialog({ content, readiness, version, error = "", proceedLabel, onProceed, onCancel, onFix = null }) {
  const [busy, setBusy] = useState(false);
  const blockers = readiness.blockers;
  const warnings = readiness.warnings;
  const exam = content.exam;
  const issued = content.prescriptions.filter((item) => item.name && item.kind !== "comment");
  const planned = (content.orders || []).filter((order) => order.kind !== "comment" && order.status === "planned").length;
  const confirmsInDialog = warnings.some((item) => RESOLVED_IN_DIALOG.has(item.code));
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="warnings-heading" className="dialog dialog-wide warnings-dialog" role="dialog">
        <h2 id="warnings-heading">{blockers.length || warnings.length ? "警告一覧" : "カルテを確定します"}（v{version}）</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {blockers.length || warnings.length ? (
          <>
            <p className="small">{blockers.length ? "記録として成り立たない行があります。直してから進んでください。" : "確認が必要な項目があります。確認したうえでそのまま進めます。"}</p>
            <div className="table-scroll">
              <table className="data-table warnings-table">
                <thead><tr><th scope="col">対象</th><th scope="col">種類</th><th scope="col">メッセージ</th><th aria-label="操作" scope="col" /></tr></thead>
                <tbody>
                  {[...blockers.map((item) => ({ ...item, blocker: true })), ...warnings].map((item, index) => {
                    const [target, kind] = warningKind(item);
                    return (
                      <tr className={item.blocker ? "is-blocker" : item.level === "high" ? "is-high" : "is-low"} key={`${item.code}-${index}`}>
                        <td>{target}</td>
                        <td><span className={`warn-level${item.blocker ? " is-blocker" : item.level === "high" ? " is-high" : ""}`}>{item.blocker ? "要修正" : item.level === "high" ? "確認" : "注意"}</span> {kind}</td>
                        <td>{item.message}</td>
                        <td>{onFix && item.code === "order_planned" && item.field ? <button className="btn btn-chip" onClick={() => onFix(item)} type="button">実施にする</button> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {onFix && planned > 1 ? <button className="btn btn-chip" onClick={() => onFix({ code: "order_planned_all" })} type="button">予定の {planned} 件をすべて実施済にする</button> : null}
          </>
        ) : null}
        <table className="data-table finalize-summary">
          <tbody>
            <tr>
              <th scope="row">視力</th>
              <td><span className="eye-od">R</span> {exam.od.vaUncorrected || "—"}（{exam.od.vaCorrected || "—"}）　<span className="eye-os">L</span> {exam.os.vaUncorrected || "—"}（{exam.os.vaCorrected || "—"}）</td>
            </tr>
            <tr>
              <th scope="row">眼圧</th>
              <td><span className="eye-od">R</span> {exam.od.iop ?? "—"}　<span className="eye-os">L</span> {exam.os.iop ?? "—"} mmHg</td>
            </tr>
            <tr>
              <th scope="row">処方</th>
              <td>
                {issued.length === 0 ? "なし" : (
                  <ul className="plain">
                    {issued.map((item, index) => <li key={index}>{prescriptionText(item)}{item.carriedOver ? <span className="tag tag-warn">前回から引き継ぎ</span> : null}</li>)}
                  </ul>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        {confirmsInDialog && !blockers.length ? (
          <p className="muted small">進むと、値のある眼の検査値を確認済みにし、引き継いだ処方を今回の処方として確定します。</p>
        ) : null}
        <p className="muted small">確定後も直せます。直して確定するたびに新しい版になり、前の版も残ります。</p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">戻って編集</button>
          <button
            autoFocus
            className="btn btn-primary"
            disabled={busy || blockers.length > 0}
            onClick={async () => { setBusy(true); await onProceed(); setBusy(false); }}
            type="button"
          >
            {proceedLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// 患者ステータス選択（デジカルの［→］のあと）。左に今の状態、右に次の状態（既定は会計待）。
export function StatusChoiceDialog({ appointment, statusMenu, labels, loading, error = "", onConfirm, onFinalizeOnly, onCancel }) {
  const [status, setStatus] = useState("checkout");
  const [busy, setBusy] = useState(false);
  const run = async (action) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="status-heading" className="dialog status-dialog" role="dialog">
        <h2 id="status-heading">患者ステータス選択</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {loading ? <p className="loading">受付を確認しています…</p> : (
          <div className="status-choice">
            <div className="status-current">
              <span className="muted small">現在のステータス</span>
              <strong>{appointment ? labels[appointment.displayStatus || appointment.status] || appointment.status : "受付なし"}</strong>
              {!appointment ? <span className="muted small">本日の受付が見つからないため、受付の状態は変えずに確定します。</span> : null}
            </div>
            {appointment ? (
              <fieldset className="status-next plain-fieldset">
                <legend className="muted small">次のステータス</legend>
                {statusMenu.map((value) => (
                  <label className="check-line" key={value}>
                    <input checked={status === value} name="next-status" onChange={() => setStatus(value)} type="radio" value={value} />
                    {labels[value]}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        )}
        <div className="dialog-actions">
          {appointment ? <button className="btn btn-ghost dialog-action-left" disabled={busy || loading} onClick={() => run(onFinalizeOnly)} type="button">確定のみ（受付は変えない）</button> : null}
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button autoFocus className="btn btn-primary" disabled={busy || loading} onClick={() => run(() => (appointment ? onConfirm(status) : onFinalizeOnly()))} type="button">決定</button>
        </div>
      </div>
    </div>
  );
}

// 次へのあと、診察待ちの人がいなかったとき・受付を動かせなかったときの知らせ。
export function CloseResultDialog({ result, onStay, onReception, onNext }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="close-result-heading" className="dialog" role="dialog">
        <h2 id="close-result-heading">確定しました{result.version ? `（v${result.version.version}）` : ""}</h2>
        {result.appointmentMoved ? <p>受付を「{result.statusLabel}」にしました。</p> : null}
        {result.appointmentError ? <p className="alert alert-warn">{result.appointmentError.message || "受付の状態は変えていません。"}</p> : null}
        {result.warnings?.length ? <p className="muted small">確認事項 {result.warnings.length}件のまま確定しました。</p> : null}
        {result.nextPatient ? <p>次の診察待ち: <strong>{result.nextPatient.patientName}</strong>{result.nextPatient.queueNumber ? `（#${result.nextPatient.queueNumber}）` : ""}</p> : <p className="muted">診察待ちの患者はいません。</p>}
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onStay} type="button">このカルテに戻る</button>
          <button className="btn btn-ghost" onClick={onReception} type="button">受付一覧へ</button>
          {result.nextPatient ? <button autoFocus className="btn btn-primary" onClick={onNext} type="button">次の患者を開く</button> : null}
        </div>
      </div>
    </div>
  );
}

// 会計送信の確認（トプコンの医事データ送信確認）。確定済みのカルテだけ送れる。
export function SendDialog({ patient, encounterDate, error = "", onSend, onCancel }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="send-heading" className="dialog" role="dialog">
        <h2 id="send-heading">会計へ送信</h2>
        <p>下記のカルテの会計データを連携します。</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <dl className="info-list">
          <dt>患者番号</dt><dd>{patient.primaryPatientNumber || "—"}</dd>
          <dt>氏名</dt><dd>{patient.displayName}</dd>
          <dt>診療日</dt><dd>{encounterDate}</dd>
        </dl>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button autoFocus className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); await onSend(); setBusy(false); }} type="button">送信</button>
        </div>
      </div>
    </div>
  );
}

// ショートカット一覧（デジカルの 4 列。入力欄にカーソルがあるときは 1 文字のキーは効かない）。
export function ShortcutHelpDialog({ leftTabs, categories, onClose }) {
  const common = [["S", "保存"], ["Q", "次へ（確定 → 受付の状態 → 次の患者）"], ["K", "会計へ送信"], ["A", "ファイルを追加"], ["B", "病名を追加"], ["E", "検査タブ"], ["F", "患者検索"], ["L", "患者リスト（診察）"], ["U", "受付画面へ"], ["?", "この一覧"], ["⌘/Ctrl+S", "保存（入力中も）"], ["⌘/Ctrl+Enter", "次へ（入力中も）"], ["Esc", "引き出し・ダイアログを閉じる"]];
  return (
    <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <div aria-labelledby="shortcut-heading" className="dialog dialog-wide shortcut-dialog" role="dialog">
        <h2 id="shortcut-heading">ショートカット</h2>
        <div className="shortcut-cols">
          <section>
            <h3>よく使う操作</h3>
            <dl className="shortcut-list">{common.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
          </section>
          <section>
            <h3>左のタブ</h3>
            <dl className="shortcut-list">{leftTabs.map((tab) => <div key={tab.id}><dt><kbd>{tab.keyLabel}</kbd></dt><dd>{tab.label}</dd></div>)}</dl>
          </section>
          <section>
            <h3>右のオーダー</h3>
            <dl className="shortcut-list">{categories.map((item) => <div key={item.id}><dt><kbd>{item.key}</kbd></dt><dd>{item.label}</dd></div>)}</dl>
          </section>
        </div>
        <p className="muted small">文字のキーは、入力欄にカーソルが無いときに効きます。</p>
        <div className="dialog-actions">
          <button autoFocus className="btn btn-primary" onClick={onClose} type="button">閉じる</button>
        </div>
      </div>
    </div>
  );
}

const SET_PART_LABELS = { prescriptions: "処方", orders: "検査・処置", diagnoses: "病名", findingsText: "主訴・所見", plan: "方針" };

// 「現在のカルテからセット」: 名前・フォルダ（その場で追加もできる）・写す項目・上書きするセット。
export function SetCreateDialog({ api, encounterId, orderSets, setFolders: initialFolders, beforeSave, onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState("");
  const [overwrite, setOverwrite] = useState("");
  const [include, setInclude] = useState(() => Object.fromEntries(Object.keys(SET_PART_LABELS).map((key) => [key, true])));
  const [newFolder, setNewFolder] = useState(null);
  const [folders, setFolders] = useState(initialFolders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addFolder() {
    if (!newFolder?.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/set-folders", { method: "POST", body: { name: newFolder.name.trim(), parentId: newFolder.parentId || "" } });
      setFolders((current) => [...current, payload.setFolder]);
      setFolderId(payload.setFolder.folderId);
      setNewFolder(null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!(await beforeSave())) throw new Error("カルテを保存できませんでした。");
      const body = { encounterId, include, ...(overwrite ? { setId: overwrite } : { name: name.trim(), folderId }) };
      if (overwrite && name.trim()) body.name = name.trim();
      const payload = await api("/v1/eye/order-sets/from-encounter", { method: "POST", body });
      onCreated(payload.orderSet, folders);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="set-create-heading" className="dialog dialog-wide" onSubmit={submit} role="dialog">
        <h2 id="set-create-heading">セット登録（現在のカルテから）</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <label className="field">
          <span>上書きするセット</span>
          <select aria-label="上書きするセット" className="input" onChange={(event) => setOverwrite(event.target.value)} value={overwrite}>
            <option value="">新しいセットを作る</option>
            {orderSets.filter((item) => item.active !== false).map((item) => <option key={item.setId} value={item.setId}>{item.name}（現在のカルテで上書き）</option>)}
          </select>
        </label>
        <label className="field">
          <span>セット名{overwrite ? "（空なら今の名前のまま）" : ""}</span>
          <input aria-label="セット名" autoFocus className="input" maxLength={200} onChange={(event) => setName(event.target.value)} required={!overwrite} value={name} />
        </label>
        {!overwrite ? (
          <div className="field">
            <span>フォルダ</span>
            <div className="row-line">
              <select aria-label="フォルダ" className="input grow" onChange={(event) => setFolderId(event.target.value)} value={folderId}>
                <option value="">（フォルダなし）</option>
                {folders.filter((item) => item.active !== false).map((item) => <option key={item.folderId} value={item.folderId}>{item.name}</option>)}
              </select>
              <button className="btn btn-chip" onClick={() => setNewFolder(newFolder ? null : { name: "", parentId: "" })} type="button">＋ フォルダ</button>
            </div>
            {newFolder ? (
              <div className="row-line">
                <input aria-label="新しいフォルダ名" className="input grow" maxLength={200} onChange={(event) => setNewFolder({ ...newFolder, name: event.target.value })} placeholder="フォルダ名" value={newFolder.name} />
                <select aria-label="親フォルダ" className="input" onChange={(event) => setNewFolder({ ...newFolder, parentId: event.target.value })} value={newFolder.parentId}>
                  <option value="">親フォルダなし</option>
                  {folders.map((item) => <option key={item.folderId} value={item.folderId}>{item.name}</option>)}
                </select>
                <button className="btn btn-ghost" disabled={busy || !newFolder.name.trim()} onClick={addFolder} type="button">追加</button>
              </div>
            ) : null}
          </div>
        ) : null}
        <fieldset className="field plain-fieldset">
          <legend className="field-legend">セットに入れる項目</legend>
          <div className="chip-toggles">
            {Object.entries(SET_PART_LABELS).map(([key, label]) => (
              <label className="check-line" key={key}><input checked={include[key]} onChange={(event) => setInclude({ ...include, [key]: event.target.checked })} type="checkbox" />{label}</label>
            ))}
          </div>
        </fieldset>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy} type="submit">保存</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, danger = false }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="confirm-heading" className="dialog" role="dialog">
        <h2 id="confirm-heading">{title}</h2>
        {children}
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }} type="button">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// 修正理由は任意。空なら「修正」として版に残す。
export function AmendDialog({ onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog confirmLabel="修正を始める" onCancel={onCancel} onConfirm={() => onConfirm(reason.trim())} title="確定済みのカルテを修正">
      <p>修正内容は新しい版として保存され、元の版も残ります。</p>
      <label className="field">
        <span>修正理由（任意）</span>
        <textarea autoFocus className="input" onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
      </label>
    </ConfirmDialog>
  );
}

