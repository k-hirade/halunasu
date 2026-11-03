"use client";

import { useEffect, useMemo, useState } from "react";
import {
  documentAllergyText,
  documentDiagnoses,
  documentDiagnosisText,
  documentFindingLines,
  documentHistoryText,
  documentIopLine,
  documentVaLine,
  prescriptionLabel
} from "@halunasu/eye-core";
import { useEyeApi } from "./eye-api";
import { formatDate, todayIso } from "../lib/format";

// 「カルテから挿入」。元にするカルテの日付を選び、項目を選んで本文のカーソル位置に入れる。
// 既にある本文は書き換えない（追記だけ）。カルテが後で変わっても、入れた文は変わらない。
export function DocumentInsertPanel({ patientId, sourceEncounterId = "", onInsert, onClose }) {
  const api = useEyeApi();
  const [encounters, setEncounters] = useState(null);
  const [phrases, setPhrases] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [abnormalOnly, setAbnormalOnly] = useState(true);
  const [withHeadings, setWithHeadings] = useState(true);
  const [checked, setChecked] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([api(`/v1/eye/patients/${patientId}/chart`), api("/v1/eye/bootstrap").catch(() => ({ phrases: [] }))])
      .then(([chart, bootstrap]) => {
        if (!active) return;
        const list = chart.encounters || [];
        setEncounters(list);
        setPhrases((bootstrap.phrases || []).filter((item) => item.active !== false));
        setSelectedId(defaultEncounterId(list, sourceEncounterId));
      })
      .catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [api, patientId, sourceEncounterId]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return undefined; }
    let active = true;
    setDetail(null);
    api(`/v1/eye/encounters/${selectedId}`)
      .then((payload) => active && setDetail({ encounter: payload.encounter, profile: payload.profile }))
      .catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [api, selectedId]);

  const groups = useMemo(() => buildGroups(detail, { abnormalOnly, phrases }), [detail, abnormalOnly, phrases]);

  // 既定で選ぶ項目（病名・検査・所見・処方）。カルテや「異常のみ」を切り替えたら選び直す。
  useEffect(() => {
    const next = {};
    for (const group of groups) for (const item of group.items) next[item.id] = item.defaultOn;
    setChecked(next);
  }, [groups]);

  const selectedCount = groups.reduce((sum, group) => sum + group.items.filter((item) => checked[item.id]).length, 0);
  const selected = encounters?.find((item) => item.encounterId === selectedId);

  function insert() {
    const blocks = groups
      .map((group) => {
        const lines = group.items.filter((item) => checked[item.id]).map((item) => item.text);
        if (!lines.length) return "";
        return [withHeadings && group.heading ? group.heading : "", ...lines].filter(Boolean).join("\n");
      })
      .filter(Boolean);
    if (blocks.length) onInsert(blocks.join("\n\n"));
  }

  return (
    <section aria-labelledby="doc-insert-heading" className="doc-insert" role="dialog">
      <header className="doc-insert-head">
        <h2 id="doc-insert-heading">カルテから挿入</h2>
        <button aria-label="閉じる" className="btn btn-chip" onClick={onClose} type="button">×</button>
      </header>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {encounters === null && !error ? <p className="loading">読み込み中…</p> : null}
      {encounters && !encounters.length ? <p className="empty">この患者のカルテはまだありません。</p> : null}
      {encounters?.length ? (
        <>
          <label className="field doc-insert-source">
            <span>元のカルテ</span>
            <select className="input" onChange={(event) => setSelectedId(event.target.value)} value={selectedId}>
              {encounters.map((item) => (
                <option key={item.encounterId} value={item.encounterId}>
                  {formatDate(item.encounterDate)}（{item.status === "finalized" ? "確定" : item.amending ? "修正中" : "下書き"}）
                </option>
              ))}
            </select>
          </label>
          {selected && selected.status !== "finalized" ? (
            <p className="doc-insert-note">確定前のカルテです。カルテを直した場合は、入れた文も見直してください。</p>
          ) : null}
          <div className="doc-insert-options">
            <label className="check"><input checked={withHeadings} onChange={(event) => setWithHeadings(event.target.checked)} type="checkbox" /> 【見出し】を付ける</label>
            <span aria-label="所見" className="doc-insert-seg" role="group">
              <button aria-pressed={abnormalOnly} className="btn btn-chip" onClick={() => setAbnormalOnly(true)} type="button">所見は異常のみ</button>
              <button aria-pressed={!abnormalOnly} className="btn btn-chip" onClick={() => setAbnormalOnly(false)} type="button">すべて</button>
            </span>
          </div>
          {!detail && selectedId ? <p className="loading">読み込み中…</p> : null}
          {detail ? (
            <div className="doc-insert-groups">
              {groups.map((group) => (
                <fieldset className="doc-insert-group" key={group.key}>
                  <legend>{group.label}</legend>
                  {group.items.map((item) => (
                    <label className="doc-insert-item" key={item.id}>
                      <input checked={Boolean(checked[item.id])} onChange={(event) => setChecked((current) => ({ ...current, [item.id]: event.target.checked }))} type="checkbox" />
                      <span>{item.label || item.text}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
              {!groups.length ? <p className="empty">このカルテには差し込める内容がありません。</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
      <footer className="doc-insert-foot">
        <button className="btn btn-ghost" onClick={onClose} type="button">閉じる</button>
        <button className="btn btn-primary" disabled={!selectedCount} onClick={insert} type="button">選んだ {selectedCount} 件をカーソル位置に挿入</button>
      </footer>
    </section>
  );
}

function defaultEncounterId(list, sourceEncounterId) {
  const today = todayIso();
  const todays = list.find((item) => item.encounterDate === today);
  if (todays) return todays.encounterId;
  if (sourceEncounterId && list.some((item) => item.encounterId === sourceEncounterId)) return sourceEncounterId;
  return (list.find((item) => item.status === "finalized") || list[0])?.encounterId || "";
}

function buildGroups(detail, { abnormalOnly, phrases }) {
  if (!detail) return [];
  const { encounter, profile } = detail;
  const content = encounter.content || {};
  const exam = content.exam || {};
  const groups = [];
  const add = (key, label, heading, items) => {
    const kept = items.filter((item) => item && String(item.text || "").trim());
    if (kept.length) groups.push({ key, label, heading, items: kept });
  };
  add("diagnoses", "傷病名", "【傷病名】", documentDiagnoses(profile, content).map((item, index) => ({
    id: `dx-${index}`, text: `・${documentDiagnosisText(item)}`, label: documentDiagnosisText(item), defaultOn: true
  })));
  const hasVa = ["od", "os"].some((side) => exam[side]?.vaUncorrected || exam[side]?.vaCorrected);
  const hasIop = ["od", "os"].some((side) => Number.isFinite(exam[side]?.iop));
  add("exam", abnormalOnly ? "検査・所見（所見は異常のみ）" : "検査・所見（すべて）", `【検査所見】（${encounter.encounterDate}）`, [
    hasVa ? { id: "va", text: documentVaLine(exam), defaultOn: true } : null,
    hasIop ? { id: "iop", text: documentIopLine(exam), defaultOn: true } : null,
    ...documentFindingLines(content.findings, { abnormalOnly }).map((item) => ({ id: `f-${item.side}-${item.key}`, text: item.text, defaultOn: true }))
  ]);
  add("prescriptions", "処方", "【現在の処方】", (content.prescriptions || []).filter((item) => item.name).map((item, index) => ({
    id: `rx-${index}`, text: `・${prescriptionLabel(item)}`, label: prescriptionLabel(item), defaultOn: true
  })));
  add("course", "主訴・経過", "【現病歴・経過】", [
    content.chiefComplaint ? { id: "cc", text: content.chiefComplaint, label: `主訴: ${content.chiefComplaint}`, defaultOn: false } : null,
    content.history ? { id: "hx", text: content.history, label: `経過: ${content.history}`, defaultOn: false } : null
  ]);
  add("plan", "評価・方針", "【評価・方針】", [
    content.assessment ? { id: "assessment", text: content.assessment, label: `評価: ${content.assessment}`, defaultOn: false } : null,
    content.plan ? { id: "plan", text: content.plan, label: `方針: ${content.plan}`, defaultOn: false } : null
  ]);
  add("allergy", "アレルギー・副作用歴", "【アレルギー・副作用歴】", [{ id: "allergy", text: documentAllergyText(profile), defaultOn: false }]);
  add("history", "既往歴", "【既往歴】", [{ id: "pmh", text: documentHistoryText(profile), defaultOn: false }]);
  add("phrases", "定型文", "", (phrases || []).map((item) => ({ id: `ph-${item.phraseId}`, text: item.text, label: item.label ? `${item.label}: ${item.text}` : item.text, defaultOn: false })));
  return groups;
}
