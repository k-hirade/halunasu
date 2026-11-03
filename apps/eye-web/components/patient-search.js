"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseBirthDateQuery } from "@halunasu/eye-contracts";
import { useEyeApi } from "./eye-api";
import { patientBirthLine } from "../lib/format";

const SHOWN = 10;

// ヘッダーの患者検索。どの画面からでも「/」で入力でき、↑↓ と Enter で患者を開く。
// 氏名・カナ（ひらがなでも可）・名だけ・患者番号・生年月日（1950/3/4、S25.3.4 など）で探せる。
// onRegister を渡すと、結果の下に「新規患者を登録」を出す（入力した語を登録欄に入れて開く）。
export function PatientSearch({ onNavigate, onRegister }) {
  const api = useEyeApi();
  const router = useRouter();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState({ query: null, patients: [] });
  const [active, setActive] = useState(0);

  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      // 日本語入力モードでは「/」が「・」になる環境があるので、キーの位置（Slash）も見る
      if ((event.key === "/" || event.code === "Slash") && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const trimmed = query.trim();
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const birthDate = parseBirthDateQuery(trimmed);
    const handle = setTimeout(() => {
      api("/v1/eye/patients/search", { method: "POST", body: birthDate ? { q: "", birthDate } : { q: trimmed } })
        .then((payload) => {
          if (cancelled) return;
          setResult({ query: trimmed, patients: rankPatients(payload.patients, trimmed) });
          setActive(0);
        })
        .catch(() => { if (!cancelled) setResult({ query: trimmed, patients: [] }); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, open, trimmed]);

  const loading = open && result.query !== trimmed;
  const patients = result.patients.slice(0, SHOWN);
  const more = result.patients.length - patients.length;

  function close() {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    onNavigate?.();
  }

  function go(patient) {
    close();
    router.push(`/patients/${patient.patientId}`);
  }

  function register() {
    const text = trimmed;
    close();
    const birthDate = parseBirthDateQuery(text);
    if (birthDate) onRegister({ birthDate });
    else if (/^[\p{Script=Hiragana}\p{Script=Katakana}ー\s]+$/u.test(text)) onRegister({ displayNameKana: text });
    else if (/^[0-9A-Za-z-]+$/u.test(text)) onRegister({ primaryPatientNumber: text });
    else onRegister({ displayName: text });
  }

  function onKeyDown(event) {
    // 日本語入力の変換確定の Enter・↑↓ では動かない（別の患者を開く事故を防ぐ）
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(patients.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!loading && patients[active]) go(patients[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  return (
    <div className="nav-search" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <input
        aria-activedescendant={open && patients[active] ? `nav-search-option-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls="nav-search-results"
        aria-expanded={open}
        aria-label="患者検索"
        autoComplete="off"
        className="input nav-search-input"
        enterKeyHint="search"
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="患者検索（氏名・カナ・番号・生年月日）"
        ref={inputRef}
        role="combobox"
        type="search"
        value={query}
      />
      <kbd className="nav-search-key" aria-hidden="true">/</kbd>
      {open ? (
        // 押した瞬間に入力欄からフォーカスが外れて一覧が閉じないよう、mousedown の既定動作を止める
        <div className="nav-search-panel" onMouseDown={(event) => event.preventDefault()}>
          <p className="nav-search-caption">
            {trimmed ? (parseBirthDateQuery(trimmed) ? "生年月日で検索" : "氏名・カナ・番号で検索") : "最近更新された患者"}
            {loading ? <span className="muted"> ・ 検索中…</span> : null}
          </p>
          <ul aria-label="患者の候補" className="nav-search-results" id="nav-search-results" role="listbox">
            {patients.map((patient, index) => (
              <li aria-selected={index === active} id={`nav-search-option-${index}`} key={patient.patientId} role="option">
                <button
                  className={`patient-row${index === active ? " is-active" : ""}`}
                  onClick={() => go(patient)}
                  onMouseEnter={() => setActive(index)}
                  tabIndex={-1}
                  type="button"
                >
                  <span className="patient-row-number mono">{patient.primaryPatientNumber || "—"}</span>
                  <strong className="patient-row-name">{patient.displayName}</strong>
                  <span className="patient-row-kana">{patient.displayNameKana}</span>
                  <span className="patient-row-birth">{patientBirthLine(patient)}</span>
                </button>
              </li>
            ))}
            {!loading && patients.length === 0 ? (
              <li className="empty nav-search-empty">{trimmed ? "該当する患者がいません。" : "患者が登録されていません。"}</li>
            ) : null}
          </ul>
          {more > 0 ? <p className="nav-search-more muted small">ほか {more}件以上。生年月日や番号を足して絞ってください。</p> : null}
          {onRegister ? (
            <button className="nav-search-register" onClick={register} tabIndex={-1} type="button">
              ＋ {trimmed ? `「${trimmed}」で新規患者を登録` : "新規患者を登録"}
            </button>
          ) : null}
          <p className="nav-search-hint muted" aria-hidden="true">↑↓ 選択　Enter 開く　Esc 閉じる</p>
        </div>
      ) : null}
    </div>
  );
}

// 英数字だけの入力は患者番号とみなし、番号の完全一致 → 前方一致 → その他の順にする
function rankPatients(patients = [], query = "") {
  if (!/^[0-9A-Za-z-]+$/u.test(query)) return patients;
  const target = query.toLowerCase();
  const rank = (patient) => {
    const number = String(patient.primaryPatientNumber || "").toLowerCase();
    if (number === target) return 0;
    if (number.startsWith(target)) return 1;
    return 2;
  };
  return patients.map((patient, index) => ({ patient, index })).sort((left, right) => rank(left.patient) - rank(right.patient) || left.index - right.index).map((item) => item.patient);
}
