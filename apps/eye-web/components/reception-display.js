"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEyeApi } from "./eye-api";
import { todayIso } from "../lib/format";
import { displayBoard } from "../lib/reception-extras";

const REFRESH_MS = 10000;

// 受付番号の院内掲示: 左に「診察待」、右に「診察中」の受付番号だけを大きく出す（氏名は出さない）。
// 10 秒ごとに読み直す。上の細い帯で診療科の切り替えと全画面。URL をブックマークすればすぐ開ける。
export function ReceptionDisplay() {
  const api = useEyeApi();
  const router = useRouter();
  const params = useSearchParams();
  const department = params.get("department") || "";
  const [state, setState] = useState({ appointments: [], loaded: false, error: "", at: "" });

  const load = useCallback(async () => {
    try {
      const payload = await api(`/v1/eye/appointments?date=${todayIso()}`);
      setState({ appointments: payload.appointments || [], loaded: true, error: "", at: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) });
    } catch (error) {
      setState((current) => ({ ...current, loaded: true, error: error.message }));
    }
  }, [api]);

  useEffect(() => {
    load();
    const handle = setInterval(load, REFRESH_MS);
    return () => clearInterval(handle);
  }, [load]);

  const departments = [...new Set(state.appointments.map((item) => item.department).filter(Boolean))];
  const board = displayBoard(state.appointments, department);

  function fullscreen() {
    const element = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else element.requestFullscreen?.().catch(() => {});
  }

  return (
    <main aria-label="受付番号の院内掲示" className="rcd-board">
      <div className="rcd-bar no-print">
        <a className="btn btn-ghost btn-sm" href="/reception">← 受付</a>
        <label className="rcd-dept">
          <span>診療科</span>
          <select className="input" onChange={(event) => router.replace(event.target.value ? `/reception/display?department=${encodeURIComponent(event.target.value)}` : "/reception/display")} value={department}>
            <option value="">全診療科</option>
            {[...new Set([...departments, ...(department ? [department] : [])])].map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <span className="rcd-updated muted small" aria-live="polite">{state.error ? `読み込めません: ${state.error}` : state.at ? `${state.at} 更新` : "読み込み中…"}</span>
        <button className="btn btn-ghost btn-sm" onClick={fullscreen} type="button">全画面</button>
      </div>
      {department ? <h1 className="rcd-title">{department}</h1> : <h1 className="sr-only">受付番号</h1>}
      <div className="rcd-panels">
        <section aria-labelledby="rcd-waiting" className="rcd-panel is-waiting">
          <h2 id="rcd-waiting">診察をお待ちの方 <span className="rcd-count">{board.waiting.length}人</span></h2>
          <ul className="rcd-numbers">
            {board.waiting.map((number) => <li className="rcd-number" key={number}>{number}</li>)}
          </ul>
          {state.loaded && !board.waiting.length ? <p className="rcd-empty">ありません</p> : null}
        </section>
        <div aria-hidden="true" className="rcd-arrow">›</div>
        <section aria-labelledby="rcd-calling" className="rcd-panel is-calling">
          <h2 id="rcd-calling">診察中 <span className="rcd-count">{board.calling.length}人</span></h2>
          <ul className="rcd-numbers">
            {board.calling.map((number) => <li className="rcd-number" key={number}>{number}</li>)}
          </ul>
          {state.loaded && !board.calling.length ? <p className="rcd-empty">ありません</p> : null}
        </section>
      </div>
    </main>
  );
}
