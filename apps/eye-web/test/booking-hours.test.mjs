import assert from "node:assert/strict";
import { test } from "node:test";
import { countBySlot, hoursForGrid, isClosedDay, isOpenAt, outsideHoursNotice, scheduleOf, slotStartsInHour } from "../lib/booking-hours.js";

const HOURS = {
  slotMinutes: 15,
  days: { mon: [{ from: "09:00", to: "12:30" }, { from: "14:30", to: "18:00" }], tue: [{ from: "09:00", to: "12:30" }], wed: [], thu: [], fri: [], sat: [{ from: "09:00", to: "13:00" }], sun: [], holiday: [] },
  note: ""
};
// 2026-11-09 は月曜、11-11 は水曜、11-14 は土曜
const MONDAY = "2026-11-09";
const WEDNESDAY = "2026-11-11";

test("without clinic hours the grid keeps the old 8-18 o'clock, 30 minute slots and every slot is open", () => {
  for (const hours of [null, undefined, { slotMinutes: 15, days: { mon: [] } }]) {
    const schedule = scheduleOf(hours);
    assert.equal(schedule.configured, false);
    assert.equal(schedule.slotMinutes, 30);
    assert.deepEqual(hoursForGrid(schedule), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    assert.equal(isOpenAt(schedule, WEDNESDAY, "07:00"), true);
    assert.equal(isClosedDay(schedule, WEDNESDAY), false);
    assert.equal(outsideHoursNotice(schedule, WEDNESDAY, "22:00"), "");
  }
  assert.deepEqual(slotStartsInHour(30), [0, 30]);
});

test("configured hours set the slot length, the shown hours and the closed days and times", () => {
  const schedule = scheduleOf(HOURS);
  assert.equal(schedule.configured, true);
  assert.equal(schedule.slotMinutes, 15);
  assert.deepEqual(slotStartsInHour(15), [0, 15, 30, 45]);
  assert.deepEqual(hoursForGrid(schedule), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(hoursForGrid(schedule, ["19:10", ""]), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], "a booking outside the hours widens the grid");
  assert.equal(isOpenAt(schedule, MONDAY, "09:00"), true);
  assert.equal(isOpenAt(schedule, MONDAY, "12:30"), false, "the end time is closed");
  assert.equal(isOpenAt(schedule, MONDAY, "13:00"), false, "the lunch break is closed");
  assert.equal(isOpenAt(schedule, MONDAY, "14:30"), true);
  assert.equal(isClosedDay(schedule, WEDNESDAY), true);
  assert.equal(isOpenAt(schedule, WEDNESDAY, "10:00"), false);
  assert.match(outsideHoursNotice(schedule, WEDNESDAY, ""), /水曜は休診日/u);
  assert.match(outsideHoursNotice(schedule, MONDAY, "13:00"), /診療時間外です（月曜 09:00〜12:30・14:30〜18:00）/u);
  assert.equal(outsideHoursNotice(schedule, MONDAY, "10:00"), "");
  assert.equal(scheduleOf({ ...HOURS, slotMinutes: 7 }).slotMinutes, 30, "an unknown slot length falls back to 30 minutes");
});

test("bookings are counted per configured slot and cancelled or absent ones are not counted", () => {
  const appointments = [
    { date: MONDAY, time: "09:05", status: "booked" },
    { date: MONDAY, time: "09:14", status: "checked_in" },
    { date: MONDAY, time: "09:15", status: "booked" },
    { date: MONDAY, time: "09:20", status: "cancelled" },
    { date: MONDAY, time: "", status: "booked" }
  ];
  assert.deepEqual(countBySlot(appointments, 15), { [MONDAY]: { "09:00": 2, "09:15": 1 } });
  assert.deepEqual(countBySlot(appointments, 30), { [MONDAY]: { "09:00": 3 } });
  assert.deepEqual(countBySlot(appointments, 60), { [MONDAY]: { "09:00": 3 } });
});
