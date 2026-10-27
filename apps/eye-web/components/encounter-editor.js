"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  daysUntilNextVisit,
  diffEncounterContent,
  evaluateFinalizeReadiness
} from "@halunasu/eye-core";
import { AppointmentDialog } from "./appointment-dialog";
import { AmendDialog, ConfirmDialog, SaveIndicator } from "./encounter-dialogs";
import { CandidatesPanel, ComparePanel, HistoryPane, ReadinessPanel, VersionsPanel } from "./encounter-panels";
import { DilationFlags, ExamTable, NextVisit, Orders, Prescriptions, Section, setIn, Sketches } from "./encounter-sections";
import { StatusTag } from "./home-workspace";
import { CommonDiagnosesList, PatientBanner } from "./patient-banner";
import { useEncounterDraft } from "./use-encounter-draft";
import { addDays, EYE_LABELS, formatDate, formatDateTime } from "../lib/format";

const SIDES = ["od", "os"];
const SIDE_TABS = [
  ["compare", "前回比較"],
  ["candidates", "候補"],
  ["booking", "次回予約"],
  ["versions", "確定履歴"]
];

export function EncounterEditor({ encounterId }) {
  const router = useRouter();
  const draft = useEncounterDraft(encounterId);
  const {
    detail, setDetail, context, bootstrap, content, meta, encounter, editable, saveState, error, setError, conflict,
    load, save, update, replaceContent, updateMeta, runAction: runDraftAction, confirmExam
  } = draft;
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  const [booking, setBooking] = useState({ open: false, saved: null });
  const [sideTab, setSideTab] = useState("compare");
  const [historyOpen, setHistoryOpen] = useState(true);
  const [now, setNow] = useState(Date.now());
  const drugPresets = bootstrap.drugPresets;

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(handle);
  }, []);

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
      note: ""
    }]);
    setNotice(`処方に「${preset.name}」を追加しました。`);
  }

  const patient = encounter.patientSnapshot;
  const nextDays = daysUntilNextVisit(meta.encounterDate, content.nextVisit);
  const profile = detail.profile;
  const activeDiagnoses = (profile?.diagnoses || []).filter((item) => item.status !== "resolved");

  return (
    <main className="eye-page encounter-page">
      <div className="encounter-bar">
        <PatientBanner
          actions={(
            <div className="encounter-actions">
              {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
              <a className="btn btn-ghost" href={`/encounters/${encounterId}/print`} rel="noreferrer" target="_blank">印刷</a>
              {encounter.status === "draft" && encounter.versionCount === 0 && context?.canWrite ? (
                <button className="btn btn-ghost danger-text" onClick={() => setDialog("discard")} type="button">下書きを破棄</button>
              ) : null}
              {encounter.status === "draft" && context?.canFinalize ? (
                <button className="btn btn-primary" onClick={() => setDialog("finalize")} type="button">確定する</button>
              ) : null}
              {encounter.status === "finalized" && context?.canFinalize ? (
                <button className="btn btn-ghost" onClick={() => setDialog("amend")} type="button">修正する</button>
              ) : null}
            </div>
          )}
          context={context}
          onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
          patient={patient}
          profile={profile}
          sub={<StatusTag encounter={{ ...encounter, amending: Boolean(encounter.amendment) }} />}
        />
        <div className="encounter-meta-row">
          <a className="back-link" href={`/patients/${encounter.patientId}`}>← カルテ一覧</a>
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
          <button aria-expanded={historyOpen} className="btn btn-chip history-toggle" onClick={() => setHistoryOpen(!historyOpen)} type="button">
            過去カルテ {detail.history.length}件{historyOpen ? "を隠す" : "を表示"}
          </button>
        </div>
      </div>

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

      <div className={`encounter-3col${historyOpen ? "" : " is-history-hidden"}`}>
        {historyOpen ? (
          <aside aria-label="過去カルテ" className="encounter-history">
            <h2 className="pane-title">過去カルテ</h2>
            <HistoryPane editable={editable} history={detail.history} onCopy={copyFrom} />
          </aside>
        ) : null}

        <fieldset className="encounter-form" disabled={!editable}>
          <CommonDiagnosesList />
          <Section id="subjective" title="主訴・経過">
            <label className="field">
              <span>主訴</span>
              <textarea className="input" onChange={(event) => update(["chiefComplaint"], event.target.value)} rows={2} value={content.chiefComplaint} />
            </label>
            <label className="field">
              <span>現病歴・経過</span>
              <textarea className="input" onChange={(event) => update(["history"], event.target.value)} rows={3} value={content.history} />
            </label>
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

          <Section id="findings" title="所見">
            <div className="eye-columns">
              {SIDES.map((side) => (
                <div className="eye-column" key={side}>
                  <h3 className={`eye-heading eye-${side}`}>{EYE_LABELS[side]}</h3>
                  {[["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]].map(([key, label]) => (
                    <label className="field" key={key}>
                      <span>{label}</span>
                      <textarea className="input" onChange={(event) => update(["findings", side, key], event.target.value)} rows={2} value={content.findings[side][key]} />
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
              <textarea className="input" onChange={(event) => update(["plan"], event.target.value)} rows={3} value={content.plan} />
            </label>
          </Section>

          <Section id="next-visit" title="次回受診">
            <NextVisit content={content} editable={editable} encounterDate={meta.encounterDate} suggestion={detail.nextVisitSuggestion} update={update} />
          </Section>

          <Section id="prescriptions" title="処方">
            <Prescriptions content={content} drugPresets={drugPresets} editable={editable} nextDays={nextDays} update={update} />
          </Section>

          <Section id="staff-note" title="スタッフメモ">
            <textarea aria-label="スタッフメモ" className="input" onChange={(event) => update(["staffNote"], event.target.value)} rows={2} value={content.staffNote} />
          </Section>
        </fieldset>

        <aside aria-label="補助パネル" className="encounter-side">
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
              <section className="panel">
                <h2>よく使う薬剤</h2>
                <CandidatesPanel drugPresets={drugPresets} editable={editable} onAddPrescription={addPrescriptionFromPreset} />
              </section>
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
            {sideTab === "versions" ? (
              detail.versions.length
                ? <VersionsPanel encounterId={encounterId} versions={detail.versions} />
                : <section className="panel"><p className="empty">まだ確定していません。</p></section>
            ) : null}
          </div>
        </aside>
      </div>

      {dialog === "finalize" ? (
        <ConfirmDialog
          confirmLabel="確定する"
          onCancel={() => setDialog(null)}
          onConfirm={() => runAction(`/v1/eye/encounters/${encounterId}/finalize`, {})}
          title="カルテを確定しますか？"
        >
          <p>確定すると v{encounter.versionCount + 1} として保存され、以後の変更は「修正する」から理由を付けて行います。</p>
          <ReadinessPanel readiness={readiness} />
          {changes.length ? <p className="muted small">前回からの変更: {changes.map((change) => change.label).join("、")}</p> : null}
        </ConfirmDialog>
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
      next = { ...next, prescriptions: [...next.prescriptions, ...added.map((row) => ({ ...row }))] };
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
