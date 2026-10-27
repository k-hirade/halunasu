"use client";

import { useEffect, useState } from "react";
import { SaveIndicator } from "./encounter-dialogs";
import { DilationFlags, ExamTable, Orders, Section } from "./encounter-sections";
import { StatusTag } from "./home-workspace";
import { PatientBanner } from "./patient-banner";
import { useEncounterDraft } from "./use-encounter-draft";

// 視能訓練士・検査員の作業画面。検査値・オーダー・散瞳だけを大きく表示する。
export function ExamWorkbench({ encounterId }) {
  const {
    detail, setDetail, context, bootstrap, content, encounter, editable, saveState, error, conflict, load, save, update, confirmExam
  } = useEncounterDraft(encounterId);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(handle);
  }, []);

  if (error && !detail) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!detail || !content) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  const previous = detail.previous;
  return (
    <main className="eye-page exam-workbench">
      <div className="encounter-bar">
        <PatientBanner
          actions={(
            <div className="encounter-actions">
              {editable ? <SaveIndicator onRetry={save} state={saveState} /> : null}
              <a className="btn btn-ghost" href="/reception">受付に戻る</a>
              <a className="btn btn-ghost" href={`/encounters/${encounterId}`}>カルテ全体を開く</a>
            </div>
          )}
          context={context}
          onProfileSaved={(saved) => setDetail((current) => ({ ...current, profile: saved }))}
          patient={encounter.patientSnapshot}
          profile={detail.profile}
          sub={<><StatusTag encounter={{ ...encounter, amending: Boolean(encounter.amendment) }} /><span className="tag">検査入力</span></>}
        />
      </div>
      {error ? (
        <p className="alert alert-danger" role="alert">
          {error}
          {conflict ? <> <button className="btn btn-chip" onClick={() => load({ force: true })} type="button">最新の内容を読み込む</button></> : null}
        </p>
      ) : null}
      {encounter.status !== "draft" ? <p className="alert alert-info">このカルテは確定済みのため、検査値は変更できません。</p> : null}

      <fieldset className="encounter-form workbench-form" disabled={!editable}>
        <Section id="exam" title="検査値">
          <ExamTable
            canConfirm={editable}
            confirmations={encounter.examConfirmations || { od: null, os: null }}
            content={content}
            onConfirm={(side, confirmed) => confirmExam(side, confirmed)}
            previous={previous?.content}
            update={update}
          />
          {editable ? (
            <div className="add-row">
              <button className="btn btn-primary" onClick={() => confirmExam("both", true)} type="button">両眼の検査値を確認済みにする</button>
            </div>
          ) : null}
        </Section>
        <Section id="dilation" title="散瞳">
          <DilationFlags content={content} editable={editable} now={now} update={update} />
        </Section>
        <Section id="orders" title="検査・処置オーダー">
          <Orders catalog={bootstrap.orderCatalog} content={content} editable={editable} update={update} />
        </Section>
        <Section id="staff-note" title="スタッフメモ（医師への申し送り）">
          <textarea aria-label="スタッフメモ" className="input" onChange={(event) => update(["staffNote"], event.target.value)} rows={3} value={content.staffNote} />
        </Section>
      </fieldset>
    </main>
  );
}
