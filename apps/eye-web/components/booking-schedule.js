"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppointmentDialog } from "./appointment-dialog";
import { BookingCalendar } from "./booking-calendar";
import { useEyeApi } from "./eye-api";
import { todayIso } from "../lib/format";

// 予約状況の画面（受付の［予約状況］から開く。デジカルにはナビの入口がないので、ナビには足さない）。
// 空いている枠を押すと、その日時を入れた予約登録を開く。
export function BookingSchedule() {
  const api = useEyeApi();
  const router = useRouter();
  const [date, setDate] = useState("");
  const [context, setContext] = useState(null);
  const [booking, setBooking] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("date");
    setDate(requested && /^\d{4}-\d{2}-\d{2}$/u.test(requested) ? requested : todayIso());
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch(() => setContext(null));
  }, [api]);

  const canReceive = Boolean(context?.canReceive);
  return (
    <main className="eye-page rc-page bk-page">
      <div className="rc-toolbar">
        <h1 className="rc-title">予約状況</h1>
        <Link className="btn btn-ghost btn-sm" href={`/reception${date ? `?date=${date}` : ""}`}>受付一覧へ</Link>
        <span className="muted small">{canReceive ? "空いている枠を押すと、その日時で予約を登録します（過去の日は受付一覧を開きます）。" : "予約の登録は受付の担当者が行います。"}</span>
      </div>
      {notice ? <p className="alert alert-ok" role="status">{notice}</p> : null}
      {date ? (
        <BookingCalendar
          date={date}
          onOpenDay={(day) => router.push(`/reception?date=${day}`)}
          onPickDay={setDate}
          onPickSlot={(day, time) => { if (canReceive) setBooking({ date: day, time }); }}
          refreshKey={refreshKey}
        />
      ) : null}
      {booking ? (
        <AppointmentDialog
          initial={{ date: booking.date, time: booking.time, walkIn: false, purpose: "revisit" }}
          onCancel={() => setBooking(null)}
          onSaved={(appointment) => {
            setBooking(null);
            setRefreshKey((value) => value + 1);
            setNotice(`${appointment.patientName}: ${appointment.date.replaceAll("-", "/")} ${appointment.time || "（時刻なし）"} に予約しました。`);
          }}
          title="予約登録"
        />
      ) : null}
    </main>
  );
}
