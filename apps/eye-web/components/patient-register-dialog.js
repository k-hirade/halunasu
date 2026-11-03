"use client";

import { useEffect, useRef, useState } from "react";
import { eraYearLabel, normalizeKanaName } from "@halunasu/eye-contracts";
import { useEyeApi } from "./eye-api";
import { ageOn, patientBirthLine } from "../lib/format";

const SEX_OPTIONS = [["male", "男"], ["female", "女"], ["other", "その他"]];

// 新規患者の登録（受付・診察・ヘッダー検索で共通）。
// onCreated(patient) は登録後の処理（患者のページを開く、受付に紐づける など）。
// 失敗したときは作った患者を覚えておき、もう一度押すと onCreated だけをやり直す（患者を二重に作らない）。
// onPickExisting(patient) を渡すと、似た患者の行に「この患者で…」のボタンを出す。
export function PatientRegisterDialog({
  title = "新規患者を登録",
  initial = {},
  submitLabel = "登録して患者を開く",
  onCancel,
  onCreated,
  onPickExisting,
  pickExistingLabel = "この患者を開く"
}) {
  const api = useEyeApi();
  const [draft, setDraft] = useState({
    displayName: initial.displayName || "",
    displayNameKana: initial.displayNameKana ? normalizeKanaName(initial.displayNameKana) : "",
    birthDate: initial.birthDate || "",
    sex: "unknown",
    primaryPatientNumber: initial.primaryPatientNumber || ""
  });
  const [created, setCreated] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [numberError, setNumberError] = useState("");
  const firstFieldRef = useRef(null);

  // 開いたら氏名欄へ。閉じたら開く前の場所にフォーカスを戻す。Esc で閉じる。
  useEffect(() => {
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    firstFieldRef.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  // 似た患者（同じフリガナ・氏名・患者番号）を既存の検索で探す。登録は止めず、押す前に目に入るようにする。
  const nameQuery = (draft.displayNameKana || draft.displayName).trim();
  const numberQuery = draft.primaryPatientNumber.trim();
  useEffect(() => {
    if (created || (nameQuery.length < 2 && !numberQuery)) {
      setSimilar([]);
      return undefined;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const queries = [nameQuery.length >= 2 ? nameQuery : "", numberQuery].filter(Boolean);
        const results = await Promise.all(queries.map((q) => api("/v1/eye/patients/search", { method: "POST", body: { q } })));
        if (cancelled) return;
        const byId = new Map();
        for (const patient of results.flatMap((payload) => payload.patients)) byId.set(patient.patientId, patient);
        setSimilar([...byId.values()].slice(0, 4));
      } catch {
        if (!cancelled) setSimilar([]);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, created, nameQuery, numberQuery]);

  const sameBirth = similar.some((patient) => draft.birthDate && patient.birthDate === draft.birthDate);
  const age = draft.birthDate ? ageOn(draft.birthDate) : null;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNumberError("");
    let patient = created;
    try {
      if (!patient) {
        const body = { ...draft, displayNameKana: normalizeKanaName(draft.displayNameKana), displayName: draft.displayName.trim() };
        patient = (await api("/v1/eye/patients", { method: "POST", body })).patient;
        setCreated(patient);
      }
      await onCreated(patient);
    } catch (nextError) {
      if (!patient && nextError.status === 409 && /identifier|patientNumber|primaryPatientNumber/u.test(`${nextError.field}`)) {
        setNumberError("この患者番号はすでに使われています。");
      } else if (patient) {
        setError(`患者「${patient.displayName}」は登録済みです。続きの処理に失敗しました: ${nextError.message} もう一度押すと続きだけをやり直します。`);
      } else {
        setError(nextError.message);
      }
      setBusy(false);
    }
  }

  async function pick(patient) {
    setBusy(true);
    setError("");
    try {
      await onPickExisting(patient);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  const kanaMissing = !draft.displayNameKana.trim();
  return (
    <div className="dialog-backdrop" role="presentation">
      <form aria-labelledby="register-heading" aria-modal="true" className="dialog register-dialog" onSubmit={submit} role="dialog">
        <h2 id="register-heading">{title}</h2>
        <label className="field">
          <span>氏名 <em>必須</em></span>
          <input
            className="input"
            disabled={Boolean(created)}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            ref={firstFieldRef}
            required
            value={draft.displayName}
          />
        </label>
        <label className="field">
          <span>フリガナ <em>必須</em></span>
          <input
            autoComplete="off"
            className="input"
            disabled={Boolean(created)}
            onBlur={() => setDraft((current) => ({ ...current, displayNameKana: normalizeKanaName(current.displayNameKana) }))}
            onChange={(event) => setDraft({ ...draft, displayNameKana: event.target.value })}
            placeholder="ミホン ハナコ"
            required
            value={draft.displayNameKana}
          />
          <small className="muted">ひらがなで入れてもカタカナにそろえます。</small>
        </label>
        <div className="field-row">
          <label className="field">
            <span>生年月日</span>
            <input className="input" disabled={Boolean(created)} max="2100-12-31" min="1868-01-01" onChange={(event) => setDraft({ ...draft, birthDate: event.target.value })} type="date" value={draft.birthDate} />
            <small className="muted register-birth-check" aria-live="polite">{draft.birthDate ? `${eraYearLabel(draft.birthDate) || ""}${age !== null && age >= 0 ? ` ・ ${age}歳` : ""}` : " "}</small>
          </label>
          <fieldset className="field register-sex" disabled={Boolean(created)}>
            <legend>性別</legend>
            <div className="segmented" role="radiogroup" aria-label="性別">
              {SEX_OPTIONS.map(([value, label]) => (
                <button aria-checked={draft.sex === value} className="segmented-option" key={value} onClick={() => setDraft({ ...draft, sex: draft.sex === value ? "unknown" : value })} role="radio" type="button">{label}</button>
              ))}
            </div>
            {draft.sex === "unknown" ? <small className="register-warn">未入力です（レセコン連携で必要です）</small> : null}
          </fieldset>
        </div>
        <label className="field">
          <span>患者番号</span>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            className="input"
            disabled={Boolean(created)}
            onChange={(event) => { setDraft({ ...draft, primaryPatientNumber: event.target.value }); setNumberError(""); }}
            value={draft.primaryPatientNumber}
          />
          {numberError ? <small className="register-error" role="alert">{numberError}</small> : <small className="muted">レセコンの患者番号と同じにします。空欄なら後で入力できます。</small>}
        </label>

        {similar.length && !created ? (
          <div className={`register-similar${sameBirth ? " is-strong" : ""}`} role="status">
            <p><strong>{sameBirth ? "同じ生年月日の似た患者がいます" : "似た患者がいます"}</strong>　同じ人なら新しく登録しないでください。</p>
            <ul>
              {similar.map((patient) => (
                <li key={patient.patientId}>
                  <span className="mono">{patient.primaryPatientNumber || "番号なし"}</span>
                  <strong>{patient.displayName}</strong>
                  <span className="muted">{patient.displayNameKana}</span>
                  <span className={draft.birthDate && patient.birthDate === draft.birthDate ? "register-same" : "muted"}>{patientBirthLine(patient)}</span>
                  {onPickExisting ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => pick(patient)} type="button">{pickExistingLabel}</button> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="muted small register-note">保険証・資格確認はレセコンで登録します。</p>
        {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
          <button className="btn btn-primary" disabled={busy || !draft.displayName.trim() || kanaMissing} type="submit">
            {busy ? "登録中…" : created ? "続きをやり直す" : sameBirth ? "別人として登録" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

// 受付の予約・当日受付に患者を紐づける。最新の版で更新し、すでに同じ患者なら何もしない。
export async function linkAppointmentToPatient(api, appointment, patient) {
  if (appointment.patientId === patient.patientId) return;
  await api(`/v1/eye/appointments/${appointment.appointmentId}`, {
    method: "PATCH",
    body: { expectedRevision: appointment.revision, patientId: patient.patientId }
  });
}
