"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  daysUntilNextVisit,
  diffEncounterContent,
  evaluateFinalizeReadiness
} from "@halunasu/eye-core";
import { AppointmentDialog } from "./appointment-dialog";
import { AmendDialog, ConfirmDialog, FinalizeDialog, RESOLVED_IN_DIALOG, SaveIndicator } from "./encounter-dialogs";
import { CandidatesPanel, ChangesPanel, HistoryPane, SetsAndPhrasesPanel, VersionsPanel } from "./encounter-panels";
import { DocumentsPanel } from "./documents-panel";
import { DilationFlags, ExamTable, hasExamValues, NextVisit, OpticalSection, Orders, Prescriptions, Section, setIn, Sketches } from "./encounter-sections";
import { StatusTag } from "./home-workspace";
import { CommonDiagnosesList, PatientBanner } from "./patient-banner";
import { useEncounterDraft } from "./use-encounter-draft";
import { useMediaQuery } from "./use-media-query";
import { addDays, EYE_LABELS, formatDate, formatDateTime, formatShortDate, patientLine, VISIT_TYPE_LABELS } from "../lib/format";

const SIDES = ["od", "os"];
const SECTION_LINKS = [
  ["exam", "検査"],
  ["subjective", "主訴"],
  ["findings", "所見"],
  ["sketches", "シェーマ"],
  ["diagnoses", "病名"],
  ["plan", "方針"],
  ["prescriptions", "処方"],
  ["next-visit", "次回"],
  ["orders", "オーダー"],
  ["optical", "眼鏡"],
  ["staff-note", "メモ"]
];
const FINDING_PARTS = [["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]];
// 空なら「+ 追加」のチップに畳む欄。値が 1 つでもあれば開いたまま、一度開いたらこの画面のあいだは閉じない。
const OPTIONAL_LABELS = { history: "現病歴・経過", assessment: "評価", sketches: "シェーマ", orders: "オーダー", optical: "眼鏡・CL", "staff-note": "スタッフメモ" };
const OPTIONAL_SECTION_OF = { history: "subjective", assessment: "plan" };

export function EncounterEditor({ encounterId }) {
  const router = useRouter();
  const draft = useEncounterDraft(encounterId);
  const {
    detail, setDetail, context, bootstrap, content, meta, encounter, editable, saveState, error, conflict,
    load, save, update, replaceContent, saveWith, updateMeta, runAction: runDraftAction, confirmExam
  } = draft;
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  const [booking, setBooking] = useState({ open: false, saved: null });
  const [paneTab, setPaneTab] = useState("history");
  const [drawer, setDrawer] = useState(null);
  const [opened, setOpened] = useState(() => new Set());
  const wide = useMediaQuery("(min-width: 1280px)", true);
  const narrow = useMediaQuery("(max-width: 767px)", false);
  const pageRef = useRef(null);
  const barRef = useRef(null);
  const [now, setNow] = useState(Date.now());
  const drugPresets = bootstrap.drugPresets;

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(handle);
  }, []);

  // 固定ヘッダーの高さを CSS に渡す（左列の追従位置と、項目へ移動したときの位置合わせに使う）。
  useEffect(() => {
    const bar = barRef.current;
    const page = pageRef.current;
    if (!bar || !page || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => page.style.setProperty("--bar-h", `${bar.offsetHeight}px`));
    observer.observe(bar);
    return () => observer.disconnect();
  }, [Boolean(detail && content)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘/Ctrl + Enter で確定ダイアログを開く。Esc で引き出しを閉じる。
  useEffect(() => {
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && detail?.encounter?.status === "draft" && context?.canFinalize) {
        event.preventDefault();
        setDialog("finalize");
      }
      if (event.key === "Escape") setDrawer(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [context?.canFinalize, detail?.encounter?.status]);

  useEffect(() => {
    if (wide) setDrawer((current) => (current === "history" ? null : current));
  }, [wide]);

  const optionalFilled = useMemo(() => (content ? {
    history: Boolean(content.history),
    assessment: Boolean(content.assessment),
    sketches: content.sketches.length > 0,
    orders: (content.orders || []).length > 0,
    optical: Boolean(content.optical?.type),
    "staff-note": Boolean(content.staffNote)
  } : {}), [content]);

  // 値が入った欄は「開いた」ことにして、あとで中身を消してもチップに戻らないようにする。
  useEffect(() => {
    const filled = Object.keys(optionalFilled).filter((key) => optionalFilled[key] && !opened.has(key));
    if (filled.length) setOpened((current) => new Set([...current, ...filled]));
  }, [optionalFilled, opened]);

  const previous = detail?.previous || null;
  const changes = useMemo(() => {
    if (!previous || !content) return [];
    try {
      return diffEncounterContent(previous.content, content);
    } catch {
      return [];
    }
  }, [previous, content]);
  const readiness = useMemo(() => {
    if (!content) return { blockers: [], warnings: [] };
    try {
      return evaluateFinalizeReadiness(content, { examConfirmations: encounter?.examConfirmations || null });
    } catch {
      return { blockers: [], warnings: [] };
    }
  }, [content, encounter?.examConfirmations]);

  if (error && !detail) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!detail || !content) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  async function runAction(path, body, after) {
    const payload = await runDraftAction(path, body);
    setDialog(null);
    if (!payload) return;
    if (after) after(payload);
    else await load({ force: true });
  }

  function copyFrom(kind, source) {
    const result = applyCopy(content, source.content, kind);
    replaceContent(result.content);
    setNotice(`${formatDate(source.encounterDate)} のカルテから${result.label}を複写しました。${result.note}`);
  }

  function addPrescriptionFromPreset(preset) {
    const topical = preset.kind === "eye_drop" || preset.kind === "eye_ointment";
    update(["prescriptions"], [...content.prescriptions, {
      kind: preset.kind,
      name: preset.name,
      presetId: preset.presetId,
      eye: topical ? "ou" : "",
      timesPerDay: preset.defaultTimesPerDay ?? null,
      quantity: null,
      unit: preset.kind === "eye_drop" ? "本" : "",
      days: null,
      note: "",
      route: preset.route || "outside",
      usage: preset.defaultUsage || "",
      issued: true
    }]);
    setNotice(`処方に「${preset.name}」を追加しました。`);
  }

  // セットを適用する。同じ処方は重ねず、オーダーは新しい予定として追加し、方針は末尾に足す。
  function applySet(orderSet) {
    const keyOf = (row) => `${row.name}|${row.eye || ""}`;
    const existing = new Set(content.prescriptions.map(keyOf));
    const prescriptions = [...content.prescriptions, ...orderSet.prescriptions.filter((row) => !existing.has(keyOf(row))).map((row) => ({ ...row }))];
    const orders = [...(content.orders || []), ...orderSet.orders.map((order) => ({
      ...order,
      orderId: `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      status: "planned",
      statusChangedAt: "",
      statusChangedBy: null
    }))];
    const plan = orderSet.plan && !content.plan.includes(orderSet.plan) ? [content.plan, orderSet.plan].filter(Boolean).join("\n") : content.plan;
    replaceContent({ ...content, prescriptions, orders, plan });
    setNotice(`セット「${orderSet.name}」を追加しました。`);
  }

  function insertPhrase(phrase, side) {
    const append = (current) => (current ? `${current}${current.endsWith("\n") ? "" : "\n"}${phrase.text}` : phrase.text);
    if (phrase.target.startsWith("findings.")) {
      const key = phrase.target.split(".")[1];
      const sides = side === "both" ? SIDES : [side];
      let next = content;
      for (const target of sides) next = setIn(next, ["findings", target, key], append(next.findings[target][key]));
      replaceContent(next);
    } else {
      update([phrase.target], append(content[phrase.target]));
    }
    setNotice(`定型文「${phrase.label || phrase.text.slice(0, 12)}」を挿入しました。`);
  }

  const patient = encounter.patientSnapshot;
  const nextDays = daysUntilNextVisit(meta.encounterDate, content.nextVisit);
  const profile = detail.profile;
  const activeDiagnoses = (profile?.diagnoses || []).filter((item) => item.status !== "resolved")
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  // 確定ボタンの件数: 確定ダイアログで解消できるもの（検査値・引き継ぎ処方の確認）と注意は黄、それ以外の止まる理由は赤。
  const pendingCount = readiness.blockers.length + readiness.warnings.length;
  const realProblems = readiness.blockers.filter((item) => !RESOLVED_IN_DIALOG.has(item.code));
  const pendingTitle = [...readiness.blockers, ...readiness.warnings].map((item) => item.message).join("\n");
  const isOpen = (key) => opened.has(key) || optionalFilled[key];

  function openOptional(key) {
    setOpened((current) => new Set([...current, key]));
    const sectionId = OPTIONAL_SECTION_OF[key] || key;
    requestAnimationFrame(() => {
      const target = key in OPTIONAL_SECTION_OF ? document.getElementById(`field-${key}`) : document.getElementById(`sec-${sectionId}`);
      target?.querySelector("input, textarea, select")?.focus();
    });
  }

  function fillNormalFindings(sides) {
    let next = content;
    for (const side of sides) {
      for (const [key] of FINDING_PARTS) {
        if (!next.findings[side][key]) next = setIn(next, ["findings", side, key], "異常なし");
      }
    }
    replaceContent(next);
  }

  function jumpTo(event, id) {
    event.preventDefault();
    event.currentTarget.closest("details")?.removeAttribute("open");
    if (id in OPTIONAL_LABELS && !isOpen(id)) setOpened((current) => new Set([...current, id]));
    requestAnimationFrame(() => {
      const target = document.getElementById(`sec-${id}`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.querySelector("input, textarea, select")?.focus({ preventScroll: true });
    });
  }

  const addChips = (keys) => {
    const closed = keys.filter((key) => !isOpen(key));
    if (!editable || !closed.length) return null;
    return (
      <div className="add-chips">
        {closed.map((key) => (
          <button className="add-chip" key={key} onClick={() => openOptional(key)} type="button">＋ {OPTIONAL_LABELS[key]}</button>
        ))}
      </div>
    );
  };

  const historyTabs = [
    ["history", `過去 ${detail.history.length}`],
    ["changes", `変更点${changes.length ? ` ${changes.length}` : ""}`],
    ["sets", "セット"]
  ];
  const nonDraftTag = encounter.status !== "draft" || encounter.amendment
    ? <StatusTag encounter={{ ...encounter, amending: Boolean(encounter.amendment) }} />
    : null;

  return (
    <main className="eye-page encounter-page chart-page" ref={pageRef}>
      <header className="encounter-bar" ref={barRef}>
        <PatientBanner
          actions={(
            <div className="encounter-actions">
              {!wide ? (
                <button aria-expanded={drawer === "history"} aria-label={`過去カルテ（${detail.history.length}件）`} className="btn btn-chip hide-narrow" onClick={() => setDrawer(drawer === "history" ? null : "history")} type="button">
                  過去 {detail.history.length}
                </button>
              ) : null}
              <details className="more-menu toc-menu">
                <summary className="btn btn-chip">目次</summary>
                <nav aria-label="項目へ移動" className="more-menu-list toc-list">
                  <button className="toc-link" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setDrawer("history"); }} type="button">過去カルテ（{detail.history.length}件）・変更点・セット</button>
                  {SECTION_LINKS.map(([id, label]) => (
                    <a className="toc-link" href={`#sec-${id}`} key={id} onClick={(event) => jumpTo(event, id)}>{label}</a>
                  ))}
                </nav>
              </details>
              {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
              <a className="btn btn-ghost hide-narrow" href={`/encounters/${encounterId}/print`} rel="noreferrer" target="_blank">印刷</a>
              {encounter.status === "draft" && context?.canFinalize ? (
                <button className="btn btn-primary finalize-button" onClick={() => setDialog("finalize")} title={pendingTitle ? `${pendingTitle}\n（⌘/Ctrl + Enter）` : "⌘/Ctrl + Enter"} type="button">
                  確定する
                  {pendingCount ? <span className={`finalize-count${realProblems.length ? " is-alert" : ""}`}>要確認 {pendingCount}</span> : null}
                </button>
              ) : null}
              {encounter.status === "finalized" && context?.canFinalize ? (
                <button className="btn btn-ghost" onClick={() => setDialog("amend")} type="button">修正する</button>
              ) : null}
              <details className="more-menu">
                <summary aria-label="その他の操作" className="btn btn-ghost">…</summary>
                <div className="more-menu-list">
                  <a className="btn btn-ghost only-narrow" href={`/encounters/${encounterId}/print`} rel="noreferrer" target="_blank">印刷</a>
                  <button className="btn btn-ghost" onClick={(event) => { event.currentTarget.closest("details").open = false; setDrawer("documents"); }} type="button">文書</button>
                  <button className="btn btn-ghost" onClick={(event) => { event.currentTarget.closest("details").open = false; setDrawer("versions"); }} type="button">確定履歴{detail.versions.length ? `（v${detail.versions.length}）` : ""}</button>
                  {encounter.status === "draft" && encounter.versionCount === 0 && context?.canWrite ? (
                    <button className="btn btn-ghost danger-text" onClick={(event) => { event.currentTarget.closest("details").open = false; setDialog("discard"); }} type="button">下書きを破棄</button>
                  ) : null}
                </div>
              </details>
            </div>
          )}
          compact
          context={context}
          leading={<Link aria-label="患者のカルテ一覧へ" className="back-link" href={`/patients/${encounter.patientId}`}>←</Link>}
          onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
          patient={patient}
          profile={profile}
          sub={<>{narrow ? null : <VisitMeta editable={editable} meta={meta} updateMeta={updateMeta} />}{nonDraftTag}</>}
        />
      </header>

      {narrow ? (
        <div className="chart-meta-narrow">
          <span className="muted">{patientLine(patient)}{patient.birthDate ? ` ・ ${formatDate(patient.birthDate)}生` : ""}</span>
          <VisitMeta editable={editable} meta={meta} updateMeta={updateMeta} />
        </div>
      ) : null}
      {error ? (
        <p className="alert alert-danger" role="alert">
          {error}
          {conflict ? <> （{conflict.sections.join("・")}） <button className="btn btn-chip" onClick={() => load({ force: true })} type="button">最新の内容を読み込む（この端末の未保存の変更は破棄）</button></> : null}
        </p>
      ) : null}
      {notice ? <p className="alert alert-ok" role="status">{notice} <button className="btn btn-chip" onClick={() => setNotice("")} type="button">閉じる</button></p> : null}
      {encounter.amendment ? (
        <p className="alert alert-warn">確定済み v{encounter.versionCount} を修正中です。理由: {encounter.amendment.reason}（{encounter.amendment.requestedBy?.displayName}・{formatDateTime(encounter.amendment.requestedAt)}）</p>
      ) : null}
      {encounter.status === "draft" && !context?.canFinalize ? (
        <p className="alert alert-info">下書きとして保存されます。確定は医師が行います。</p>
      ) : null}

      <div className={`chart-layout${drawer ? ` is-drawer-${drawer}` : ""}`}>
        <aside aria-label="過去カルテ" className="chart-pane">
          <div className="pane-head drawer-only">
            <h2 className="pane-title">過去カルテ</h2>
            <button className="btn btn-chip" onClick={() => setDrawer(null)} type="button">閉じる</button>
          </div>
          <div className="pane-tabs" role="tablist">
            {historyTabs.map(([key, label]) => (
              <button aria-selected={paneTab === key} className="pane-tab" key={key} onClick={() => setPaneTab(key)} role="tab" type="button">{label}</button>
            ))}
          </div>
          <div className="pane-body" role="tabpanel">
            {paneTab === "history" ? (
              <HistoryPane editable={editable} history={detail.history} onCopy={(kind, source) => { copyFrom(kind, source); if (!wide) setDrawer(null); }} />
            ) : null}
            {paneTab === "changes" ? <ChangesPanel changes={changes} previous={previous} /> : null}
            {paneTab === "sets" ? (
              <>
                <SetsAndPhrasesPanel
                  editable={editable}
                  onApplySet={applySet}
                  onInsertPhrase={insertPhrase}
                  orderSets={bootstrap.orderSets}
                  phrases={bootstrap.phrases}
                />
                <section className="panel">
                  <h2>よく使う薬剤</h2>
                  <CandidatesPanel drugPresets={drugPresets} editable={editable} onAddPrescription={addPrescriptionFromPreset} />
                </section>
              </>
            ) : null}
          </div>
        </aside>

        <fieldset className="encounter-form chart-sheet" disabled={!editable}>
          <CommonDiagnosesList />
          <Section
            actions={<DilationFlags content={content} editable={editable} now={now} update={update} variant="chip" />}
            className="sheet-exam"
            id="exam"
            title="検査"
          >
            <ExamTable
              canConfirm={editable}
              confirmations={encounter.examConfirmations || { od: null, os: null }}
              content={content}
              editable={editable}
              layout="chart"
              onConfirm={(side, confirmed) => confirmExam(side, confirmed)}
              previous={previous?.content}
              previousDate={previous?.encounterDate || ""}
              update={update}
            />
          </Section>

          <div className="sheet-spread">
            <div className="sheet-left">
              <Section id="subjective" title="主訴・経過">
                <div className="field">
                  <textarea aria-label="主訴" className="input auto-grow" onChange={(event) => update(["chiefComplaint"], event.target.value)} placeholder="主訴" rows={2} value={content.chiefComplaint} />
                </div>
                {isOpen("history") ? (
                  <label className="field" id="field-history">
                    <span>現病歴・経過</span>
                    <textarea className="input auto-grow" onChange={(event) => update(["history"], event.target.value)} rows={2} value={content.history} />
                  </label>
                ) : addChips(["history"])}
              </Section>

              <Section
                actions={editable ? <button className="btn btn-chip" onClick={() => fillNormalFindings(SIDES)} title="両眼の空欄を「異常なし」にします" type="button">空欄を異常なし</button> : null}
                id="findings"
                title="所見"
              >
                <div className="findings-grid">
                  {SIDES.map((side, column) => (
                    <div aria-label={EYE_LABELS[side]} className="findings-eye" key={side} role="group">
                      <div className="findings-head" style={{ "--c": column + 2 }}>
                        <h3 className={`eye-heading eye-${side}`}>{side === "od" ? "右眼 R" : "左眼 L"}</h3>
                        {editable ? (
                          <button aria-label={`${EYE_LABELS[side]}の空欄を異常なしに`} className="btn btn-chip findings-normal" onClick={() => fillNormalFindings([side])} title={`${EYE_LABELS[side]}の空欄を「異常なし」にします`} type="button">異常なし</button>
                        ) : null}
                      </div>
                      {FINDING_PARTS.map(([key, label], row) => (
                        <textarea
                          aria-label={`${EYE_LABELS[side]} ${label}`}
                          className="input auto-grow findings-input"
                          key={key}
                          onChange={(event) => update(["findings", side, key], event.target.value)}
                          rows={1}
                          style={{ "--c": column + 2, "--r": row + 2 }}
                          value={content.findings[side][key]}
                        />
                      ))}
                    </div>
                  ))}
                  {FINDING_PARTS.map(([key, label], row) => (
                    <span aria-hidden="true" className="findings-label" key={key} style={{ "--r": row + 2 }}>{label}</span>
                  ))}
                </div>
              </Section>

              {isOpen("sketches") ? (
                <Section id="sketches" title="シェーマ">
                  <Sketches content={content} editable={editable} update={update} />
                </Section>
              ) : null}
              {addChips(["sketches"])}
            </div>

            <div className="sheet-right">
              <Section id="diagnoses" title="病名">
                {activeDiagnoses.length === 0 ? (
                  <p className="empty">登録された病名はありません（患者帯の「編集」から登録）。</p>
                ) : (
                  <p className="dx-list dx-line" title="傷病名は患者ごとに管理し、確定時にこのカルテへ写し取ります。変更は患者帯の「編集」から。">
                    {activeDiagnoses.map((item, index) => (
                      <span className="dx-item" key={item.diagnosisId || item.name}>
                        {index ? <span className="dx-sep" aria-hidden="true"> / </span> : null}
                        {item.primary ? <span className="dx-primary">主</span> : null}
                        {EYE_LABELS[item.eye]} {item.name}
                        {item.status === "suspected" ? <span className="tag tag-warn">疑い</span> : null}
                        {item.startDate ? <span className="muted small"> {formatShortDate(item.startDate).replace(/\(.\)$/u, "")}〜</span> : null}
                      </span>
                    ))}
                  </p>
                )}
              </Section>

              <Section id="plan" title="評価・方針">
                {isOpen("assessment") ? (
                  <label className="field" id="field-assessment">
                    <span>評価</span>
                    <textarea className="input auto-grow" onChange={(event) => update(["assessment"], event.target.value)} rows={2} value={content.assessment} />
                  </label>
                ) : null}
                <label className="field">
                  <span>方針</span>
                  <textarea className="input auto-grow" onChange={(event) => update(["plan"], event.target.value)} rows={2} value={content.plan} />
                </label>
                {addChips(["assessment"])}
              </Section>

              <Section id="prescriptions" title="処方">
                <Prescriptions content={content} drugPresets={drugPresets} editable={editable} nextDays={nextDays} update={update} />
              </Section>

              <Section id="next-visit" title="次回">
                <NextVisit
                  action={context?.canReceive ? (
                    <button className="btn btn-chip" onClick={() => setBooking({ open: true, saved: null })} type="button">予約を取る</button>
                  ) : null}
                  content={content}
                  editable={editable}
                  encounterDate={meta.encounterDate}
                  suggestion={detail.nextVisitSuggestion}
                  update={update}
                />
                {booking.saved ? <p className="alert alert-ok small">予約しました: {formatDate(booking.saved.date)}{booking.saved.time ? ` ${booking.saved.time}` : ""}</p> : null}
              </Section>

              {isOpen("orders") ? (
                <Section id="orders" title="検査・処置オーダー">
                  <Orders catalog={bootstrap.orderCatalog} content={content} editable={editable} update={update} />
                </Section>
              ) : null}
              {isOpen("optical") ? (
                <Section id="optical" title="眼鏡・コンタクトレンズ処方">
                  <OpticalSection content={content} editable={editable} encounterId={encounterId} update={update} />
                </Section>
              ) : null}
              {isOpen("staff-note") ? (
                <Section id="staff-note" title="スタッフメモ">
                  <textarea aria-label="スタッフメモ" className="input auto-grow" onChange={(event) => update(["staffNote"], event.target.value)} rows={2} value={content.staffNote} />
                </Section>
              ) : null}
              {addChips(["orders", "optical", "staff-note"])}
            </div>
          </div>
        </fieldset>

        <aside aria-label={drawer === "versions" ? "確定履歴" : "文書"} className="chart-drawer">
          {drawer === "documents" || drawer === "versions" ? (
            <>
              <div className="pane-head">
                <h2 className="pane-title">{drawer === "versions" ? "確定履歴" : "文書"}</h2>
                <button className="btn btn-chip" onClick={() => setDrawer(null)} type="button">閉じる</button>
              </div>
              {drawer === "documents" ? (
                <DocumentsPanel canWrite={Boolean(context?.canWriteDocuments)} encounterId={encounter.status === "finalized" ? encounterId : ""} patientId={encounter.patientId} />
              ) : detail.versions.length ? (
                <VersionsPanel encounterId={encounterId} versions={detail.versions} />
              ) : <p className="empty">まだ確定していません。</p>}
            </>
          ) : null}
        </aside>
        {drawer ? <button aria-label="閉じる" className="drawer-backdrop" onClick={() => setDrawer(null)} type="button" /> : null}
      </div>

      {dialog === "finalize" ? (
        <FinalizeDialog
          content={content}
          changes={changes}
          confirmations={encounter.examConfirmations || { od: null, os: null }}
          error={error}
          onCancel={() => setDialog(null)}
          onConfirm={finalizeWithReview}
          readiness={readiness}
          version={encounter.versionCount + 1}
        />
      ) : null}
      {booking.open ? (
        <AppointmentDialog
          fixedPatient={patient}
          initial={{
            date: content.nextVisit.date || (content.nextVisit.intervalWeeks ? addDays(meta.encounterDate, Math.round(content.nextVisit.intervalWeeks * 7)) : meta.encounterDate),
            time: "",
            purpose: "revisit",
            note: content.nextVisit.note,
            walkIn: false,
            sourceEncounterId: encounterId
          }}
          onCancel={() => setBooking({ open: false, saved: null })}
          onSaved={(appointment) => setBooking({ open: false, saved: appointment })}
          title="次回予約"
        />
      ) : null}
      {dialog === "amend" ? (
        <AmendDialog onCancel={() => setDialog(null)} onConfirm={(reason) => runAction(`/v1/eye/encounters/${encounterId}/amend`, { reason })} />
      ) : null}
      {dialog === "discard" ? (
        <ConfirmDialog
          confirmLabel="破棄する"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => runAction(`/v1/eye/encounters/${encounterId}/discard`, {}, () => router.push(`/patients/${encounter.patientId}`))}
          title="この下書きを破棄しますか？"
        >
          <p>一度も確定していない下書きのため、記録は残りません。</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );

  // 確定ダイアログで内容を見たうえで確定する。引き継ぎ処方と検査値の確認も、ここで一緒に済ませる。
  async function finalizeWithReview() {
    if (content.prescriptions.some((item) => item.carriedOver)) {
      const saved = await saveWith((current) => ({ ...current, prescriptions: current.prescriptions.map((item) => ({ ...item, carriedOver: false })) }));
      if (!saved) return;
    }
    const confirmations = encounter.examConfirmations || {};
    for (const side of SIDES) {
      if (!confirmations[side] && hasExamValues(content.exam[side])) {
        if (!(await confirmExam(side, true))) return;
      }
    }
    await runAction(`/v1/eye/encounters/${encounterId}/finalize`, {});
  }
}

// 診療日・区分。めったに変えないため小さなボタンにまとめ、押すと入力欄を出す。確定済みでは表示だけ。
function VisitMeta({ meta, updateMeta, editable }) {
  const label = `${formatShortDate(meta.encounterDate)} ${VISIT_TYPE_LABELS[meta.visitType] || ""}`;
  if (!editable) return <span className="visit-meta is-static">{label}</span>;
  return (
    <details className="more-menu visit-meta">
      <summary aria-label={`診療日・区分（${label}）`} className="btn btn-chip">{label} ▾</summary>
      <div className="more-menu-list visit-meta-list">
        <label className="field">
          <span>診療日</span>
          <input className="input input-date" onChange={(event) => updateMeta({ encounterDate: event.target.value })} type="date" value={meta.encounterDate} />
        </label>
        <label className="field">
          <span>区分</span>
          <select className="input" onChange={(event) => updateMeta({ visitType: event.target.value })} value={meta.visitType}>
            <option value="initial">初診</option>
            <option value="revisit">再診</option>
          </select>
        </label>
      </div>
    </details>
  );
}

// 過去カルテからの複写。今回すでに書いた内容は上書きしない。
function applyCopy(current, source, kind) {
  let next = current;
  const notes = [];
  const kinds = kind === "all" ? ["findings", "prescriptions", "plan", "sketches"] : [kind];
  for (const item of kinds) {
    if (item === "findings") {
      let skipped = 0;
      for (const side of SIDES) {
        for (const [key] of FINDING_PARTS) {
          const value = source.findings?.[side]?.[key];
          if (!value) continue;
          if (next.findings[side][key]) {
            skipped += 1;
            continue;
          }
          next = setIn(next, ["findings", side, key], value);
        }
      }
      if (skipped) notes.push(`入力済みの所見${skipped}項目はそのままにしました。`);
    }
    if (item === "prescriptions") {
      const keyOf = (row) => `${row.name}|${row.eye || ""}`;
      const existing = new Set(next.prescriptions.map(keyOf));
      const added = (source.prescriptions || []).filter((row) => !existing.has(keyOf(row)));
      next = { ...next, prescriptions: [...next.prescriptions, ...added.map((row) => ({ ...row, carriedOver: true }))] };
      if (added.length < (source.prescriptions || []).length) notes.push("同じ処方はすでにあるため重ねていません。");
    }
    if (item === "plan") {
      if (next.plan && source.plan) notes.push("方針は入力済みのためそのままにしました。");
      next = { ...next, assessment: next.assessment || source.assessment || "", plan: next.plan || source.plan || "" };
    }
    if (item === "sketches") {
      const existing = new Set(next.sketches.map((sketch) => sketch.sketchId));
      const room = Math.max(0, 8 - next.sketches.length);
      const added = (source.sketches || []).filter((sketch) => !existing.has(sketch.sketchId)).slice(0, room);
      next = { ...next, sketches: [...next.sketches, ...added.map((sketch) => ({ ...sketch }))] };
    }
  }
  const labels = { all: "所見・処方・方針・シェーマ", findings: "所見", prescriptions: "処方", plan: "方針", sketches: "シェーマ" };
  return { content: next, label: labels[kind], note: notes.join("") };
}
