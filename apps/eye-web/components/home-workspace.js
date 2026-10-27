"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { addDays, diagnosisText, formatDate, patientLine, todayIso, VISIT_TYPE_LABELS } from "../lib/format";

const EMPTY_PATIENT = { displayName: "", displayNameKana: "", birthDate: "", sex: "unknown", primaryPatientNumber: "" };

export function HomeWorkspace() {
  const api = useEyeApi();
  const router = useRouter();
  const [date, setDate] = useState(todayIso());
  const [encounters, setEncounters] = useState([]);
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState([]);
  const [context, setContext] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [draft, setDraft] = useState(EMPTY_PATIENT);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch((nextError) => setError(nextError.message));
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api(`/v1/eye/encounters?date=${date}`)
      .then((payload) => { if (!cancelled) setEncounters(payload.encounters); })
      .catch((nextError) => { if (!cancelled) setError(nextError.message); });
    return () => { cancelled = true; };
  }, [api, date]);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      api("/v1/eye/patients/search", { method: "POST", body: { q: query.trim() } })
        .then((payload) => { if (!cancelled) setPatients(payload.patients); })
        .catch((nextError) => { if (!cancelled) setError(nextError.message); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, query]);

  async function registerPatient(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/patients", { method: "POST", body: draft });
      router.push(`/patients/${payload.patient.patientId}`);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  return (
    <main className="eye-page">
      <header className="page-head">
        <div>
          <h1>受診一覧</h1>
          <p className="page-sub">{context ? `${context.displayName}（${roleLabel(context)}）` : " "}</p>
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      <div className="home-grid">
        <section className="panel" aria-labelledby="today-heading">
          <div className="panel-head">
            <h2 id="today-heading">{date === todayIso() ? "本日の受診" : `${formatDate(date)} の受診`}</h2>
            <div className="date-nav">
              <button className="btn btn-ghost" onClick={() => setDate(addDays(date, -1))} type="button" aria-label="前日">‹</button>
              <input aria-label="受診日" className="input input-date" onChange={(event) => setDate(event.target.value || todayIso())} type="date" value={date} />
              <button className="btn btn-ghost" onClick={() => setDate(addDays(date, 1))} type="button" aria-label="翌日">›</button>
              {date !== todayIso() ? <button className="btn btn-ghost" onClick={() => setDate(todayIso())} type="button">今日</button> : null}
            </div>
          </div>
          {encounters.length === 0 ? (
            <p className="empty">この日のカルテはまだありません。右の患者検索から患者を開き、カルテを作成してください。</p>
          ) : (
            <ul className="encounter-list">
              {encounters.map((encounter) => (
                <li key={encounter.encounterId}>
                  <a className="encounter-row" href={`/encounters/${encounter.encounterId}`}>
                    <span className="encounter-name">
                      <strong>{encounter.patientSnapshot?.displayName}</strong>
                      <span className="muted">{encounter.patientSnapshot?.displayNameKana}</span>
                    </span>
                    <span className="encounter-meta">
                      <span className="tag">{VISIT_TYPE_LABELS[encounter.visitType]}</span>
                      <StatusTag encounter={encounter} />
                    </span>
                    <span className="encounter-dx muted">{encounter.diagnoses.map(diagnosisText).join("、") || encounter.chiefComplaint || "—"}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="patients-heading">
          <div className="panel-head">
            <h2 id="patients-heading">患者</h2>
            {context?.canRegisterPatients ? (
              <button className="btn btn-primary" onClick={() => { setDraft(EMPTY_PATIENT); setRegistering(true); }} type="button">新規患者を登録</button>
            ) : null}
          </div>
          <input
            aria-label="患者検索"
            autoFocus
            className="input input-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="氏名・カナ・患者番号で検索"
            type="search"
            value={query}
          />
          <ul className="patient-list">
            {patients.map((patient) => (
              <li key={patient.patientId}>
                <a className="patient-row" href={`/patients/${patient.patientId}`}>
                  <strong>{patient.displayName}</strong>
                  <span className="muted">{patient.displayNameKana}</span>
                  <span className="muted small">{patientLine(patient)}</span>
                </a>
              </li>
            ))}
            {patients.length === 0 ? <li className="empty">該当する患者がいません。</li> : null}
          </ul>
        </section>
      </div>

      {registering ? (
        <div className="dialog-backdrop" role="presentation">
          <form aria-labelledby="register-heading" className="dialog" onSubmit={registerPatient} role="dialog">
            <h2 id="register-heading">新規患者を登録</h2>
            <label className="field">
              <span>氏名 <em>必須</em></span>
              <input autoFocus className="input" onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} required value={draft.displayName} />
            </label>
            <label className="field">
              <span>フリガナ</span>
              <input className="input" onChange={(event) => setDraft({ ...draft, displayNameKana: event.target.value })} value={draft.displayNameKana} />
            </label>
            <div className="field-row">
              <label className="field">
                <span>生年月日</span>
                <input className="input" onChange={(event) => setDraft({ ...draft, birthDate: event.target.value })} type="date" value={draft.birthDate} />
              </label>
              <label className="field">
                <span>性別</span>
                <select className="input" onChange={(event) => setDraft({ ...draft, sex: event.target.value })} value={draft.sex}>
                  <option value="unknown">未設定</option>
                  <option value="male">男</option>
                  <option value="female">女</option>
                  <option value="other">その他</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>患者番号（カルテ番号）</span>
              <input className="input" onChange={(event) => setDraft({ ...draft, primaryPatientNumber: event.target.value })} value={draft.primaryPatientNumber} />
            </label>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => setRegistering(false)} type="button">キャンセル</button>
              <button className="btn btn-primary" disabled={busy || !draft.displayName.trim()} type="submit">登録してカルテを開く</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

export function StatusTag({ encounter }) {
  if (encounter.status === "finalized") return <span className="tag tag-ok">確定 v{encounter.versionCount}</span>;
  if (encounter.amending) return <span className="tag tag-warn">修正中</span>;
  return <span className="tag tag-draft">下書き</span>;
}

function roleLabel(context) {
  const labels = { admin: "管理者", doctor: "医師", orthoptist: "視能訓練士", nurse: "看護師", medical_clerk: "医療事務", viewer: "閲覧" };
  return (context.eyeRoles || []).map((role) => labels[role] || role).join("・") || "権限なし";
}
