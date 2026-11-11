// 施設管理の「診療時間・予約枠」（clinic-config の clinicHours）を、予約状況の表と予約登録で使う形に直す。画面から切り離した純粋な関数。
// 未設定（どの曜日にも時間が無い）なら従来どおり: 8〜18 時台を 30 分ごと、どの枠も予約できる。
// 祝日の行（holiday）は祝日の暦を持っていないため、今は曜日の時間だけで判定する。
import { isActiveAppointmentStatus } from "@halunasu/eye-contracts";

export const DEFAULT_SLOT_MINUTES = 30;
export const DEFAULT_FIRST_HOUR = 8;
export const DEFAULT_LAST_HOUR = 18;
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_NAMES = { sun: "日", mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土" };
const SLOT_CHOICES = [10, 15, 20, 30, 60];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;

export function minutesOf(time) {
  if (!TIME.test(String(time || ""))) return null;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function timeOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function weekdayKeyOf(iso) {
  return WEEKDAY_KEYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

// clinicHours（API の値。無い・読めないときは null）→ { configured, slotMinutes, days }
export function scheduleOf(hours) {
  const days = {};
  for (const key of WEEKDAY_KEYS) {
    days[key] = (Array.isArray(hours?.days?.[key]) ? hours.days[key] : [])
      .map((range) => ({ from: minutesOf(range?.from), to: minutesOf(range?.to) }))
      .filter((range) => range.from !== null && range.to !== null && range.to > range.from);
  }
  const configured = Object.values(days).some((ranges) => ranges.length > 0);
  const slotMinutes = configured && SLOT_CHOICES.includes(hours?.slotMinutes) ? hours.slotMinutes : DEFAULT_SLOT_MINUTES;
  return { configured, slotMinutes, days };
}

export function isClosedDay(schedule, iso) {
  return Boolean(schedule?.configured) && !schedule.days[weekdayKeyOf(iso)]?.length;
}

// その日のその時刻（"HH:MM"）が診療時間の中か。未設定ならいつでも中。
export function isOpenAt(schedule, iso, time) {
  if (!schedule?.configured) return true;
  const minutes = minutesOf(time);
  if (minutes === null) return true;
  return (schedule.days[weekdayKeyOf(iso)] || []).some((range) => minutes >= range.from && minutes < range.to);
}

// 1 時間の中の枠の始まり（分）。10 分なら 0,10,…,50
export function slotStartsInHour(slotMinutes) {
  return Array.from({ length: Math.max(1, Math.floor(60 / slotMinutes)) }, (_, index) => index * slotMinutes);
}

// 表に出す時間帯（時）。設定があれば一番早い開始〜一番遅い終了、無ければ 8〜18 時。予約がその外にあれば広げる。
export function hoursForGrid(schedule, bookedTimes = []) {
  let first = DEFAULT_FIRST_HOUR;
  let last = DEFAULT_LAST_HOUR;
  if (schedule?.configured) {
    const ranges = Object.values(schedule.days).flat();
    first = Math.floor(Math.min(...ranges.map((range) => range.from)) / 60);
    last = Math.ceil(Math.max(...ranges.map((range) => range.to)) / 60) - 1;
  }
  for (const time of bookedTimes) {
    const minutes = minutesOf(time);
    if (minutes === null) continue;
    first = Math.min(first, Math.floor(minutes / 60));
    last = Math.max(last, Math.floor(minutes / 60));
  }
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
}

// 予約の件数を枠ごとに: { "YYYY-MM-DD": { "HH:MM": 件数 } }（取消・不在は数えない。時刻の無い予約は入れない）
export function countBySlot(appointments = [], slotMinutes = DEFAULT_SLOT_MINUTES) {
  const counts = {};
  for (const item of appointments) {
    if (!item?.date || !isActiveAppointmentStatus(item.status)) continue;
    const minutes = minutesOf(item.time);
    if (minutes === null) continue;
    const key = timeOf(Math.floor(minutes / slotMinutes) * slotMinutes);
    counts[item.date] = counts[item.date] || {};
    counts[item.date][key] = (counts[item.date][key] || 0) + 1;
  }
  return counts;
}

// 予約登録の時刻の下に出す注意（予約は止めない）。空なら注意なし。
export function outsideHoursNotice(schedule, iso, time) {
  if (!schedule?.configured || !/^\d{4}-\d{2}-\d{2}$/u.test(String(iso || ""))) return "";
  const key = weekdayKeyOf(iso);
  const ranges = schedule.days[key] || [];
  if (!ranges.length) return `${WEEKDAY_NAMES[key]}曜は休診日です（施設管理の診療時間）。`;
  if (!time || isOpenAt(schedule, iso, time)) return "";
  return `診療時間外です（${WEEKDAY_NAMES[key]}曜 ${ranges.map((range) => `${timeOf(range.from)}〜${timeOf(range.to)}`).join("・")}）。`;
}
