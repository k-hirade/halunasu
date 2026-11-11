import assert from "node:assert/strict";
import { test } from "node:test";
import { filesOnDate, followupColumns, followupDates, prefersFollowup, resolveFollowupDates } from "../lib/image-followup.js";

const file = (fileId, kind, eye, takenOn, createdAt = `${takenOn}T00:00:00Z`) => ({ fileId, kind, eye, takenOn, createdAt });
const files = [
  file("a", "oct", "od", "2026-07-14"),
  file("b", "fundus_photo", "ou", "2026-07-14"),
  file("c", "oct", "os", "2026-09-30"),
  file("d", "oct", "od", "2026-10-21"),
  file("e", "vf", "od", "2026-10-21"),
  file("f", "paper_chart", "", "2026-11-01"),
  file("g", "fundus_photo", "od", "2026-10-21")
];

test("lists visit dates with images, filtered by eye, skipping paper charts", () => {
  assert.deepEqual(followupDates(files), ["2026-07-14", "2026-09-30", "2026-10-21"]);
  assert.deepEqual(followupDates(files, "od"), ["2026-07-14", "2026-10-21"]);
  assert.deepEqual(followupDates(files, "os"), ["2026-07-14", "2026-09-30"]);
  assert.equal(prefersFollowup(files), true);
  assert.equal(prefersFollowup([files[0], files[1]]), false);
});

test("orders a visit's files by kind column, then eye", () => {
  assert.deepEqual(filesOnDate(files, "2026-10-21").map((item) => item.fileId), ["g", "d", "e"]);
  assert.deepEqual(filesOnDate(files, "2026-07-14", "os").map((item) => item.fileId), ["b"]);
});

test("columns are the union of kinds of both rows in a fixed order", () => {
  assert.deepEqual(followupColumns(filesOnDate(files, "2026-10-21"), filesOnDate(files, "2026-07-14")), ["fundus_photo", "oct", "vf"]);
});

test("defaults to newest vs previous or first, keeping valid picks", () => {
  const dates = ["2026-07-14", "2026-09-30", "2026-10-21"];
  assert.deepEqual(resolveFollowupDates(dates), { followup: "2026-10-21", baseline: "2026-09-30" });
  assert.deepEqual(resolveFollowupDates(dates, { rule: "first" }), { followup: "2026-10-21", baseline: "2026-07-14" });
  assert.deepEqual(resolveFollowupDates(dates, { followup: "2026-09-30" }), { followup: "2026-09-30", baseline: "2026-07-14" });
  assert.deepEqual(resolveFollowupDates(dates, { followup: "2026-07-14" }), { followup: "2026-07-14", baseline: "2026-09-30" });
  assert.deepEqual(resolveFollowupDates(dates, { baseline: "2026-10-21" }), { followup: "2026-10-21", baseline: "2026-10-21" });
  assert.deepEqual(resolveFollowupDates(["2026-07-14"]), { followup: "2026-07-14", baseline: "" });
  assert.deepEqual(resolveFollowupDates([]), { followup: "", baseline: "" });
});
