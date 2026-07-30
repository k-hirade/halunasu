import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyFacilityServiceTime,
  encounterBasicFeeMetadata,
  encounterBasicFeeRule,
  facilityDerivedAddonRules,
  facilityServiceTimeReviewWarning,
  timeAddonRule
} from "../src/facility-service-schedule.js";

function feeSettings() {
  return {
    facilityServiceSchedules: [{
      scheduleId: "clinic-hours-2026",
      effectiveFrom: "2026-06-01",
      effectiveTo: "",
      timezone: "Asia/Tokyo",
      weeklyHours: {
        monday: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "18:00" }],
        tuesday: [{ start: "09:00", end: "18:00" }],
        wednesday: [],
        thursday: [{ start: "09:00", end: "18:00" }],
        friday: [{ start: "09:00", end: "18:00" }],
        saturday: [{ start: "09:00", end: "12:00" }],
        sunday: []
      },
      holidayDates: ["2026-07-20"],
      specialHours: [{
        date: "2026-07-21",
        hours: [{ start: "10:00", end: "14:00" }]
      }],
      status: "active"
    }]
  };
}

test("classifies reception time only from the effective facility schedule", () => {
  assert.equal(classifyFacilityServiceTime({
    receptionTime: "10:00",
    serviceDate: "2026-06-15",
    feeSettings: feeSettings()
  }).timeClass, "within_hours");
  assert.equal(classifyFacilityServiceTime({
    receptionTime: "18:40",
    serviceDate: "2026-06-15",
    feeSettings: feeSettings()
  }).timeClass, "after_hours");
  assert.equal(classifyFacilityServiceTime({
    receptionTime: "23:00",
    serviceDate: "2026-06-15",
    feeSettings: feeSettings()
  }).timeClass, "late_night");
  assert.equal(classifyFacilityServiceTime({
    receptionTime: "10:00",
    serviceDate: "2026-07-20",
    feeSettings: feeSettings()
  }).timeClass, "holiday");
});

test("special hours override the weekly schedule", () => {
  const within = classifyFacilityServiceTime({
    receptionTime: "11:00",
    serviceDate: "2026-07-21",
    feeSettings: feeSettings()
  });
  const outside = classifyFacilityServiceTime({
    receptionTime: "15:00",
    serviceDate: "2026-07-21",
    feeSettings: feeSettings()
  });

  assert.equal(within.timeClass, "within_hours");
  assert.equal(within.source, "special_hours");
  assert.equal(outside.timeClass, "after_hours");
});

test("missing and closed-day schedules fail closed without selecting a code", () => {
  const missing = classifyFacilityServiceTime({
    receptionTime: "18:40",
    serviceDate: "2026-06-15",
    feeSettings: {}
  });
  const closedDay = classifyFacilityServiceTime({
    receptionTime: "10:00",
    serviceDate: "2026-06-17",
    feeSettings: feeSettings()
  });

  assert.equal(missing.status, "schedule_missing");
  assert.equal(missing.timeClass, null);
  assert.match(facilityServiceTimeReviewWarning(missing), /設定されていない/u);
  assert.equal(closedDay.status, "closed_day_unclassified");
  assert.equal(closedDay.timeClass, null);
  assert.match(facilityServiceTimeReviewWarning(closedDay), /休日加算の対象日か/u);
});

test("artifact-backed basic, time, and facility rules resolve to official master codes", () => {
  assert.equal(encounterBasicFeeMetadata().revision, "2026-06-v1");
  assert.equal(encounterBasicFeeRule("house_call").code, "114000110");
  assert.equal(timeAddonRule({
    timeClass: "after_hours",
    feeKind: "revisit"
  }).code, "112001110");
  assert.deepEqual(
    facilityDerivedAddonRules({
      feeKind: "revisit",
      facilityStandardKeys: [
        "jikan_gai_taio_taisei_1",
        "meisaisho_hakko_taisei"
      ]
    }).map((rule) => rule.code).sort(),
    ["112015770", "112016070"]
  );
});
