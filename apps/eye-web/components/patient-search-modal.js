"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { parseBirthDateQuery } from "@halunasu/eye-contracts";
import { AppointmentDialog } from "./appointment-dialog";
import { useEyeApi } from "./eye-api";
import { PatientRegisterDialog, RECEPTION_CHANGED_EVENT } from "./patient-register-dialog";
import { ageOn, SEX_LABELS, todayIso } from "../lib/format";
import { birthWithEra } from "../lib/reception-table";
import { rankPatients } from "./patient-search";

// 患者検索のモーダル（デジカルの患者検索）。1 行の入力で番号・カナ・氏名・生年月日を探し、
// 結果の行から［表示］（患者のカルテ）［編集］［受付］［予約］。右上に［新規患者登録］。
// キーボードだけで使える: 開くと入力欄にカーソル、↑↓ で行を選び Enter で開く、Esc で閉じる（日本語入力の確定中は動かない）。
// 傷病名・受診期間・電話番号の条件は検索 API が対応していないので出さない。
export function PatientSearchModal({ initialQuery = "", onClose }) {
  const api = useEyeApi();
  const router = useRouter();
  const pathname = usePathname() || "/";
  const inputRef = useRef(null);
  const [query, setQuery] = useState(initialQuery);
  const [context, setContext] = useState(null);
  const [result, setResult] = useState({ query: null, patients: [], limit: 50, error: "" });
  const [sub, setSub] = useState(null);
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [active, setActive] = useState(0);

  useEffect(() => {
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch(() => setContext(null));
  }, [api]);
  useEffect(() => {
    const opener = document.activeElement;
    inputRef.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape" && !sub) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, sub]);

  const trimmed = query.trim();
  useEffect(() => {
    let cancelled = false;
    const birthDate = parseBirthDateQuery(trimmed);
    const handle = setTimeout(() => {
      api("/v1/eye/patients/search", { method: "POST", body: { ...(birthDate ? { q: "", birthDate } : { q: trimmed }), details: true } })
        .then((payload) => {
          if (cancelled) return;
          setResult({ query: trimmed, patients: rankPatients(payload.patients, trimmed), limit: payload.limit || 50, error: "" });
          setActive(0);
        })
        .catch((error) => { if (!cancelled) setResult({ query: trimmed, patients: [], limit: 50, error: error.message }); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, trimmed, refresh]);

  const loading = result.query !== trimmed;
  const patients = result.patients;

  function show(patient) {
    onClose();
    router.push(`/patients/${patient.patientId}`);
  }

  // 選んだ行が見えるようにスクロールする
  useEffect(() => {
    document.getElementById(`ps-row-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function onKeyDown(event) {
    // 日本語入力の変換確定の Enter・↑↓ では動かない（別の患者を開く事故を防ぐ）
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(patients.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!loading && patients[active]) show(patients[active]);
    }
  }

  function afterReception() {
    window.dispatchEvent(new CustomEvent(RECEPTION_CHANGED_EVENT));
    onClose();
    if (!pathname.startsWith("/reception")) router.push("/reception");
  }

  const canRegister = Boolean(context?.canRegisterPatients);
  const canReceive = Boolean(context?.canReceive);

  let subDialog = null;
  if (sub?.kind === "register") {
    subDialog = (
      <PatientRegisterDialog
        initial={sub.initial}
        onCancel={() => setSub(null)}
        onCreated={(patient) => { setSub(null); setQuery(patient.primaryPatientNumber || patient.displayNameKana || patient.displayName); setNotice(`「${patient.displayName}」を登録しました。`); setRefresh((value) => value + 1); }}
        onPickExisting={(patient) => { setSub(null); setQuery(patient.primaryPatientNumber || patient.displayNameKana || patient.displayName); }}
        onReceived={afterReception}
        pickExistingLabel="この患者を表示"
      />
    );
  } else if (sub?.kind === "edit") {
    subDialog = (
      <PatientRegisterDialog
        onCancel={() => setSub(null)}
        onUpdated={(patient) => { setSub(null); setNotice(`「${patient.displayName}」の患者情報を更新しました。`); setRefresh((value) => value + 1); }}
        patient={sub.patient}
      />
    );
  } else if (sub?.kind === "receive") {
    subDialog = (
      <AppointmentDialog
        fixedPatient={sub.patient}
        initial={{ date: todayIso(), walkIn: true, purpose: "revisit", time: "" }}
        onCancel={() => setSub(null)}
        onSaved={afterReception}
        title="受付登録"
      />
    );
  } else if (sub?.kind === "book") {
    subDialog = (
      <AppointmentDialog
        fixedPatient={sub.patient}
        initial={{ date: todayIso(), walkIn: false, purpose: "revisit", time: "" }}
        onCancel={() => setSub(null)}
        onSaved={(appointment) => { setSub(null); setNotice(`${appointment.date.replaceAll("-", "/")} ${appointment.time || ""} に予約しました。`); window.dispatchEvent(new CustomEvent(RECEPTION_CHANGED_EVENT)); }}
        title="予約登録"
      />
    );
  }

  return createPortal(
    <>
      <div className="dialog-backdrop ps-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !sub) onClose(); }}>
        <div aria-labelledby="ps-heading" aria-modal="true" className="dialog ps-dialog" role="dialog">
          <div className="ps-head">
            <h2 id="ps-heading">患者検索</h2>
            <div className="ps-input">
              <input
                aria-activedescendant={!loading && patients[active] ? `ps-row-${active}` : undefined}
                aria-controls="ps-results"
                aria-expanded={patients.length > 0}
                aria-label="検索する語"
                autoComplete="off"
                className="input"
                enterKeyHint="search"
                onChange={(event) => { setQuery(event.target.value); setNotice(""); }}
                onKeyDown={onKeyDown}
                placeholder="患者番号・フリガナ・氏名・生年月日"
                title="生年月日は 1950/3/4 または S25.3.4 の形で入れます"
                ref={inputRef}
                role="combobox"
                type="search"
                value={query}
              />
              {query ? <button aria-label="入力を消す" className="btn btn-ghost btn-sm" onClick={() => { setQuery(""); inputRef.current?.focus(); }} type="button">×</button> : null}
            </div>
            {canRegister ? (
              <button className="btn btn-primary ps-register" onClick={() => setSub({ kind: "register", initial: registerInitial(trimmed) })} type="button">新規患者登録</button>
            ) : null}
            <button aria-label="閉じる" className="btn btn-ghost ps-close" onClick={onClose} type="button">閉じる</button>
          </div>
          {notice ? <p className="alert alert-ok ps-notice" role="status">{notice}</p> : null}
          {result.error ? <p className="alert alert-danger" role="alert">{result.error}</p> : null}
          <p className="ps-caption muted small" aria-live="polite">
            {loading ? "検索中…" : trimmed ? (patients.length >= result.limit ? `${result.limit}件以上あります。番号・生年月日を足して絞ってください。` : `${patients.length}件`) : "最近更新された患者"}
            <span className="ps-hint">生年月日は 1950/3/4・S25.3.4 の形でも探せます</span>
            <span className="ps-keys" aria-hidden="true">↑↓ 選択　Enter 開く　Esc 閉じる</span>
          </p>
          <div className="ps-table-wrap">
            <table aria-label="検索結果" className="ps-table" id="ps-results" role="grid">
              <thead>
                <tr>
                  <th scope="col">患者番号</th>
                  <th scope="col">フリガナ</th>
                  <th scope="col">名前</th>
                  <th scope="col">性</th>
                  <th scope="col">生年月日</th>
                  <th scope="col">年齢</th>
                  <th scope="col">最終受付日</th>
                  <th scope="col">患者メモ</th>
                  <th scope="col"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {patients.map((patient, index) => {
                  const age = ageOn(patient.birthDate);
                  return (
                    <tr aria-selected={index === active} className={`ps-row${index === active ? " is-active" : ""}`} id={`ps-row-${index}`} key={patient.patientId} onMouseEnter={() => setActive(index)}>
                      <td className="mono" data-label="患者番号">{patient.primaryPatientNumber || "—"}</td>
                      <td className="ps-kana" data-label="フリガナ">{patient.displayNameKana}</td>
                      <td className="ps-name" data-label="名前"><strong>{patient.displayName}</strong></td>
                      <td data-label="性">{patient.sex && patient.sex !== "unknown" ? SEX_LABELS[patient.sex] : ""}</td>
                      <td className="mono" data-label="生年月日">{birthWithEra(patient.birthDate)}</td>
                      <td data-label="年齢">{age === null ? "" : `${age}歳`}</td>
                      <td className="mono" data-label="最終受付日">{patient.lastVisitDate ? patient.lastVisitDate.replaceAll("-", "/") : "初"}</td>
                      <td className="ps-memo" data-label="患者メモ" title={patient.patientMemo || undefined}>{patient.patientMemo}</td>
                      <td className="ps-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => show(patient)} type="button">表示</button>
                        {canRegister ? <button className="btn btn-ghost btn-sm" onClick={() => setSub({ kind: "edit", patient })} type="button">編集</button> : null}
                        {canReceive ? <button className="btn btn-ghost btn-sm" onClick={() => setSub({ kind: "receive", patient })} type="button">受付</button> : null}
                        {canReceive ? <button className="btn btn-ghost btn-sm" onClick={() => setSub({ kind: "book", patient })} type="button">予約</button> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && !result.error && patients.length === 0 ? <p className="empty">{trimmed ? "該当する患者がいません。" : "患者が登録されていません。"}</p> : null}
          </div>
        </div>
      </div>
      {subDialog}
    </>,
    document.body
  );
}

// 入力した語を新規登録の欄に入れる（生年月日・カナ・番号・氏名のどれか）
export function registerInitial(text) {
  if (!text) return {};
  const birthDate = parseBirthDateQuery(text);
  if (birthDate) return { birthDate };
  if (/^[\p{Script=Hiragana}\p{Script=Katakana}ー\s]+$/u.test(text)) return { displayNameKana: text };
  if (/^[0-9A-Za-z-]+$/u.test(text)) return { primaryPatientNumber: text };
  return { displayName: text };
}
