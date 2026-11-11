"use client";

import { useEffect, useMemo, useState } from "react";
import { useEyeApi } from "./eye-api";
import { MiniCalendar, weekdayOf } from "./mini-calendar";
import { useClinicSchedule } from "./use-clinic-hours";
import { useDoctors } from "./use-doctors";
import { countBySlot, hoursForGrid, isClosedDay, isOpenAt, slotStartsInHour } from "../lib/booking-hours";
import { addDays, todayIso } from "../lib/format";

export function weekStartOf(iso) {
  return addDays(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay());
}

// 予約状況（デジカルの予約状況カレンダー）。左に月の小さなカレンダー（日ごとの件数）と医師の切り替え、
// 右に週 × 時間の表（「終日」＝時刻なしの段と、予約枠の長さごとの段）。枠を押すとその日時を onPickSlot(date, time) で返す。
// 枠の長さと休診（曜日・時間）は施設管理の「診療時間・予約枠」。未設定なら 8〜18 時・30 分で、どの枠も押せる。
// 休診の枠は押せない（予約が入っていれば件数は出す）。時間外の予約は予約登録の時刻の欄で入れられる。
export function BookingCalendar({ date = todayIso(), onPickSlot, onPickDay = null, refreshKey = 0 }) {
  const api = useEyeApi();
  const doctors = useDoctors();
  const schedule = useClinicSchedule();
  const [focus, setFocus] = useState(date);
  const [month, setMonth] = useState(date.slice(0, 7));
  const [doctorMemberId, setDoctorMemberId] = useState("");
  // 900px 以下は月のカレンダーをたたみ、週の表を先に見せる（広い画面では常に出す。CSS で切り替える）
  const [monthOpen, setMonthOpen] = useState(false);
  const [monthDays, setMonthDays] = useState({});
  const [week, setWeek] = useState({ days: [], appointments: [], loading: true, error: "" });
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
      .then((payload) => { if (alive) setWeek({ days: payload.days, appointments: payload.appointments || [], loading: false, error: "" }); })
      .catch((error) => { if (alive) setWeek({ days: [], appointments: [], loading: false, error: error.message }); });
    return () => { alive = false; };
  }, [api, weekStart, doctorMemberId, refreshKey]);

  const counts = useMemo(() => countBySlot(week.appointments, schedule.slotMinutes), [week.appointments, schedule.slotMinutes]);
  const hours = useMemo(() => hoursForGrid(schedule, Object.values(counts).flatMap((day) => Object.keys(day))), [schedule, counts]);
  const minutes = slotStartsInHour(schedule.slotMinutes);

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
              <div className={`bk-day-head${day === today ? " is-today" : ""}${day === focus ? " is-focus" : ""}${isClosedDay(schedule, day) ? " is-closed" : ""}`} key={day}>
                <span>{Number(day.slice(5, 7))}/{Number(day.slice(8, 10))}</span> <small>({weekdayOf(day)})</small>
                {isClosedDay(schedule, day) ? <small className="bk-closed-tag">休診</small> : null}
              </div>
            ))}
            <div className="bk-hour bk-allday">終日</div>
            {days.map((day) => (
              <SlotCell closed={isClosedDay(schedule, day)} count={byDate.get(day)?.untimed || 0} date={day} key={`${day}-all`} label="時刻なし" onPick={() => onPickSlot(day, "")} past={day < today} />
            ))}
            {hours.map((hour) => {
              const hh = String(hour).padStart(2, "0");
              return [
                <div className="bk-hour" key={`h${hh}`} style={{ gridRow: `span ${minutes.length}` }}>{hour}:00</div>,
                ...minutes.flatMap((minute, index) => days.map((day) => {
                  const time = `${hh}:${String(minute).padStart(2, "0")}`;
                  return (
                    <SlotCell
                      closed={!isOpenAt(schedule, day, time)}
                      count={counts[day]?.[time] || 0}
                      date={day}
                      half={index === minutes.length - 1}
                      key={`${day}-${time}`}
                      label={`${hour}:${time.slice(3)}`}
                      onPick={() => onPickSlot(day, time)}
                      past={day < today}
                    />
                  );
                }))
              ];
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function SlotCell({ date, label, count, half = false, past, closed = false, onPick }) {
  const day = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日(${weekdayOf(date)}) ${label}`;
  // 休診で予約の無い枠は押せない（表の形を保つため、ボタンではなく空のセル）
  if (closed && !count) return <div aria-label={`${day} 休診`} className={`bk-slot is-closed${half ? " is-half" : ""}`} role="img" />;
  return (
    <button
      aria-label={`${day} ${closed ? "休診・" : ""}予約${count}件`}
      className={`bk-slot${half ? " is-half" : ""}${count ? " has-count" : ""}${past ? " is-past" : ""}${closed ? " is-closed" : ""}`}
      onClick={onPick}
      type="button"
    >
      {count ? <span className="bk-count">{label === "時刻なし" ? null : <span className="bk-count-time">{label} – </span>}{count}件</span> : null}
    </button>
  );
}
