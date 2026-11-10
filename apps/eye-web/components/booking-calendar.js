"use client";

import { useEffect, useMemo, useState } from "react";
import { useEyeApi } from "./eye-api";
import { MiniCalendar, weekdayOf } from "./mini-calendar";
import { useDoctors } from "./use-doctors";
import { addDays, todayIso } from "../lib/format";

const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 18;

export function weekStartOf(iso) {
  return addDays(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay());
}

// 予約状況（デジカルの予約状況カレンダー）。左に月の小さなカレンダー（日ごとの件数）と医師の切り替え、
// 右に週 × 時間の表（「終日」＝時刻なしの段と 30 分ごとの段）。枠を押すとその日時を onPickSlot(date, time) で返す。
export function BookingCalendar({ date = todayIso(), onPickSlot, onPickDay = null, refreshKey = 0 }) {
  const api = useEyeApi();
  const doctors = useDoctors();
  const [focus, setFocus] = useState(date);
  const [month, setMonth] = useState(date.slice(0, 7));
  const [doctorMemberId, setDoctorMemberId] = useState("");
  // 900px 以下は月のカレンダーをたたみ、週の表を先に見せる（広い画面では常に出す。CSS で切り替える）
  const [monthOpen, setMonthOpen] = useState(false);
  const [monthDays, setMonthDays] = useState({});
  const [week, setWeek] = useState({ days: [], loading: true, error: "" });
  const weekStart = weekStartOf(focus);

  // 月のカレンダーの件数（表示している 6 週 = 42 日を 1 回で引く）
  useEffect(() => {
    const first = `${month}-01`;
    const from = weekStartOf(first);
    const query = new URLSearchParams({ from, to: addDays(from, 41), ...(doctorMemberId ? { doctorMemberId } : {}) });
    let alive = true;
    api(`/v1/eye/appointments/range?${query}`)
      .then((payload) => { if (alive) setMonthDays(Object.fromEntries(payload.days.map((day) => [day.date, day.total]))); })
      .catch(() => { if (alive) setMonthDays({}); });
    return () => { alive = false; };
  }, [api, month, doctorMemberId, refreshKey]);

  useEffect(() => {
    const query = new URLSearchParams({ from: weekStart, to: addDays(weekStart, 6), ...(doctorMemberId ? { doctorMemberId } : {}) });
    let alive = true;
    setWeek((current) => ({ ...current, loading: true, error: "" }));
    api(`/v1/eye/appointments/range?${query}`)
      .then((payload) => { if (alive) setWeek({ days: payload.days, loading: false, error: "" }); })
      .catch((error) => { if (alive) setWeek({ days: [], loading: false, error: error.message }); });
    return () => { alive = false; };
  }, [api, weekStart, doctorMemberId, refreshKey]);

  const hours = useMemo(() => {
    let first = DEFAULT_FIRST_HOUR;
    let last = DEFAULT_LAST_HOUR;
    for (const day of week.days) {
      for (const hour of Object.keys(day.slots || {}).map(Number)) {
        first = Math.min(first, hour);
        last = Math.max(last, hour);
      }
    }
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }, [week.days]);

  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const byDate = new Map(week.days.map((day) => [day.date, day]));
  const today = todayIso();
  const end = addDays(weekStart, 6);
  const title = `${Number(weekStart.slice(0, 4))}年${Number(weekStart.slice(5, 7))}月${Number(weekStart.slice(8, 10))}日 – ${end.slice(0, 7) === weekStart.slice(0, 7) ? "" : `${Number(end.slice(5, 7))}月`}${Number(end.slice(8, 10))}日`;

  function pickDay(value) {
    setFocus(value);
    setMonth(value.slice(0, 7));
    onPickDay?.(value);
  }

  return (
    <div className="bk-cal">
      <aside className={`bk-cal-side${monthOpen ? " is-open" : ""}`}>
        <button aria-expanded={monthOpen} className="btn btn-ghost btn-sm bk-month-toggle" onClick={() => setMonthOpen(!monthOpen)} type="button">
          月のカレンダー {monthOpen ? "▴" : "▾"}
        </button>
        <div className="bk-cal-month">
          <MiniCalendar counts={monthDays} highlightWeekOf={focus} label="予約の件数（月）" month={month} onMonthChange={setMonth} onSelect={pickDay} selected={focus} />
          <button className="btn btn-ghost btn-sm" onClick={() => pickDay(today)} type="button">今月</button>
        </div>
        <div className="bk-doctors" role="group" aria-label="医師で絞り込む">
          <span className="bk-doctors-label">医師</span>
          <button aria-pressed={!doctorMemberId} className="btn btn-chip" onClick={() => setDoctorMemberId("")} type="button">全員</button>
          {doctors.map((doctor) => (
            <button aria-pressed={doctorMemberId === doctor.memberId} className="btn btn-chip" key={doctor.memberId} onClick={() => setDoctorMemberId(doctor.memberId)} type="button">{doctor.displayName}</button>
          ))}
        </div>
      </aside>
      <section className="bk-week" aria-label="週の予約状況">
        <div className="bk-week-head">
          <button aria-label="前の週" className="btn btn-ghost btn-sm" onClick={() => pickDay(addDays(focus, -7))} type="button">‹</button>
          <button aria-label="次の週" className="btn btn-ghost btn-sm" onClick={() => pickDay(addDays(focus, 7))} type="button">›</button>
          <button className="btn btn-ghost btn-sm" onClick={() => pickDay(today)} type="button">今週</button>
          <strong className="bk-week-title">{title}</strong>
          {week.loading ? <span className="muted small">読み込み中…</span> : null}
        </div>
        {week.error ? <p className="alert alert-danger" role="alert">{week.error}</p> : null}
        <div className="bk-grid-scroll">
          <div className="bk-grid" role="group" aria-label="週 × 時間の予約件数（枠を押すとその日時で予約）">
            <div className="bk-corner" />
            {days.map((day) => (
              <div className={`bk-day-head${day === today ? " is-today" : ""}${day === focus ? " is-focus" : ""}`} key={day}>
                <span>{Number(day.slice(5, 7))}/{Number(day.slice(8, 10))}</span> <small>({weekdayOf(day)})</small>
              </div>
            ))}
            <div className="bk-hour bk-allday">終日</div>
            {days.map((day) => (
              <SlotCell count={byDate.get(day)?.untimed || 0} date={day} key={`${day}-all`} label="時刻なし" onPick={() => onPickSlot(day, "")} past={day < today} />
            ))}
            {hours.map((hour) => {
              const hh = String(hour).padStart(2, "0");
              return [
                <div className="bk-hour" key={`h${hh}`} style={{ gridRow: "span 2" }}>{hour}:00</div>,
                ...["00", "30"].flatMap((minute) => days.map((day) => (
                  <SlotCell
                    count={byDate.get(day)?.halfSlots?.[`${hh}:${minute}`] || 0}
                    date={day}
                    half={minute === "30"}
                    key={`${day}-${hh}${minute}`}
                    label={`${hour}:${minute}`}
                    onPick={() => onPickSlot(day, `${hh}:${minute}`)}
                    past={day < today}
                  />
                )))
              ];
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function SlotCell({ date, label, count, half = false, past, onPick }) {
  return (
    <button
      aria-label={`${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日(${weekdayOf(date)}) ${label} 予約${count}件`}
      className={`bk-slot${half ? " is-half" : ""}${count ? " has-count" : ""}${past ? " is-past" : ""}`}
      onClick={onPick}
      type="button"
    >
      {count ? <span className="bk-count">{label === "時刻なし" ? null : <span className="bk-count-time">{label} – </span>}{count}件</span> : null}
    </button>
  );
}
