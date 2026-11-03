"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, SaveIndicator } from "./encounter-dialogs";
import { DocumentInsertPanel } from "./document-insert-panel";
import { useEyeApi } from "./eye-api";
import { LetterSheet } from "./letter-sheet";
import { usePrintNames } from "./use-print-names";
import { ageOn, formatDate, formatDateTime, SEX_LABELS } from "../lib/format";
import { letterChecks, parseLetter, readPurpose, writePurpose } from "../lib/letter";
import { DEFAULT_HONORIFIC, HONORIFIC_OPTIONS } from "../lib/paper";

export { DocumentPrint } from "./document-print";

const AUTOSAVE_MS = 1500;
const A4_WIDTH_PX = 793.7;
const PURPOSE_PHRASES = [
  ["手術依頼", "手術のご検討をお願いいたします。"],
  ["精査依頼", "精査のほどお願いいたします。"],
  ["加療依頼", "ご加療のほどお願いいたします。"],
  ["経過観察", "今後の経過観察をお願いいたします。"],
  ["ご意見", "ご意見を賜りたく存じます。"]
];
const STATUS_LABELS = { draft: "下書き", finalized: "確定", discarded: "破棄済み" };

// 文書の編集。左に入力、右に印刷と同じ紙面のプレビュー。下書きは自動保存し、医師が確定すると変更できない（修正は複製して行う）。
export function DocumentEditor({ documentId }) {
  const api = useEyeApi();
  const router = useRouter();
  const printNames = usePrintNames();
  const [document, setDocument] = useState(null);
  const [context, setContext] = useState(null);
  const [form, setForm] = useState(null);
  const [saveState, setSaveState] = useState("saved");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState("");
  const [pane, setPane] = useState("input");
  const [inserting, setInserting] = useState(false);
  const [chart, setChart] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [purposeDraft, setPurposeDraft] = useState(null);
  const [notice, setNotice] = useState("");
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(null);
  const formRef = useRef(null);
  const editableRef = useRef(false);
  const cursorRef = useRef(null);
  const bodyRef = useRef(null);
  const purposeRef = useRef(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let active = true;
    Promise.all([apiRef.current(`/v1/eye/documents/${documentId}`), apiRef.current("/v1/eye/context")])
      .then(([payload, contextPayload]) => {
        // 読み込みが遅れて返ってきても、入力を始めた内容を上書きしない
        if (!active || dirtyRef.current || savingRef.current) return;
        setDocument(payload.document);
        const nextForm = formFrom(payload.document);
        formRef.current = nextForm;
        setForm(nextForm);
        setContext(contextPayload.context);
        revisionRef.current = payload.document.revision;
      })
      .catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [documentId]);

  const editable = Boolean(document && document.status === "draft" && context?.canWriteDocuments);
  editableRef.current = editable;
  const patientId = document?.patientId;

  // 下書きのときだけ: 差し込み元より新しいカルテがあるかの確認と、宛先の候補（この患者の過去の文書・院内の紹介先）。
  useEffect(() => {
    if (!editable || !patientId) return undefined;
    let active = true;
    apiRef.current(`/v1/eye/patients/${patientId}/chart`).then((payload) => active && setChart(payload.encounters || [])).catch(() => active && setChart([]));
    Promise.all([
      apiRef.current(`/v1/eye/patients/${patientId}/documents`).then((payload) => payload.documents || []).catch(() => []),
      apiRef.current("/v1/eye/documents/recipients").then((payload) => payload.recipients || []).catch(() => [])
    ]).then(([documents, recipients]) => {
      if (!active) return;
      setSuggestions(mergeRecipients(documents.filter((item) => item.documentId !== documentId), recipients));
    });
    return () => { active = false; };
  }, [editable, patientId, documentId]);

  async function saveOnce() {
    while (savingRef.current) await savingRef.current;
    if (!editableRef.current || !dirtyRef.current) return true;
    const run = (async () => {
      dirtyRef.current = false;
      setSaveState("saving");
      try {
        const payload = await apiRef.current(`/v1/eye/documents/${documentId}`, {
          method: "PATCH",
          body: { expectedRevision: revisionRef.current, ...formRef.current }
        });
        revisionRef.current = payload.document.revision;
        setDocument(payload.document);
        setSaveState(dirtyRef.current ? "dirty" : "saved");
        return true;
      } catch (nextError) {
        dirtyRef.current = true;
        setSaveState("error");
        setError(nextError.message);
        return false;
      }
    })();
    savingRef.current = run;
    try {
      return await run;
    } finally {
      if (savingRef.current === run) savingRef.current = null;
    }
  }

  // 保存し終えるまで待つ（保存中に打った分も含める）。印刷・確定の前に使う。
  async function flush() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!(await saveOnce())) return false;
      if (!dirtyRef.current && !savingRef.current) return true;
    }
    return !dirtyRef.current;
  }

  const saveRef = useRef(saveOnce);
  saveRef.current = saveOnce;

  useEffect(() => {
    if (saveState !== "dirty") return undefined;
    const handle = setTimeout(() => { saveRef.current(); }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
  }, [saveState, form]);

  // 画面内リンクで別のページへ移るときは待たずに保存する。タブを閉じる・再読み込みは確認を出す。
  useEffect(() => () => {
    if (dirtyRef.current) saveRef.current();
  }, []);
  useEffect(() => {
    function onBeforeUnload(event) {
      if (!dirtyRef.current && !savingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && !event.isComposing && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function change(patch) {
    const next = { ...formRef.current, ...patch };
    formRef.current = next;
    setForm(next);
    dirtyRef.current = true;
    setSaveState("dirty");
  }

  function changeRecipient(patch) {
    change({ recipient: { ...formRef.current.recipient, ...patch } });
  }

  function rememberCursor() {
    const element = bodyRef.current;
    if (element) cursorRef.current = element.selectionStart;
  }

  // カーソル位置（最後に本文を触った位置。なければ末尾）に行として差し込む。既にある文は消さない。
  function insertAtCursor(text) {
    const body = formRef.current.body;
    const position = Math.min(cursorRef.current ?? body.length, body.length);
    const before = body.slice(0, position);
    const after = body.slice(position);
    const prefix = before && !before.endsWith("\n") ? "\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n" : "";
    change({ body: `${before}${prefix}${text}${suffix}${after}` });
    const nextCursor = before.length + prefix.length + text.length;
    cursorRef.current = nextCursor;
    setInserting(false);
    setNotice("カルテの内容を本文に挿入しました。");
    requestAnimationFrame(() => {
      const element = bodyRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(nextCursor, nextCursor);
      scrollToLine(element, `${before}${prefix}`.split("\n").length - 1);
    });
  }

  function jumpToSection(section) {
    const element = bodyRef.current;
    if (!element) return;
    const lines = formRef.current.body.split("\n");
    const offset = lines.slice(0, section.line + 1).join("\n").length + 1;
    const position = Math.min(offset, formRef.current.body.length);
    element.focus({ preventScroll: true });
    element.setSelectionRange(position, position);
    cursorRef.current = position;
    scrollToLine(element, section.line);
  }

  async function openPrint() {
    if (editable && !(await flush())) return;
    router.push(`/documents/${documentId}/print`);
  }

  async function finalize() {
    if (!(await flush())) { setDialog(""); return; }
    try {
      const payload = await api(`/v1/eye/documents/${documentId}/finalize`, { method: "POST", body: { expectedRevision: revisionRef.current } });
      setDocument(payload.document);
      revisionRef.current = payload.document.revision;
      setDialog("");
      setPane("preview");
    } catch (nextError) {
      setDialog("");
      setError(nextError.message);
    }
  }

  async function discard() {
    while (savingRef.current) await savingRef.current;
    try {
      await api(`/v1/eye/documents/${documentId}/discard`, { method: "POST", body: { expectedRevision: revisionRef.current } });
      dirtyRef.current = false;
      router.push(`/patients/${document.patientId}`);
    } catch (nextError) {
      setDialog("");
      setError(nextError.message);
    }
  }

  async function duplicate() {
    try {
      const payload = await api(`/v1/eye/documents/${documentId}/duplicate`, { method: "POST", body: {} });
      router.push(`/documents/${payload.document.documentId}`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const preview = useMemo(() => (document && form ? { ...document, ...form } : null), [document, form]);
  const checks = useMemo(() => (preview && editable ? letterChecks(preview) : []), [preview, editable]);
  const source = useMemo(() => sourceCheck(document, chart), [document, chart]);

  useAutoHeight(bodyRef, form?.body);

  if (error && !document) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!document || !form) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const patient = document.patientSnapshot || {};
  const age = ageOn(patient.birthDate, document.issueDate || undefined);
  const blockers = checks.filter((item) => item.level === "blocker");
  const warnings = [...checks.filter((item) => item.level === "warning"), ...(source?.level === "warning" ? [source] : [])];
  const purpose = readPurpose(form.body);
  const purposeValue = purposeDraft ?? purpose?.text ?? "";
  const sections = parseLetter(form.body).sections;
  const canFinalize = document.status === "draft" && context?.canFinalize;
  const canDiscard = editable;
  const isReferral = document.type === "referral";
  const recipientKey = keyOf(form.recipient);
  const typed = String(form.recipient.institution || "").trim();
  const visibleSuggestions = suggestions
    .filter((item) => keyOf(item) !== recipientKey)
    .filter((item) => !typed || `${item.institution}${item.department}${item.doctor}`.includes(typed))
    .slice(0, 5);

  function setPurpose(text, urgent = purpose?.urgent) {
    change({ body: writePurpose(formRef.current.body, { text, urgent }) });
  }

  return (
    <main className={`eye-page doc-page${editable ? " is-editing" : " is-reading"}`}>
      <header className="doc-head">
        <div className="doc-head-main">
          <Link className="back-link" href={`/patients/${document.patientId}`}>← {patient.displayName}</Link>
          <h1>
            {form.title} <span className={`tag ${document.status === "finalized" ? "tag-ok" : document.status === "discarded" ? "tag-warn" : "tag-draft"}`}>{STATUS_LABELS[document.status] || document.status}</span>
          </h1>
          <p className="doc-head-sub">
            <span>{patient.displayName}</span>
            {age !== null ? <span>{age}歳</span> : null}
            {SEX_LABELS[patient.sex] ? <span>{SEX_LABELS[patient.sex]}</span> : null}
            {patient.primaryPatientNumber ? <span>No.{patient.primaryPatientNumber}</span> : null}
            {document.status === "finalized" ? <span>確定 {formatDateTime(document.finalizedAt)} {document.finalizedBy?.displayName || ""}</span> : null}
          </p>
        </div>
        <div className="doc-head-actions">
          {editable ? <SaveIndicator onRetry={() => saveRef.current()} state={saveState} /> : null}
          {document.status !== "discarded" ? (
            <button className={`btn ${document.status === "finalized" ? "btn-primary" : "btn-ghost"}`} onClick={openPrint} type="button">{document.status === "finalized" ? "印刷" : "印刷プレビュー"}</button>
          ) : null}
          {document.status === "finalized" && context?.canWriteDocuments ? <button className="btn btn-ghost" onClick={duplicate} type="button">複製して修正</button> : null}
          {canDiscard ? (
            <details className="more-menu">
              <summary aria-label="文書のその他の操作" className="btn btn-chip">…</summary>
              <div className="more-menu-list">
                <button className="btn btn-ghost danger-text" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setDialog("discard"); }} type="button">下書きを破棄</button>
              </div>
            </details>
          ) : null}
          {canFinalize ? <button className="btn btn-primary" onClick={() => setDialog("finalize")} type="button">確定する</button> : null}
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {document.status === "discarded" ? <p className="alert alert-warn">この下書きは破棄されています（{formatDateTime(document.discardedAt)} {document.discardedBy?.displayName || ""}）。</p> : null}
      {document.status === "draft" && !context?.canFinalize ? <p className="alert alert-info">下書きとして保存されます。確定は医師が行います。</p> : null}
      {notice ? <p aria-live="polite" className="sr-only">{notice}</p> : null}

      {editable ? (
        <div aria-label="表示の切り替え" className="doc-pane-switch" role="tablist">
          <button aria-selected={pane === "input"} className="btn btn-chip" onClick={() => setPane("input")} role="tab" type="button">入力</button>
          <button aria-selected={pane === "preview"} className="btn btn-chip" onClick={() => setPane("preview")} role="tab" type="button">プレビュー</button>
        </div>
      ) : null}

      <div className={`doc-workspace${editable ? "" : " is-readonly"}`} data-pane={pane}>
        {editable ? (
          <div className="doc-inputs">
            <section aria-label="確定前の確認" className={`doc-checks${blockers.length ? " has-blockers" : warnings.length ? " has-warnings" : ""}`}>
              <h2>確定前の確認</h2>
              <ul className="plain">
                {blockers.map((item) => (
                  <li className="is-blocker" key={item.code}>
                    <span>{item.message}</span>
                    {item.code === "purpose_empty" ? <button className="btn btn-chip" onClick={() => purposeRef.current?.focus()} type="button">入力する</button> : null}
                  </li>
                ))}
                {warnings.map((item) => (
                  <li className="is-warning" key={item.code}>
                    <span>{item.message}</span>
                    {item.code === "source_outdated" ? <button className="btn btn-chip" onClick={() => setInserting(true)} type="button">カルテから挿入</button> : null}
                  </li>
                ))}
                {source && source.level !== "warning" ? <li className="is-info" key="source"><span>{source.message}</span></li> : null}
                {!blockers.length && !warnings.length ? <li className="is-ok"><span>確定できます。</span></li> : null}
              </ul>
            </section>

            <section className="doc-card" aria-labelledby="doc-recipient-heading">
              <h2 id="doc-recipient-heading">宛先</h2>
              <div className="doc-recipient-grid">
                <label className="field"><span>医療機関</span><input aria-label="宛先 医療機関" autoComplete="off" className="input" onChange={(event) => changeRecipient({ institution: event.target.value })} value={form.recipient.institution} /></label>
                <label className="field"><span>診療科</span><input aria-label="宛先 診療科" autoComplete="off" className="input" onChange={(event) => changeRecipient({ department: event.target.value })} value={form.recipient.department} /></label>
                <label className="field"><span>医師名</span><input aria-label="宛先 医師" autoComplete="off" className="input" onChange={(event) => changeRecipient({ doctor: event.target.value })} placeholder="氏名のみ" value={form.recipient.doctor} /></label>
                <label className="field doc-honorific"><span>敬称</span>
                  <select aria-label="宛先 敬称" className="input" onChange={(event) => changeRecipient({ honorific: event.target.value })} value={form.recipient.honorific || DEFAULT_HONORIFIC}>
                    {HONORIFIC_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
              {visibleSuggestions.length ? (
                <div className="doc-suggest">
                  <span className="doc-suggest-label">候補</span>
                  {visibleSuggestions.map((item) => (
                    <button className="btn btn-chip" key={keyOf(item)} onClick={() => changeRecipient({ institution: item.institution, department: item.department, doctor: item.doctor })} type="button">
                      {[item.institution, item.department, item.doctor ? `${item.doctor} 先生` : ""].filter(Boolean).join(" ")}
                      <span className="doc-suggest-meta">{item.mine ? "この患者" : `${item.count}件`}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            {isReferral ? (
              <section className="doc-card" aria-labelledby="doc-purpose-heading">
                <div className="doc-card-head">
                  <h2 id="doc-purpose-heading">紹介目的 <em className="doc-required">必須</em></h2>
                  {purpose ? (
                    <span aria-label="緊急度" className="doc-seg" role="group">
                      <button aria-pressed={!purpose.urgent} className="btn btn-chip" onClick={() => setPurpose(purposeValue, false)} type="button">通常</button>
                      <button aria-pressed={purpose.urgent} className="btn btn-chip" onClick={() => setPurpose(purposeValue, true)} type="button">至急</button>
                    </span>
                  ) : null}
                </div>
                {purpose ? (
                  <>
                    <textarea
                      aria-label="紹介目的"
                      className="input doc-purpose"
                      onBlur={() => setPurposeDraft(null)}
                      onChange={(event) => { setPurposeDraft(event.target.value); setPurpose(event.target.value); }}
                      onFocus={() => setPurposeDraft(purpose.text)}
                      placeholder="例: 左眼白内障手術のご検討をお願いいたします。"
                      ref={purposeRef}
                      rows={2}
                      value={purposeValue}
                    />
                    <div className="doc-phrases">
                      {PURPOSE_PHRASES.map(([label, text]) => (
                        <button className="btn btn-chip" key={label} onClick={() => setPurpose([purposeValue.trim(), text].filter(Boolean).join("\n"))} type="button">{label}</button>
                      ))}
                    </div>
                    <p className="doc-hint">本文の【紹介目的】に入ります。{purpose.urgent ? "至急の一文を先頭に入れています。" : ""}</p>
                  </>
                ) : (
                  <p className="doc-hint">本文に【紹介目的】の見出しがありません。本文に「【紹介目的】」の行を書くと、ここから入力できます。</p>
                )}
              </section>
            ) : null}

            <section className="doc-card" aria-labelledby="doc-body-heading">
              <div className="doc-card-head">
                <h2 id="doc-body-heading">本文</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setInserting(true)} type="button">＋カルテから挿入</button>
              </div>
              {sections.length ? (
                <nav aria-label="本文の見出し" className="doc-toc">
                  {sections.map((section) => (
                    <button className={`btn btn-chip${section.text.trim() ? "" : " is-empty"}`} key={`${section.line}-${section.heading}`} onClick={() => jumpToSection(section)} title={section.text.trim() ? "" : "この見出しの下が空です"} type="button">{section.heading}</button>
                  ))}
                </nav>
              ) : null}
              <textarea
                aria-label="本文"
                className="input document-body"
                onBlur={rememberCursor}
                onChange={(event) => { change({ body: event.target.value }); cursorRef.current = event.target.selectionStart; }}
                onClick={rememberCursor}
                onKeyUp={rememberCursor}
                onSelect={rememberCursor}
                ref={bodyRef}
                rows={12}
                value={form.body}
              />
            </section>

            <details className="doc-card doc-settings">
              <summary>文書の設定（表題・発行日）</summary>
              <div className="doc-settings-grid">
                <label className="field"><span>表題</span><input className="input" onChange={(event) => change({ title: event.target.value })} value={form.title} /></label>
                <label className="field"><span>発行日</span><input className="input" onChange={(event) => change({ issueDate: event.target.value })} type="date" value={form.issueDate} /></label>
              </div>
            </details>
          </div>
        ) : null}

        <div className="doc-preview-pane">
          {inserting && editable ? (
            <DocumentInsertPanel
              onClose={() => setInserting(false)}
              onInsert={insertAtCursor}
              patientId={document.patientId}
              sourceEncounterId={document.encounterId}
            />
          ) : (
            <ScaledSheet>
              <LetterSheet document={preview} printNames={printNames} showEmpty={editable} />
            </ScaledSheet>
          )}
        </div>
      </div>

      {dialog === "finalize" ? (
        <FinalizeDocumentDialog blockers={blockers} onCancel={() => setDialog("")} onConfirm={finalize} warnings={warnings} />
      ) : null}
      {dialog === "discard" ? (
        <ConfirmDialog confirmLabel="破棄する" danger onCancel={() => setDialog("")} onConfirm={discard} title="この下書きを破棄しますか？">
          <p>「{form.title}」の下書きを一覧から外します。破棄した記録は操作記録に残ります。元には戻せません。</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

function FinalizeDocumentDialog({ blockers, warnings, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="doc-finalize-heading" className="dialog" role="dialog">
        <h2 id="doc-finalize-heading">文書を確定しますか？</h2>
        {blockers.length ? <ul className="readiness">{blockers.map((item) => <li className="is-blocker" key={item.code}>{item.message}</li>)}</ul> : null}
        {warnings.length ? <ul className="readiness">{warnings.map((item) => <li className="is-warning" key={item.code}>{item.message}</li>)}</ul> : null}
        <p>確定すると内容は変更できません。修正が必要な場合は「複製して修正」から新しい文書を作ります。</p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">戻って編集</button>
          <button autoFocus className="btn btn-primary" disabled={busy || blockers.length > 0} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }} type="button">確定する</button>
        </div>
      </div>
    </div>
  );
}

// A4 の紙面を、置き場所の幅に合わせて縮小して見せる（縮小だけ。改ページの計算はしない）。
function ScaledSheet({ children }) {
  const frameRef = useRef(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return undefined;
    // スマホ幅では縮小せず、紙面を幅いっぱいに組み直す（print.css の 720px 未満の指定）
    const update = () => setScale(window.innerWidth < 720 ? 1 : Math.min(1, Math.max(0.3, (frame.clientWidth - 26) / A4_WIDTH_PX)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="doc-preview-frame" ref={frameRef}>
      <div className="sheet sheet-a4 sheet-letter doc-preview-sheet" style={{ zoom: scale }}>
        {children}
      </div>
    </div>
  );
}

// 本文の欄は内容に合わせて高さを伸ばす（欄の中のスクロールをなくす）。field-sizing が使えるブラウザは CSS に任せる。
function useAutoHeight(ref, value) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [ref, value]);
}

function scrollToLine(element, line) {
  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const top = element.getBoundingClientRect().top + window.scrollY + Number.parseFloat(style.paddingTop || "0") + line * lineHeight;
  window.scrollTo({ top: Math.max(0, top - 160), behavior: "smooth" });
}

// 差し込み元のカルテ。新しいカルテ（今日の下書きなど）があるのに古いカルテから作ったときは知らせる。
function sourceCheck(document, chart) {
  if (!document || document.status !== "draft" || document.type === "other") return null;
  const newer = (chart || []).filter((item) => item.encounterId !== document.encounterId && (!document.encounterDate || item.encounterDate > document.encounterDate));
  const latest = newer[0];
  if (latest) {
    const state = latest.status === "finalized" ? "確定" : "未確定";
    return {
      code: "source_outdated",
      level: "warning",
      message: document.encounterDate
        ? `差し込み元は ${formatDate(document.encounterDate)} のカルテです。${formatDate(latest.encounterDate)} のカルテ（${state}）の内容は入っていません。`
        : `カルテの内容は差し込まれていません。${formatDate(latest.encounterDate)} のカルテ（${state}）があります。`
    };
  }
  if (document.encounterDate) return { code: "source", level: "info", message: `差し込み元: ${formatDate(document.encounterDate)} のカルテ` };
  return null;
}

function mergeRecipients(documents, recipients) {
  const seen = new Set();
  const list = [];
  for (const item of documents) {
    const recipient = item.recipient || {};
    if (!String(recipient.institution || "").trim()) continue;
    const entry = { institution: recipient.institution.trim(), department: String(recipient.department || "").trim(), doctor: String(recipient.doctor || "").trim(), mine: true, count: 1 };
    if (seen.has(keyOf(entry))) continue;
    seen.add(keyOf(entry));
    list.push(entry);
  }
  for (const item of recipients) {
    if (seen.has(keyOf(item))) continue;
    seen.add(keyOf(item));
    list.push({ ...item, mine: false });
  }
  return list;
}

function keyOf(recipient = {}) {
  return [recipient.institution, recipient.department, recipient.doctor].map((value) => String(value || "").trim()).join("|");
}

function formFrom(document) {
  return {
    title: document.title,
    recipient: { institution: "", department: "", doctor: "", ...document.recipient },
    body: document.body,
    issueDate: document.issueDate
  };
}
