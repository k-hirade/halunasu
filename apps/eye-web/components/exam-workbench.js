"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SaveIndicator } from "./encounter-dialogs";
import { DilationFlags, ExamTable, hasExamValues, Orders } from "./encounter-sections";
import { PatientBanner } from "./patient-banner";
import { useEncounterDraft } from "./use-encounter-draft";
import { EYE_LABELS, EYE_SHORT } from "../lib/format";

const SIDES = ["od", "os"];
const HANDOFF_CHIPS = ["眼鏡持参なし", "CL装用中", "固視不良", "測定困難", "再検希望"];
// 検査員がこの画面から「診察待ち」に進めてよい受付の状態。
const FINISHABLE = new Set(["in_exam", "checked_in"]);

// 視能訓練士・検査員の作業画面。検査の順に並んだ表、本日の検査、散瞳、申し送りと、
// 下に固定の「検査終了 → 診察待ちへ」（保存 → 値のある眼を確認 → 受付の状態を進める）。
export function ExamWorkbench({ encounterId }) {
  const router = useRouter();
  const {
    api, detail, setDetail, context, bootstrap, content, meta, encounter, editable, saveState, error, conflict, load, save, update, confirmExam
  } = useEncounterDraft(encounterId);
  const [now, setNow] = useState(Date.now());
  const [matches, setMatches] = useState(null);
  const [finishing, setFinishing] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(handle);
  }, []);

  const patientId = encounter?.patientId;
  const encounterDate = meta.encounterDate;
  const canReceive = Boolean(context?.canReceive);
  // 同じ日・同じ患者で「受付済」「検査中」の受付を探す。ちょうど 1 件のときだけ状態を進める（誤った受付を動かさない）。
  const findMatches = useCallback(async () => {
    const payload = await api(`/v1/eye/appointments?date=${encounterDate}`);
    return (payload.appointments || []).filter((item) => item.patientId === patientId && FINISHABLE.has(item.status));
  }, [api, encounterDate, patientId]);

  useEffect(() => {
    if (!patientId || !encounterDate || !canReceive || encounter?.status !== "draft") return;
    let cancelled = false;
    findMatches().then((list) => { if (!cancelled) setMatches(list); }).catch(() => { if (!cancelled) setMatches([]); });
    return () => { cancelled = true; };
  }, [canReceive, encounter?.status, encounterDate, findMatches, patientId]);

  if (error && !detail) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!detail || !content) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const previous = detail.previous;
  const confirmations = encounter.examConfirmations || { od: null, os: null };
  const flags = content.flags || {};
  const missing = SIDES.filter((side) => !hasExamValues(content.exam[side]));
  const willMove = canReceive && matches?.length === 1;
  const dilationMinutes = flags.dilationStartedAt ? Math.max(0, Math.floor((now - Date.parse(flags.dilationStartedAt)) / 60000)) : null;

  async function finish() {
    setFinishing(true);
    setMessage(null);
    try {
      if (!(await save())) return;
      const pending = SIDES.filter((side) => hasExamValues(content.exam[side]) && !confirmations[side]);
      if (pending.length === 2) {
        if (!(await confirmExam("both", true))) return;
      } else {
        for (const side of pending) {
          if (!(await confirmExam(side, true))) return;
        }
      }
      if (!canReceive) {
        setMessage({ kind: "ok", text: "検査値を確認済みにしました。受付の状態は受付で進めてください。" });
        return;
      }
      let list;
      try {
        list = await findMatches();
      } catch (nextError) {
        setMessage({ kind: "warn", text: `検査値を確認済みにしました。受付の状態は変えていません（${nextError.message}）。` });
        return;
      }
      setMatches(list);
      if (list.length !== 1) {
        setMessage({
          kind: "warn",
          text: list.length
            ? "検査値を確認済みにしました。この患者の本日の受付が2件以上あるため、受付の状態は変えていません。受付画面で進めてください。"
            : "検査値を確認済みにしました。検査中の受付が見つからないため、受付の状態は変えていません。"
        });
        return;
      }
      await api(`/v1/eye/appointments/${list[0].appointmentId}/status`, {
        method: "POST",
        body: { expectedRevision: list[0].revision, status: "waiting_doctor" }
      });
      router.push("/reception");
    } catch (nextError) {
      setMessage({ kind: "danger", text: nextError.message });
    } finally {
      setFinishing(false);
    }
  }

  function appendHandoff(text) {
    const current = content.staffNote || "";
    update(["staffNote"], current ? `${current}${current.endsWith("\n") ? "" : "\n"}${text}` : text);
  }

  const closeMenu = (event) => { event.currentTarget.closest("details")?.removeAttribute("open"); };
  const phrases = (bootstrap.phrases || []).filter((item) => item.active !== false && item.target === "staffNote");
  const eyeState = (side) => (confirmations[side] ? "確認済" : hasExamValues(content.exam[side]) ? "未確認" : "未入力");

  return (
    <main className="eye-page exam-workbench exam-page">
      <div className="encounter-bar is-static exam-banner">
        <PatientBanner
          compact
          context={context}
          onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
          patient={encounter.patientSnapshot}
          profile={detail.profile}
        />
      </div>
      {error ? (
        <p className="alert alert-danger" role="alert">
          {error}
          {conflict ? <> <button className="btn btn-chip" onClick={() => load({ force: true })} type="button">最新の内容を読み込む</button></> : null}
        </p>
      ) : null}
      {encounter.status !== "draft" ? <p className="alert alert-info">このカルテは確定済みのため、検査値は変更できません。</p> : null}

      <fieldset className="exam-layout" disabled={!editable}>
        <section aria-labelledby="exam-heading" className="exam-main" id="sec-exam">
          <h2 className="exam-title" id="exam-heading">検査値</h2>
          <ExamTable
            content={content}
            editable={editable}
            layout="workbench"
            previous={previous?.content}
            previousDate={previous?.encounterDate || ""}
            update={update}
          />
        </section>
        <div className="exam-side">
          <section className="exam-block" id="sec-orders">
            <Orders catalog={bootstrap.orderCatalog} content={content} editable={editable} update={update} variant="checklist" />
          </section>
          <section className="exam-block" id="sec-dilation">
            <DilationFlags content={content} editable={editable} now={now} update={update} variant="panel" />
          </section>
          <section className="exam-block" id="sec-staff-note">
            <div className="mini-head"><h2>医師への申し送り</h2></div>
            <textarea aria-label="スタッフメモ" className="input" onChange={(event) => update(["staffNote"], event.target.value)} rows={3} value={content.staffNote} />
            {editable ? (
              <div className="handoff-chips">
                {HANDOFF_CHIPS.map((text) => (
                  <button className="btn btn-chip" key={text} onClick={() => appendHandoff(text)} title="末尾に追記します" type="button">{text}</button>
                ))}
                {phrases.map((item) => (
                  <button className="btn btn-chip" key={item.phraseId} onClick={() => appendHandoff(item.text)} title={item.text} type="button">{item.label || item.text.slice(0, 12)}</button>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      </fieldset>

      <div className="exam-bar" role="region" aria-label="検査の操作">
        {message ? <p className={`exam-bar-message is-${message.kind}`} role="status">{message.text}</p> : null}
        <div className="exam-bar-row">
          {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
          <span className="exam-bar-eyes">
            {SIDES.map((side) => (
              <span className={`exam-bar-eye is-${eyeState(side) === "確認済" ? "done" : eyeState(side) === "未確認" ? "pending" : "empty"}`} key={side}>
                <span className={`eye-${side}`}>{EYE_SHORT[side]}</span> {eyeState(side)}
              </span>
            ))}
          </span>
          {dilationMinutes !== null ? (
            <span className={`exam-bar-dilation${dilationMinutes >= 20 ? " is-ready" : ""}`}>散瞳 {dilationMinutes}分</span>
          ) : null}
          <span className="exam-bar-spacer" />
          <Link className={`btn btn-ghost exam-bar-link${editable ? " is-in-menu" : ""}`} href={`/encounters/${encounterId}`}>カルテ全体</Link>
          {editable ? (
            <details className="more-menu is-up">
              <summary aria-label="その他の操作" className="btn btn-ghost">…</summary>
              <div className="more-menu-list">
                <Link className="btn btn-ghost exam-menu-narrow" href={`/encounters/${encounterId}`}>カルテ全体を開く</Link>
                {SIDES.map((side) => (confirmations[side] ? (
                  <button className="btn btn-ghost" key={side} onClick={(event) => { closeMenu(event); confirmExam(side, false); }} type="button">{EYE_LABELS[side]}の確認を取り消す</button>
                ) : hasExamValues(content.exam[side]) ? (
                  <button className="btn btn-ghost" key={side} onClick={(event) => { closeMenu(event); confirmExam(side, true); }} type="button">{EYE_LABELS[side]}だけ確認する</button>
                ) : null))}
                <button aria-pressed={Boolean(flags.myopiaTreatment)} className="btn btn-ghost" onClick={(event) => { closeMenu(event); update(["flags"], { ...flags, myopiaTreatment: !flags.myopiaTreatment }); }} type="button">
                  近視治療中{flags.myopiaTreatment ? " ✓" : ""}
                </button>
              </div>
            </details>
          ) : null}
          {editable ? (
            <span className="exam-bar-main">
              {missing.length ? <span className="exam-bar-hint">{missing.length === 2 ? "検査値が未入力です" : `${EYE_LABELS[missing[0]]}は未入力です`}</span> : null}
              <button className="btn btn-primary" disabled={finishing} onClick={finish} title={willMove ? "保存して値のある眼を確認済みにし、受付を「診察待ち」にします" : "保存して値のある眼を確認済みにします（受付の状態は変えません）"} type="button">
                {finishing ? "処理中…" : willMove ? "検査終了 → 診察待ちへ" : "検査値を確認する"}
              </button>
            </span>
          ) : null}
        </div>
      </div>
    </main>
  );
}
