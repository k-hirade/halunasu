"use client";

import { UnapprovedTag } from "./chart-approval";
import { isUnapproved } from "../lib/approval";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NEXT_VISIT_PLAN_PRESETS } from "@halunasu/eye-contracts";
import { WarnIcon } from "./chart-icons";
import { useEyeApi } from "./eye-api";
import { formatDate, prescriptionText } from "../lib/format";

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
  next_visit_missing: ["次回", "未設定"],
  allergy_unconfirmed: ["アレルギー", "未確認"],
  exam_order_missing: ["検査・処置", "オーダーなし"]
};

function warningKind(item) {
  if (WARNING_KINDS[item.code]) return WARNING_KINDS[item.code];
  if (String(item.code || "").startsWith("optical")) return ["眼鏡・CL", "値の確認"];
  return ["カルテ", "確認"];
}

// 警告の 1 行を見分けるキー（「今回は確認しない」にした行を覚えるため）。
export function warningKey(item) {
  return `${item.code}|${item.field || ""}|${item.message || ""}`;
}

const LEVEL_LABELS = { blocker: "要修正", high: "確認", low: "注意" };

// 警告一覧（デジカルの保存時の警告一覧）。止めるのは記録として成り立たない行（blockers）だけで、確認事項（warnings）は
// 見たうえでそのまま進める。行ごとの［今回は確認しない］で、その確認事項を今回は出さない（確定の記録には警告として残る）。
// 検査値の確認と引き継ぎ処方の確認は、［今回は確認しない］にしなければ進むときにまとめて済ませる。
// 警告が 1 件も無いときはこのダイアログを出さずに受付の状態へ進む（encounter-editor.js の startNext）。
export function WarningsDialog({ content, readiness, version, error = "", proceedLabel, onProceed, onCancel, onFix = null, dismissed = null, onDismiss = null, onRestore = null }) {
  const [busy, setBusy] = useState(false);
  const blockers = readiness.blockers;
  const allWarnings = readiness.warnings;
  const warnings = dismissed ? allWarnings.filter((item) => !dismissed.has(warningKey(item))) : allWarnings;
  const hiddenCount = allWarnings.length - warnings.length;
  const exam = content.exam;
  const issued = content.prescriptions.filter((item) => item.name && item.kind !== "comment");
  const planned = (content.orders || []).filter((order) => order.kind !== "comment" && order.status === "planned").length;
  const confirmsInDialog = warnings.some((item) => RESOLVED_IN_DIALOG.has(item.code));
  // 進むボタンに最初のフォーカスを置くが、autoFocus だとダイアログが一番下までスクロールして見出しと表の先頭が隠れるため、
  // スクロールさせずにフォーカスし、ダイアログは先頭から見せる（ボタンは下端に固定されているので見える）
  const dialogRef = useRef(null);
  const proceedRef = useRef(null);
  useEffect(() => {
    proceedRef.current?.focus({ preventScroll: true });
    if (dialogRef.current) dialogRef.current.scrollTop = 0;
  }, []);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="warnings-heading" className="dialog dialog-wide warnings-dialog" ref={dialogRef} role="dialog">
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
                    const level = item.blocker ? "blocker" : item.level === "high" ? "high" : "low";
                    return (
                      <tr className={`is-${level === "blocker" ? "blocker" : level}`} key={`${item.code}-${index}`}>
                        <td className="warn-target">{target}</td>
                        <td className="warn-kind">
                          <span className="warn-kind-line">
                            <span className={`warn-icon is-${level}`} title={LEVEL_LABELS[level]}><WarnIcon level={level} /></span>
                            <span className={`warn-level is-${level}`}>{LEVEL_LABELS[level]}</span>
                            <span>{kind}</span>
                          </span>
                        </td>
                        <td className="warn-message">{item.message}</td>
                        <td className="warn-fix">
                          <span className="warn-actions">
                            {onFix && item.code === "order_planned" && item.field ? <button className="btn btn-chip" onClick={() => onFix(item)} type="button">実施にする</button> : null}
                            {!item.blocker && onDismiss ? (
                              <button aria-label={`「${item.message}」を今回は確認しない`} className="btn btn-chip warn-dismiss" onClick={() => onDismiss(warningKey(item))} title="今回はこの確認を出さない（確定の記録には残ります）" type="button">今回は確認しない</button>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {onFix && planned > 1 ? <button className="btn btn-chip" onClick={() => onFix({ code: "order_planned_all" })} type="button">予定の {planned} 件をすべて実施済にする</button> : null}
          </>
        ) : null}
        {hiddenCount ? (
          <p className="muted small warnings-hidden">
            今回は確認しない項目 {hiddenCount}件（確定の記録には警告として残ります）
            {onRestore ? <button className="link-button" onClick={onRestore} type="button">元に戻す</button> : null}
          </p>
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
            className="btn btn-primary"
            disabled={busy || blockers.length > 0}
            onClick={async () => { setBusy(true); await onProceed(); setBusy(false); }}
            ref={proceedRef}
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

const SEND_STATE_NOTES = {
  handed_off: "この版はもう会計へ送っています。もう一度送ると同じ内容の CSV を作ります。",
  changed: "前回送ったあとで内容が変わっています。送ると再連携になります。レセコン側で前回分を取り消してから取り込んでください。"
};

// 会計送信の確認（デジカルの［¥］→「レセコンへ会計情報を送信しますか？」）。会計連携の一覧と同じ中身（品目）を出して送る。
// 確定済みのカルテだけ送れる。送ると CSV を保存し、受付が会計待なら会計済にする（/billing/send）。
export function SendDialog({ patient, encounterId, encounterDate, error = "", onSend, onCancel }) {
  const api = useEyeApi();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState({ loading: true, item: null, error: "" });
  useEffect(() => {
    let alive = true;
    api(`/v1/eye/billing/day?date=${encodeURIComponent(encounterDate)}`)
      .then((payload) => { if (alive) setState({ loading: false, item: (payload.encounters || []).find((entry) => entry.encounterId === encounterId) || null, error: "" }); })
      .catch((nextError) => { if (alive) setState({ loading: false, item: null, error: nextError.message }); });
    return () => { alive = false; };
  }, [api, encounterDate, encounterId]);
  const item = state.item;
  const groups = item ? Object.entries(item.items.reduce((acc, row) => ({ ...acc, [row.category]: [...(acc[row.category] || []), row] }), {})) : [];
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="send-heading" className="dialog send-dialog" role="dialog">
        <h2 id="send-heading">会計情報をレセコンへ送りますか？</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <p className="send-who">
          <strong>{patient.displayName}</strong>
          <span className="mono">{patient.primaryPatientNumber || "—"}</span>
          <span>{formatDate(encounterDate)}</span>
          {item ? <span className="muted">カルテ v{item.version}</span> : null}
          {item ? <UnapprovedTag approval={item.approval} /> : null}
        </p>
        {item && isUnapproved(item.approval) ? <p className="alert alert-warn small" data-approval-note="send">このカルテは指導医の承認がまだです（{item.approval.status === "returned" ? "差し戻し中" : "承認待ち"}）。会計へは送れます。承認後に内容が変わったときは、もう一度送ってください。</p> : null}
        {state.loading ? <p className="loading">送る内容を確認しています…</p> : null}
        {state.error ? <p className="alert alert-warn">送る内容を読めませんでした（{state.error}）。送信はできます。</p> : null}
        {!state.loading && !state.error && !item ? <p className="alert alert-warn">この日の確定済みのカルテが見つかりません。確定してから送ってください。</p> : null}
        {item ? (
          <div aria-label="送る内容" className="send-items" role="table">
            {groups.length ? groups.map(([category, rows]) => (
              <div className="send-group" key={category} role="row">
                <span className="send-category" role="rowheader">{category}</span>
                <ul className="send-rows" role="cell">
                  {rows.map((row, index) => (
                    <li key={`${row.code}-${index}`}>
                      <span className="send-name">{row.name}</span>
                      {row.eye ? <span className="tag">{{ od: "右", os: "左", ou: "両" }[row.eye] || row.eye}</span> : null}
                      <span className="muted small">{[row.quantity ? `${row.quantity}${row.unit || ""}` : "", row.route, row.usage, row.days ? `${row.days}日` : ""].filter(Boolean).join(" ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )) : <p className="muted small">品目はありません（受診のみ）。</p>}
          </div>
        ) : null}
        {item && SEND_STATE_NOTES[item.handoff?.state] ? <p className="alert alert-warn small">{SEND_STATE_NOTES[item.handoff.state]}</p> : null}
        <p className="muted small">レセコンが取り込む CSV を保存します。受付が「会計待」なら「会計済」にします。</p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
          <button autoFocus className="btn btn-primary" disabled={busy || state.loading || (!item && !state.error)} onClick={async () => { setBusy(true); await onSend(); setBusy(false); }} type="button">{busy ? "送信中…" : "送信"}</button>
        </div>
      </div>
    </div>
  );
}

// ショートカット一覧（デジカルの 4 列。1 行に「操作 … キー」。入力欄にカーソルがあるときは 1 文字のキーは効かない）。
export function ShortcutHelpDialog({ leftTabs, categories, onClose }) {
  const common = [["S", "保存"], ["Q", "次へ（確定 → 受付の状態 → 次の患者）"], ["K", "会計へ送信"], ["R", "検査依頼"], ["A", "ファイルを追加"], ["B", "病名を追加"], ["E", "検査結果タブ"], ["F", "患者検索"], ["L", "患者リスト"], ["U", "受付画面へ"], ["?", "この一覧"], ["⌘/Ctrl+S", "保存（入力中も）"], ["⌘/Ctrl+Enter", "次へ（入力中も）"], ["Esc", "引き出しを閉じる"]];
  const half = Math.ceil(common.length / 2);
  const list = (items) => (
    <dl className="shortcut-list">{items.map(([key, label]) => <div key={key}><dd>{label}</dd><dt><kbd>{key}</kbd></dt></div>)}</dl>
  );
  return (
    <div className="dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <div aria-labelledby="shortcut-heading" className="dialog dialog-wide shortcut-dialog" role="dialog">
        <h2 id="shortcut-heading">ショートカット</h2>
        <div className="shortcut-cols">
          <section className="shortcut-common">
            <h3>よく使う操作</h3>
            <div className="shortcut-common-cols">
              {list(common.slice(0, half))}
              {list(common.slice(half))}
            </div>
          </section>
          <section>
            <h3>左のタブ</h3>
            {list(leftTabs.map((tab) => [tab.keyLabel, tab.label]))}
          </section>
          <section>
            <h3>右のオーダー</h3>
            {list(categories.map((item) => [item.key, item.label]))}
          </section>
        </div>
        <div className="dialog-actions shortcut-foot">
          <p className="muted small">文字のキーは、入力欄にカーソルが無いときに効きます。</p>
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

const EXAM_EYES = [["od", "右眼"], ["os", "左眼"], ["ou", "両眼"]];

// 検査依頼（デジカルの［検査依頼］）: 診察の途中で、検査をしてほしい項目を選んで検査室へ回す。
// 選んだ項目は今日のカルテの検査・処置に「予定」として入り（受付一覧・検査室の予定に出る）、受付は「検査中」になる。
export function ExamRequestDialog({ catalog, plannedCodes, appointment, appointmentLoading, statusLabel, error = "", onSubmit, onCancel }) {
  const exams = catalog.filter((item) => item.kind === "exam" || item.code === "dilation");
  const [picked, setPicked] = useState(() => new Set());
  const [eye, setEye] = useState("ou");
  const [busy, setBusy] = useState(false);
  const toggle = (code) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const addPreset = (codes) => setPicked((current) => new Set([...current, ...codes.filter((code) => exams.some((item) => item.code === code))]));
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="exam-request-heading" className="dialog dialog-wide exam-request-dialog" role="dialog">
        <h2 id="exam-request-heading">検査依頼</h2>
        <p className="small">検査してほしい項目を選びます。今日のカルテに「予定」として入り、受付を「{statusLabel}」にします。</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <div aria-label="よく使う組み合わせ" className="exam-request-presets" role="group">
          {NEXT_VISIT_PLAN_PRESETS.filter((preset) => preset.codes.length).map((preset) => (
            <button className="btn btn-chip" key={preset.presetId} onClick={() => addPreset(preset.codes)} type="button">＋{preset.label}</button>
          ))}
        </div>
        <fieldset className="plain-fieldset exam-request-items">
          <legend className="field-legend">検査項目</legend>
          {exams.map((item) => {
            const already = plannedCodes.has(item.code);
            return (
              <label className={`exam-request-item${picked.has(item.code) ? " is-picked" : ""}`} key={item.code}>
                <input checked={picked.has(item.code)} disabled={already} onChange={() => toggle(item.code)} type="checkbox" />
                <span>{item.name}</span>
                {already ? <span className="tag">予定済</span> : null}
              </label>
            );
          })}
        </fieldset>
        <div className="exam-request-eye">
          <span className="field-legend">眼</span>
          <span className="segmented" role="group" aria-label="検査する眼">
            {EXAM_EYES.map(([value, label]) => <button aria-pressed={eye === value} key={value} onClick={() => setEye(value)} type="button">{label}</button>)}
          </span>
        </div>
        <p className="muted small">
          {appointmentLoading ? "受付を確認しています…" : appointment ? `受付: 現在「${appointment.label}」→「${statusLabel}」` : "本日の受付が見つからないため、受付の状態は変えずに予定だけ入れます。"}
        </p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button
            className="btn btn-primary"
            disabled={busy || !picked.size || appointmentLoading}
            onClick={async () => {
              setBusy(true);
              await onSubmit({ items: exams.filter((item) => picked.has(item.code)), eye });
              setBusy(false);
            }}
            type="button"
          >
            {picked.size ? `${picked.size}件を依頼` : "依頼する"}
          </button>
        </div>
      </div>
    </div>
  );
}

export const REGULAR_REPEAT_CHOICES = [["next", "次回", "次の受診で 1 回だけ出す"], ["every", "毎回", "カルテを開くたびに出す"], ["months", "か月ごと", "登録（または前回入れた）月から数えて"]];

// 定期の登録・編集（デジカルの「定期登録」）。今のカルテの処方・検査処置を、この患者の定期として残す。
export function RegularOrderDialog({ mode = "create", initial = {}, summary = [], error = "", onSubmit, onDelete = null, onCancel }) {
  const [name, setName] = useState(initial.name || "");
  const [repeat, setRepeat] = useState(initial.repeat || "next");
  const [months, setMonths] = useState(initial.repeatMonths || 3);
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    await onSubmit({ name: name.trim(), repeat, ...(repeat === "months" ? { repeatMonths: Number(months) } : {}) });
    setBusy(false);
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="regular-heading" className="dialog regular-dialog" onSubmit={submit} role="dialog">
        <h2 id="regular-heading">{mode === "create" ? "定期登録" : "定期の編集"}</h2>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        {mode === "create" ? <p className="small">今のカルテの処方・検査処置を、この患者の定期にします。右の「定期」から次のカルテへ入れられます。</p> : null}
        <label className="field">
          <span>定期の名前</span>
          <input autoFocus className="input" maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="例: 緑内障 点眼・眼圧" required value={name} />
        </label>
        <fieldset className="field plain-fieldset">
          <legend className="field-legend">繰り返し</legend>
          <div className="regular-repeat">
            {REGULAR_REPEAT_CHOICES.map(([value, label, hint]) => (
              <label className="check-line" key={value}>
                <input checked={repeat === value} name="regular-repeat" onChange={() => setRepeat(value)} type="radio" value={value} />
                {value === "months" ? (
                  <span className="regular-months">
                    <select aria-label="何か月ごと" className="input input-short" disabled={repeat !== "months"} onChange={(event) => setMonths(event.target.value)} value={months}>
                      {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                    {label}
                  </span>
                ) : label}
                <span className="muted small">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {summary.length ? (
          <div className="regular-summary">
            <span className="field-legend">入る内容</span>
            <ul className="plain small">{summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
          </div>
        ) : null}
        <div className="dialog-actions">
          {onDelete ? <button className="btn btn-ghost danger-text dialog-action-left" disabled={busy} onClick={async () => { setBusy(true); await onDelete(); setBusy(false); }} type="button">この定期を削除</button> : null}
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} type="submit">{mode === "create" ? "登録" : "更新"}</button>
        </div>
      </form>
    </div>
  );
}

// コメントの候補（自前の短い定型）。処方は処方箋・レセプトの摘要、検査処置はレセプトの摘要に載る。
const RX_COMMENT_SUGGESTIONS = ["後発品へ変更不可", "一包化", "粉砕", "先発品を希望", "残薬調整のため日数を変更", "点眼の間隔は5分以上あける", "冷所保存", "前回と同じ"];
const ORDER_COMMENT_SUGGESTIONS = ["両眼実施", "右眼のみ実施", "左眼のみ実施", "散瞳下で実施", "前回と同じ条件", "再検査"];

// コメント追加（デジカルの処方のコメント追加: 記載先の選択 → キーワードで探す → 押して入れる）。
export function RpCommentDialog({ kind = "rx", onAdd, onCancel }) {
  const [scope, setScope] = useState("free");
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  const q = query.trim();
  const suggestions = (kind === "rx" ? RX_COMMENT_SUGGESTIONS : ORDER_COMMENT_SUGGESTIONS).filter((text) => !q || text.includes(q));
  const freeLabel = kind === "rx" ? "処方箋・レセプトに載せる" : "レセプトに載せる";
  // Rp の中から開くので body へ描き、押した操作が Rp の選択（束を押すと選択）へ伝わらないようにする
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onCancel(); }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") onCancel(); }}
      role="presentation"
    >
      <div aria-labelledby="rp-comment-heading" className="dialog rp-comment-dialog" role="dialog">
        <div className="rp-comment-head">
          <h2 id="rp-comment-heading">コメント追加</h2>
          <button aria-label="閉じる" className="btn btn-chip" onClick={onCancel} type="button">×</button>
        </div>
        <fieldset className="plain-fieldset rp-comment-scope-pick">
          <legend className="field-legend">記載先</legend>
          <label className="check-line"><input checked={scope === "free"} name="rp-comment-scope" onChange={() => setScope("free")} type="radio" />{freeLabel}</label>
          <label className="check-line"><input checked={scope === "chart"} name="rp-comment-scope" onChange={() => setScope("chart")} type="radio" />カルテのみ</label>
        </fieldset>
        <input
          aria-label="コメントを探す"
          className="input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            onAdd({ text: q, scope });
          }}
          placeholder="キーワード（Enter でこの文のまま入れる）"
          ref={inputRef}
          type="search"
          value={query}
        />
        <ul className="rp-comment-list">
          <li><button className="rp-comment-choice is-free" onClick={() => onAdd({ text: q, scope })} type="button">{q ? `「${q}」をそのまま入れる` : "自由に書く（空のコメント行を入れる）"}</button></li>
          {suggestions.map((text) => (
            <li key={text}><button className="rp-comment-choice" onClick={() => onAdd({ text, scope })} type="button">{text}</button></li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  );
}

