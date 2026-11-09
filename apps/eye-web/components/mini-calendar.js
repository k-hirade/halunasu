"use client";

import { useEffect, useRef, useState } from "react";
import { eraYearLabel } from "@halunasu/eye-contracts";
import { addDays, todayIso } from "../lib/format";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 月の小さなカレンダー（受付の日付ボタン・予約状況の左）。見出しは「2026(令和8)年11月」。
// counts（日付 → 件数）を渡すと各日に件数を出す。週は日曜始まり（デジカルと同じ）。
export function MiniCalendar({ month, selected, onSelect, onMonthChange, counts = null, highlightWeekOf = "", label = "日付を選ぶ" }) {
  const today = todayIso();
  const first = `${month}-01`;
  const start = addDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay());
  const weekStart = highlightWeekOf ? addDays(highlightWeekOf, -new Date(`${highlightWeekOf}T00:00:00Z`).getUTCDay()) : "";
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  const [year, monthNumber] = month.split("-").map(Number);
  return (
    <div className="mcal" role="group" aria-label={label}>
      <div className="mcal-head">
        <button aria-label="前の月" className="btn btn-ghost btn-sm" onClick={() => onMonthChange(shiftMonth(month, -1))} type="button">‹</button>
        <strong className="mcal-title">{year}({eraYearLabel(first).replace(/年$/u, "")})年{monthNumber}月</strong>
        <button aria-label="次の月" className="btn btn-ghost btn-sm" onClick={() => onMonthChange(shiftMonth(month, 1))} type="button">›</button>
      </div>
      <div className="mcal-grid">
        {WEEKDAYS.map((weekday, index) => <span className={`mcal-weekday${index === 0 ? " is-sun" : index === 6 ? " is-sat" : ""}`} key={weekday}>{weekday}</span>)}
        {days.map((day) => {
          const inMonth = day.startsWith(month);
          const count = counts?.[day] || 0;
          const inWeek = weekStart && day >= weekStart && day <= addDays(weekStart, 6);
          const classes = ["mcal-day", inMonth ? "" : "is-outside", day === today ? "is-today" : "", day === selected ? "is-selected" : "", inWeek ? "is-week" : ""].filter(Boolean).join(" ");
          return (
            <button
              aria-current={day === today ? "date" : undefined}
              aria-label={`${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日${counts ? ` 予約${count}件` : ""}`}
              aria-pressed={day === selected}
              className={classes}
              key={day}
              onClick={() => onSelect(day)}
              type="button"
            >
              <span>{Number(day.slice(8, 10))}</span>
              {counts && count ? <small className="mcal-count">{count}件</small> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 日付ナビ: ‹ ［日付ボタン（押すと月のカレンダー）］ ›。デジカルの受付画面の 2 行目と同じ並び。
export function DateNav({ date, onChange }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(date.slice(0, 7));
  const ref = useRef(null);
  useEffect(() => { setMonth(date.slice(0, 7)); }, [date]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const pick = (value) => { onChange(value); setOpen(false); };
  return (
    <div className="date-nav rc-date-nav" ref={ref}>
      <button aria-label="前日" className="btn btn-ghost" onClick={() => onChange(addDays(date, -1))} type="button">‹</button>
      <button aria-expanded={open} aria-haspopup="dialog" aria-label={`日付 ${formatDayButton(date)}（押すとカレンダー）`} className="btn btn-ghost rc-date-button" onClick={() => setOpen(!open)} type="button">
        {formatDayButton(date)}
      </button>
      <button aria-label="翌日" className="btn btn-ghost" onClick={() => onChange(addDays(date, 1))} type="button">›</button>
      {open ? (
        <div className="rc-popover rc-date-popover" role="dialog" aria-label="日付を選ぶ">
          <MiniCalendar month={month} onMonthChange={setMonth} onSelect={pick} selected={date} />
          <div className="rc-popover-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => pick(todayIso())} type="button">今日</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} type="button">閉じる</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

// 「2026/11/09 (月)」
export function formatDayButton(iso) {
  return `${iso.replaceAll("-", "/")} (${WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]})`;
}

export function weekdayOf(iso) {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}
