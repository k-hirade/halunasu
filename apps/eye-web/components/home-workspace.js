"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { addDays, APPOINTMENT_PURPOSE_LABELS, APPOINTMENT_STATUS_LABELS, diagnosisText, formatDate, todayIso, VISIT_TYPE_LABELS } from "../lib/format";

const EMPTY_PATIENT = { displayName: "", displayNameKana: "", birthDate: "", sex: "unknown", primaryPatientNumber: "" };

export function HomeWorkspace() {
  const api = useEyeApi();
  const router = useRouter();
  const [date, setDate] = useState(todayIso());
  const [encounters, setEncounters] = useState([]);
  const [appointments, setAppointments] = useState([]);
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
    Promise.all([api(`/v1/eye/encounters?date=${date}`), api(`/v1/eye/appointments?date=${date}`)])
      .then(([encounterPayload, appointmentPayload]) => {
        if (cancelled) return;
        setEncounters(encounterPayload.encounters);
        setAppointments(appointmentPayload.appointments);
      })
      .catch((nextError) => { if (!cancelled) setError(nextError.message); });
    return () => { cancelled = true; };
  }, [api, date]);

  // 受付（予約・来院）とカルテを 1 つの一覧にする。予約のない患者のカルテも末尾に出す。
  const encounterByPatient = new Map(encounters.map((encounter) => [encounter.patientId, encounter]));
  const rows = [
    ...appointments
      .filter((item) => !["cancelled", "no_show"].includes(item.status))
      .map((item) => {
        const encounter = item.patientId ? encounterByPatient.get(item.patientId) : null;
        return {
          key: item.appointmentId,
          slot: item.queueNumber ? `#${item.queueNumber}` : item.time || "—",
          name: item.patientName,
          kana: item.patientSnapshot?.displayNameKana || "",
          appointmentStatus: item.status,
          encounter,
          href: encounter ? `/encounters/${encounter.encounterId}` : item.patientId ? `/patients/${item.patientId}` : "/reception",
          detail: encounter ? (encounter.diagnoses.map(diagnosisText).join("、") || encounter.chiefComplaint || APPOINTMENT_PURPOSE_LABELS[item.purpose]) : [APPOINTMENT_PURPOSE_LABELS[item.purpose], item.note].filter(Boolean).join(" ・ ")
        };
      }),
    ...encounters
      .filter((encounter) => !appointments.some((item) => item.patientId === encounter.patientId))
      .map((encounter) => ({
        key: encounter.encounterId,
        slot: "—",
        name: encounter.patientSnapshot?.displayName,
        kana: encounter.patientSnapshot?.displayNameKana,
        appointmentStatus: "",
        encounter,
        href: `/encounters/${encounter.encounterId}`,
        detail: encounter.diagnoses.map(diagnosisText).join("、") || encounter.chiefComplaint || VISIT_TYPE_LABELS[encounter.visitType]
      }))
  ];

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
          <h1>{date === todayIso() ? "本日の患者" : `${formatDate(date)} の患者`} <span className="count">{rows.length}</span></h1>
          <p className="page-sub">{context ? userLine(context) : " "}</p>
        </div>
        <div className="head-actions">
          <div className="date-nav">
            <button className="btn btn-ghost" onClick={() => setDate(addDays(date, -1))} type="button" aria-label="前日">‹</button>
            <input aria-label="受診日" className="input input-date" onChange={(event) => setDate(event.target.value || todayIso())} type="date" value={date} />
            <button className="btn btn-ghost" onClick={() => setDate(addDays(date, 1))} type="button" aria-label="翌日">›</button>
            {date !== todayIso() ? <button className="btn btn-ghost" onClick={() => setDate(todayIso())} type="button">今日</button> : null}
          </div>
          {context?.canRegisterPatients ? (
            <button className="btn btn-primary" onClick={() => { setDraft(EMPTY_PATIENT); setRegistering(true); }} type="button">新規患者を登録</button>
          ) : null}
        </div>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}

      <section className="panel list-panel" aria-label="本日の患者">
        {rows.length === 0 ? (
          <div className="empty-state">
            <p><strong>この日の予約・カルテはまだありません。</strong></p>
            <p className="muted small">受付で当日受付するか、画面上部の検索（<kbd>/</kbd> キー）から患者を開いてカルテを作成します。</p>
          </div>
        ) : (
          <ul className="encounter-list">
            {rows.map((row) => (
              <li key={row.key}>
                <Link className="encounter-row" href={row.href}>
                  <span className="encounter-name">
                    <span className="encounter-slot mono">{row.slot}</span>
                    <strong>{row.name}</strong>
                    <span className="muted">{row.kana}</span>
                  </span>
                  <span className="encounter-meta">
                    {row.appointmentStatus ? <span className={`tag appointment-${row.appointmentStatus}`}>{APPOINTMENT_STATUS_LABELS[row.appointmentStatus]}</span> : null}
                    {row.encounter ? <StatusTag encounter={row.encounter} /> : <span className="tag">カルテ未作成</span>}
                  </span>
                  <span className="encounter-dx muted">{row.detail}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

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

// 表示名に役割がすでに含まれている（デモ利用者など）ときは重ねて出さない。
function userLine(context) {
  const role = roleLabel(context);
  return context.displayName.includes(role) ? context.displayName : `${context.displayName}（${role}）`;
}

function roleLabel(context) {
  const labels = { admin: "管理者", doctor: "医師", orthoptist: "視能訓練士", nurse: "看護師", medical_clerk: "医療事務", viewer: "閲覧" };
  return (context.eyeRoles || []).map((role) => labels[role] || role).join("・") || "権限なし";
}
