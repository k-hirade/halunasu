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
import { AmendDialog, ConfirmDialog, FinalizeDialog, SaveIndicator } from "./encounter-dialogs";
import { CandidatesPanel, ComparePanel, HistoryPane, ReadinessPanel, SetsAndPhrasesPanel, VersionsPanel } from "./encounter-panels";
import { DocumentsPanel } from "./documents-panel";
import { DilationFlags, ExamTable, hasExamValues, NextVisit, OpticalSection, Orders, Prescriptions, Section, setIn, Sketches } from "./encounter-sections";
import { StatusTag } from "./home-workspace";
import { CommonDiagnosesList, PatientBanner } from "./patient-banner";
import { useEncounterDraft } from "./use-encounter-draft";
import { useMediaQuery } from "./use-media-query";
import { addDays, EYE_LABELS, formatDate, formatDateTime } from "../lib/format";

const SIDES = ["od", "os"];
const SECTION_LINKS = [
  ["subjective", "主訴"],
  ["exam", "検査"],
  ["orders", "オーダー"],
  ["findings", "所見"],
  ["sketches", "シェーマ"],
  ["diagnoses", "病名"],
  ["plan", "方針"],
  ["prescriptions", "処方"],
  ["next-visit", "次回"],
  ["optical", "眼鏡"],
  ["staff-note", "メモ"]
];
const SIDE_TABS = [
  ["compare", "前回比較"],
  ["candidates", "候補"],
  ["booking", "次回予約"],
  ["documents", "文書"],
  ["versions", "確定履歴"]
];

export function EncounterEditor({ encounterId }) {
  const router = useRouter();
  const draft = useEncounterDraft(encounterId);
  const {
    detail, setDetail, context, bootstrap, content, meta, encounter, editable, saveState, error, setError, conflict,
    load, save, update, replaceContent, saveWith, updateMeta, runAction: runDraftAction, confirmExam
  } = draft;
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  const [booking, setBooking] = useState({ open: false, saved: null });
  const [sideTab, setSideTab] = useState("compare");
  const [historyOpen, setHistoryOpen] = useState(true);
  const [drawer, setDrawer] = useState(null);
  const wide = useMediaQuery("(min-width: 1280px)", true);
  const pageRef = useRef(null);
  const barRef = useRef(null);
  const [now, setNow] = useState(Date.now());
  const drugPresets = bootstrap.drugPresets;

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(handle);
  }, []);

  // 固定ヘッダーの高さを CSS に渡す（左右の列の追従位置と、項目へ移動したときの位置合わせに使う）。
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
    if (wide) setDrawer((current) => (current === "history" || current === "side" ? null : current));
  }, [wide]);

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
  const activeDiagnoses = (profile?.diagnoses || []).filter((item) => item.status !== "resolved");
  const blockerCount = readiness.blockers.length;
  const showHistory = wide ? historyOpen : true;

  function toggleHistory() {
    if (wide) setHistoryOpen(!historyOpen);
    else setDrawer(drawer === "history" ? null : "history");
  }

  function fillNormalFindings(sides) {
    let next = content;
    for (const side of sides) {
      for (const key of ["anterior", "lens", "fundus"]) {
        if (!next.findings[side][key]) next = setIn(next, ["findings", side, key], "異常なし");
      }
    }
    replaceContent(next);
  }

  return (
    <main className="eye-page encounter-page" ref={pageRef}>
      <header className="encounter-bar" ref={barRef}>
        <PatientBanner
          actions={(
            <div className="encounter-actions">
              {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
              <a className="btn btn-ghost" href={`/encounters/${encounterId}/print`} rel="noreferrer" target="_blank">印刷</a>
              {encounter.status === "draft" && context?.canFinalize ? (
                <button className="btn btn-primary" onClick={() => setDialog("finalize")} title="⌘/Ctrl + Enter" type="button">確定する</button>
              ) : null}
              {encounter.status === "finalized" && context?.canFinalize ? (
                <button className="btn btn-ghost" onClick={() => setDialog("amend")} type="button">修正する</button>
              ) : null}
              {encounter.status === "draft" && encounter.versionCount === 0 && context?.canWrite ? (
                <details className="more-menu">
                  <summary aria-label="その他の操作" className="btn btn-ghost">…</summary>
                  <div className="more-menu-list">
                    <button className="btn btn-ghost danger-text" onClick={() => setDialog("discard")} type="button">下書きを破棄</button>
                  </div>
                </details>
              ) : null}
            </div>
          )}
          compact
          context={context}
          leading={<Link aria-label="患者のカルテ一覧へ" className="back-link" href={`/patients/${encounter.patientId}`}>←</Link>}
          onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
          patient={patient}
          profile={profile}
          sub={<StatusTag encounter={{ ...encounter, amending: Boolean(encounter.amendment) }} />}
        />
        <div className="encounter-toolbar">
          <button aria-expanded={wide ? historyOpen : drawer === "history"} className="btn btn-chip" onClick={toggleHistory} type="button">
            過去カルテ {detail.history.length}件
          </button>
          <nav aria-label="項目へ移動" className="section-jump">
            {SECTION_LINKS.map(([id, label]) => (
              <a className="section-jump-link" href={`#sec-${id}`} key={id} onClick={(event) => jumpTo(event, id)}>{label}</a>
            ))}
          </nav>
          <label className="inline-field">
            <span>診療日</span>
            <input className="input input-date" disabled={!editable} onChange={(event) => updateMeta({ encounterDate: event.target.value })} type="date" value={meta.encounterDate} />
          </label>
          <label className="inline-field">
            <span>区分</span>
            <select className="input" disabled={!editable} onChange={(event) => updateMeta({ visitType: event.target.value })} value={meta.visitType}>
              <option value="initial">初診</option>
              <option value="revisit">再診</option>
            </select>
          </label>
          <button aria-expanded={drawer === "side"} className={`btn btn-chip side-drawer-toggle${blockerCount ? " has-blockers" : ""}`} onClick={() => setDrawer(drawer === "side" ? null : "side")} type="button">
            {encounter.status === "draft" ? `確認・比較${blockerCount ? `（要確認 ${blockerCount}）` : ""}` : "比較・履歴"}
          </button>
        </div>
      </header>

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

      <div className={`encounter-3col${showHistory && wide ? "" : " is-history-hidden"}${drawer ? ` is-drawer-${drawer}` : ""}`}>
        {showHistory ? (
          <aside aria-label="過去カルテ" className="encounter-history">
            <div className="pane-head">
              <h2 className="pane-title">過去カルテ</h2>
              <button className="btn btn-chip" onClick={() => (wide ? setHistoryOpen(false) : setDrawer(null))} type="button">閉じる</button>
            </div>
            <HistoryPane editable={editable} history={detail.history} onCopy={(kind, source) => { copyFrom(kind, source); if (!wide) setDrawer(null); }} />
          </aside>
        ) : null}

        <fieldset className="encounter-form" disabled={!editable}>
          <CommonDiagnosesList />
          <Section id="subjective" title="主訴・経過">
            <div className="subjective-grid">
            <label className="field">
              <span>主訴</span>
              <textarea className="input" onChange={(event) => update(["chiefComplaint"], event.target.value)} rows={2} value={content.chiefComplaint} />
            </label>
            <label className="field">
              <span>現病歴・経過</span>
              <textarea className="input" onChange={(event) => update(["history"], event.target.value)} rows={2} value={content.history} />
            </label>
            </div>
          </Section>

          <Section id="exam" title="検査">
            <ExamTable
              canConfirm={editable}
              confirmations={encounter.examConfirmations || { od: null, os: null }}
              content={content}
              onConfirm={(side, confirmed) => confirmExam(side, confirmed)}
              previous={previous?.content}
              update={update}
            />
            <DilationFlags content={content} editable={editable} now={now} update={update} />
          </Section>

          <Section id="orders" title="検査・処置オーダー">
            <Orders catalog={bootstrap.orderCatalog} content={content} editable={editable} update={update} />
          </Section>

          <Section
            actions={editable ? <button className="btn btn-chip" onClick={() => fillNormalFindings(SIDES)} type="button">空欄を「異常なし」に</button> : null}
            id="findings"
            title="所見"
          >
            <div className="eye-columns">
              {SIDES.map((side) => (
                <div className="eye-column" key={side}>
                  <div className="eye-column-head">
                    <h3 className={`eye-heading eye-${side}`}>{EYE_LABELS[side]}</h3>
                    {editable ? <button className="btn btn-chip" onClick={() => fillNormalFindings([side])} type="button">{EYE_LABELS[side]} 異常なし</button> : null}
                  </div>
                  {[["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]].map(([key, label]) => (
                    <label className="field" key={key}>
                      <span>{label}</span>
                      <textarea className="input" onChange={(event) => update(["findings", side, key], event.target.value)} rows={1} value={content.findings[side][key]} />
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </Section>

          <Section id="sketches" title="シェーマ">
            <Sketches content={content} editable={editable} update={update} />
          </Section>

          <Section id="diagnoses" title="傷病名">
            {activeDiagnoses.length === 0 ? <p className="empty">登録された傷病名はありません。上の「アレルギー・病名」から登録します。</p> : (
              <ul className="plain dx-list">
                {activeDiagnoses.map((item) => (
                  <li key={item.diagnosisId || item.name}>
                    {item.primary ? <span className="tag">主</span> : null} {EYE_LABELS[item.eye]} {item.name}
                    {item.status === "suspected" ? <span className="tag tag-warn">疑い</span> : null}
                    {item.startDate ? <span className="muted small"> {formatDate(item.startDate)}〜</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">傷病名は患者ごとに管理し、確定時にこのカルテへ写し取ります。</p>
          </Section>

          <Section id="plan" title="評価・方針">
            <label className="field">
              <span>評価</span>
              <textarea className="input" onChange={(event) => update(["assessment"], event.target.value)} rows={2} value={content.assessment} />
            </label>
            <label className="field">
              <span>方針</span>
              <textarea className="input" onChange={(event) => update(["plan"], event.target.value)} rows={2} value={content.plan} />
            </label>
          </Section>

          <Section id="prescriptions" title="処方">
            <Prescriptions content={content} drugPresets={drugPresets} editable={editable} nextDays={nextDays} update={update} />
          </Section>

          <Section id="next-visit" title="次回受診">
            <NextVisit content={content} editable={editable} encounterDate={meta.encounterDate} suggestion={detail.nextVisitSuggestion} update={update} />
          </Section>

          <Section id="optical" title="眼鏡・コンタクトレンズ処方">
            <OpticalSection content={content} editable={editable} encounterId={encounterId} update={update} />
          </Section>

          <Section id="staff-note" title="スタッフメモ">
            <textarea aria-label="スタッフメモ" className="input" onChange={(event) => update(["staffNote"], event.target.value)} rows={2} value={content.staffNote} />
          </Section>
        </fieldset>

        <aside aria-label="補助パネル" className="encounter-side">
          <div className="pane-head drawer-only">
            <h2 className="pane-title">確認・比較</h2>
            <button className="btn btn-chip" onClick={() => setDrawer(null)} type="button">閉じる</button>
          </div>
          {encounter.status === "draft" ? (
            <section className="panel">
              <h2>確定前の確認</h2>
              <ReadinessPanel readiness={readiness} />
            </section>
          ) : null}
          <div className="side-tabs" role="tablist">
            {SIDE_TABS.map(([key, label]) => (
              <button aria-selected={sideTab === key} className="side-tab" key={key} onClick={() => setSideTab(key)} role="tab" type="button">{label}</button>
            ))}
          </div>
          <div className="side-tab-body" role="tabpanel">
            {sideTab === "compare" ? <ComparePanel changes={changes} previous={previous} /> : null}
            {sideTab === "candidates" ? (
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
            {sideTab === "booking" ? (
              <section className="panel next-booking">
                <h2>次回予約</h2>
                <p className="small muted">
                  {content.nextVisit.intervalWeeks
                    ? `指示: ${content.nextVisit.intervalWeeks}週後（目安 ${formatDate(addDays(meta.encounterDate, Math.round(content.nextVisit.intervalWeeks * 7)))}）`
                    : "次回受診の指示はまだありません。"}
                </p>
                {booking.saved ? <p className="alert alert-ok small">予約しました: {formatDate(booking.saved.date)}{booking.saved.time ? ` ${booking.saved.time}` : ""}</p> : null}
                {context?.canReceive ? (
                  <button className="btn btn-ghost" onClick={() => setBooking({ open: true, saved: null })} type="button">次回予約を取る</button>
                ) : <p className="muted small">予約の登録は受付の権限が必要です。</p>}
              </section>
            ) : null}
            {sideTab === "documents" ? (
              <DocumentsPanel canWrite={Boolean(context?.canWriteDocuments)} encounterId={encounter.status === "finalized" ? encounterId : ""} patientId={encounter.patientId} />
            ) : null}
            {sideTab === "versions" ? (
              detail.versions.length
                ? <VersionsPanel encounterId={encounterId} versions={detail.versions} />
                : <section className="panel"><p className="empty">まだ確定していません。</p></section>
            ) : null}
          </div>
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

  function jumpTo(event, id) {
    const target = document.getElementById(`sec-${id}`);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.querySelector("input, textarea, select")?.focus({ preventScroll: true });
  }
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
        for (const key of ["anterior", "lens", "fundus"]) {
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
