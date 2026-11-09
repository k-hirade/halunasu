import assert from "node:assert/strict";
import { test } from "node:test";
import {
  birthWithEra,
  DEFAULT_FILTERS,
  filterAppointments,
  isFiltered,
  queueLabel,
  readStored,
  sanitizeHiddenColumns,
  sanitizeSort,
  sortAppointments,
  UNSET,
  writeStored
} from "../lib/reception-table.js";

const row = (overrides) => ({ appointmentId: overrides.id, status: "checked_in", queueNumber: null, time: "", patientSnapshot: {}, note: "", ...overrides });

test("numbers are three digits and bookings without a number show a dash", () => {
  assert.equal(queueLabel({ queueNumber: 7 }), "007");
  assert.equal(queueLabel({ queueNumber: null }), "-");
});

test("birth dates show the Japanese era beside the western year", () => {
  assert.equal(birthWithEra("1954-05-03"), "1954(S29)/05/03");
  assert.equal(birthWithEra("2020-01-02"), "2020(R2)/01/02");
  assert.equal(birthWithEra(""), "");
});

test("the default sort puts bookings first by time, then the queue number", () => {
  const rows = [
    row({ id: "a", queueNumber: 2 }),
    row({ id: "b", status: "booked", time: "10:00" }),
    row({ id: "c", queueNumber: 1 }),
    row({ id: "d", status: "booked", time: "09:00" })
  ];
  assert.deepEqual(sortAppointments(rows).map((item) => item.appointmentId), ["d", "b", "c", "a"]);
  assert.deepEqual(sortAppointments(rows, { key: "no", dir: "desc" }).map((item) => item.appointmentId), ["d", "b", "a", "c"]);
});

test("sorting by kana and status keeps empty values last in both directions", () => {
  const rows = [
    row({ id: "a", patientSnapshot: { displayNameKana: "ミホン" } }),
    row({ id: "b", patientName: "" }),
    row({ id: "c", patientSnapshot: { displayNameKana: "アオキ" } })
  ];
  assert.deepEqual(sortAppointments(rows, { key: "name", dir: "asc" }).map((item) => item.appointmentId), ["c", "a", "b"]);
  assert.deepEqual(sortAppointments(rows, { key: "name", dir: "desc" }).map((item) => item.appointmentId), ["a", "c", "b"]);
  const statuses = [row({ id: "x", status: "done" }), row({ id: "y", status: "booked" }), row({ id: "z", status: "checkout", displayStatus: "rebill_waiting" })];
  assert.deepEqual(sortAppointments(statuses, { key: "status", dir: "asc" }).map((item) => item.appointmentId), ["y", "x", "z"]);
});

test("filters hide cancelled by default and match doctors, departments and memos", () => {
  const rows = [
    row({ id: "a", doctorMemberId: "d1", department: "眼科", note: "駐車券" }),
    row({ id: "b", status: "cancelled" }),
    row({ id: "c", status: "no_show" }),
    row({ id: "d", patientId: "p1" })
  ];
  assert.deepEqual(filterAppointments(rows).map((item) => item.appointmentId), ["a", "c", "d"]);
  assert.equal(isFiltered(DEFAULT_FILTERS), false);
  const absent = { ...DEFAULT_FILTERS, hiddenStatuses: ["cancelled", "absent"] };
  assert.deepEqual(filterAppointments(rows, absent).map((item) => item.appointmentId), ["a", "d"], "the old no-show is read as absent");
  assert.equal(isFiltered(absent), true);
  assert.deepEqual(filterAppointments(rows, { ...DEFAULT_FILTERS, hiddenDoctors: [UNSET] }).map((item) => item.appointmentId), ["a"]);
  assert.deepEqual(filterAppointments(rows, { ...DEFAULT_FILTERS, hiddenDepartments: ["眼科"] }).map((item) => item.appointmentId), ["c", "d"]);
  assert.deepEqual(filterAppointments(rows, { ...DEFAULT_FILTERS, receptionMemo: "駐車" }).map((item) => item.appointmentId), ["a"]);
  assert.deepEqual(filterAppointments(rows, { ...DEFAULT_FILTERS, patientMemo: "車いす" }, { p1: { patientMemo: "車いす使用" } }).map((item) => item.appointmentId), ["d"]);
});

test("stored column settings survive bad values and storage errors", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(readStored("k", ["x"], broken), ["x"]);
  assert.doesNotThrow(() => writeStored("k", ["x"], broken));
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  writeStored("k", ["wait"], storage);
  assert.deepEqual(readStored("k", [], storage), ["wait"]);
  assert.deepEqual(sanitizeHiddenColumns(["wait", "name", "nope"]), ["wait"], "the name column cannot be hidden");
  assert.deepEqual(sanitizeSort({ key: "nope", dir: "asc" }), { key: "no", dir: "asc" });
});
