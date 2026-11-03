"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { patientLine } from "../lib/format";

// ヘッダーの患者検索。どの画面からでも「/」で入力でき、↑↓ と Enter で患者を開く。
export function PatientSearch({ onNavigate }) {
  const api = useEyeApi();
  const router = useRouter();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [patients, setPatients] = useState([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const handle = setTimeout(() => {
      api("/v1/eye/patients/search", { method: "POST", body: { q: query.trim() } })
        .then((payload) => {
          if (cancelled) return;
          setPatients(payload.patients.slice(0, 8));
          setActive(0);
        })
        .catch(() => { if (!cancelled) setPatients([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, open, query]);

  function go(patient) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    onNavigate?.();
    router.push(`/patients/${patient.patientId}`);
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, patients.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && patients[active]) {
      event.preventDefault();
      go(patients[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  return (
    <div className="nav-search" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <input
        aria-autocomplete="list"
        aria-controls="nav-search-results"
        aria-expanded={open}
        aria-label="患者検索"
        className="input nav-search-input"
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="患者を検索（氏名・カナ・患者番号）"
        ref={inputRef}
        role="combobox"
        type="search"
        value={query}
      />
      <kbd className="nav-search-key" aria-hidden="true">/</kbd>
      {open ? (
        <ul className="nav-search-results" id="nav-search-results" role="listbox">
          {patients.map((patient, index) => (
            <li aria-selected={index === active} key={patient.patientId} role="option">
              <button
                className={`patient-row${index === active ? " is-active" : ""}`}
                onClick={() => go(patient)}
                onMouseEnter={() => setActive(index)}
                tabIndex={-1}
                type="button"
              >
                <strong>{patient.displayName}</strong>
                <span className="muted">{patient.displayNameKana}</span>
                <span className="muted small">{patientLine(patient)}</span>
              </button>
            </li>
          ))}
          {patients.length === 0 ? <li className="empty nav-search-empty">{query.trim() ? "該当する患者がいません。" : "患者が登録されていません。"}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
