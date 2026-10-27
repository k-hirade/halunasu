"use client";

import { useCallback, useEffect, useState } from "react";
import { useEyeApi, useEyeFileTransfer } from "./eye-api";
import { addDays, formatDate, formatDateTime, todayIso, VISIT_TYPE_LABELS } from "../lib/format";

const EYE = { od: "右", os: "左", ou: "両" };
const STATE_LABELS = { pending: "未連携", handed_off: "連携済み", changed: "再連携が必要" };

// 会計連携。確定済みカルテの実施内容を、レセコンに渡す CSV と会計連絡票にする。
export function BillingWorkspace() {
  const api = useEyeApi();
  const transfer = useEyeFileTransfer();
  const [date, setDate] = useState(todayIso());
  const [day, setDay] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const payload = await api(`/v1/eye/billing/day?date=${date}`);
    setDay(payload);
    setSelected(new Set(payload.encounters.filter((item) => item.handoff.state !== "handed_off").map((item) => item.encounterId)));
  }, [api, date]);

  useEffect(() => {
    setDay(null);
    load().catch((nextError) => setError(nextError.message));
  }, [load]);

  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handoff() {
    setBusy(true);
    setError("");
    try {
      const payload = await api("/v1/eye/billing/handoffs", { method: "POST", body: { date, encounterIds: [...selected] } });
      download(payload.csv, `eye-billing-${date}-${payload.handoff.handoffId.slice(-6)}.csv`);
      setNotice(`${payload.handoff.encounters.length}件を連携済みにし、CSV を保存しました。`);
      await load();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadAll() {
    try {
      const response = await transfer(`v1/eye/billing/day.csv?date=${date}`);
      download(await response.text(), `eye-billing-${date}-all.csv`);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const toggle = (encounterId) => {
    const next = new Set(selected);
    if (next.has(encounterId)) next.delete(encounterId);
    else next.add(encounterId);
    setSelected(next);
  };

  return (
    <main className="eye-page billing-page">
      <header className="page-head no-print">
        <div>
          <h1>会計連携</h1>
          <p className="page-sub">確定済みカルテの「実施した検査・処置」「今回出した処方」「発行した文書」を、レセコンへ渡す CSV と会計連絡票にします。点数の計算はレセコンで行います。</p>
        </div>
        <div className="head-actions">
          <div className="date-nav">
            <button aria-label="前日" className="btn btn-ghost" onClick={() => setDate(addDays(date, -1))} type="button">‹</button>
            <input aria-label="日付" className="input input-date" onChange={(event) => setDate(event.target.value || todayIso())} type="date" value={date} />
            <button aria-label="翌日" className="btn btn-ghost" onClick={() => setDate(addDays(date, 1))} type="button">›</button>
          </div>
        </div>
      </header>
      {error ? <p className="alert alert-danger no-print" role="alert">{error}</p> : null}
      {notice ? <p className="alert alert-ok no-print" role="status">{notice}</p> : null}
      {!day ? <p className="loading">読み込み中…</p> : (
        <>
          {day.drafts.length ? (
            <p className="alert alert-warn no-print">未確定のカルテが {day.drafts.length}件あります（{day.drafts.map((item) => item.patientSnapshot?.displayName).join("、")}）。確定すると連携の対象になります。</p>
          ) : null}
          <div className="billing-actions no-print">
            <button className="btn btn-primary" disabled={busy || selected.size === 0} onClick={handoff} type="button">選択した{selected.size}件を CSV 出力して連携済みにする</button>
            <button className="btn btn-ghost" disabled={!day.encounters.length} onClick={downloadAll} type="button">この日のすべてを CSV で再出力</button>
            <button className="btn btn-ghost" disabled={!day.encounters.length} onClick={() => window.print()} type="button">会計連絡票を印刷</button>
          </div>
          {day.encounters.length === 0 ? <p className="empty">この日の確定済みカルテはありません。</p> : (
            <div className="billing-list">
              {day.encounters.map((item) => (
                <article className={`billing-card is-${item.handoff.state}`} key={item.encounterId}>
                  <header className="billing-card-head">
                    <label className="check-line no-print">
                      <input checked={selected.has(item.encounterId)} onChange={() => toggle(item.encounterId)} type="checkbox" />
                      <span className="sr-only">連携の対象にする</span>
                    </label>
                    <strong>{item.patient.displayName}</strong>
                    <span className="muted small">No.{item.patient.primaryPatientNumber || "—"} ・ {VISIT_TYPE_LABELS[item.visitType]} ・ カルテ v{item.version}</span>
                    <span className={`tag billing-state-${item.handoff.state}`}>{STATE_LABELS[item.handoff.state]}</span>
                    {item.handoff.at ? <span className="muted small no-print">{formatDateTime(item.handoff.at)} {item.handoff.by?.displayName}</span> : null}
                  </header>
                  {item.diagnoses.length ? <p className="small">病名: {item.diagnoses.map((dx) => `${EYE[dx.eye] || ""}${dx.name}`).join("、")}</p> : null}
                  {item.items.length === 0 ? <p className="muted small">実施した検査・処置、処方、文書はありません（受診のみ）。</p> : (
                    <table className="data-table billing-items">
                      <thead><tr><th>区分</th><th>名称</th><th>眼</th><th>数量</th><th>日数</th><th>院内外</th><th>用法・備考</th></tr></thead>
                      <tbody>
                        {item.items.map((row, index) => (
                          <tr key={index}>
                            <td>{row.category}</td>
                            <td>{row.name}</td>
                            <td>{EYE[row.eye] || ""}</td>
                            <td>{row.quantity ?? ""}{row.quantity !== null && row.quantity !== undefined ? row.unit : ""}</td>
                            <td>{row.days ?? ""}</td>
                            <td>{row.route}</td>
                            <td className="small">{[row.usage, row.note].filter(Boolean).join(" ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </article>
              ))}
            </div>
          )}
          {day.handoffs.length ? (
            <section className="panel no-print">
              <h2>この日の連携履歴</h2>
              <ul className="plain">
                {day.handoffs.map((item) => (
                  <li key={item.handoffId}>{formatDateTime(item.createdAt)} {item.createdBy?.displayName} ・ {item.encounters.length}件 <span className="muted small mono">{item.csvSha256.slice(0, 12)}</span></li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="print-only small">会計連絡票 {formatDate(date)}</p>
        </>
      )}
    </main>
  );
}
