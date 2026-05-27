import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeOrganizationCode,
  patientSnapshot,
  validateCreateMemberInput,
  validateCreateOrganizationInput,
  validateCreatePatientInput
} from "../src/index.js";

test("normalizes organization code", () => {
  assert.equal(normalizeOrganizationCode(" Clinic A "), "clinic-a");
});

test("validates organization input with defaults", () => {
  const input = validateCreateOrganizationInput({
    organizationCode: "Clinic A",
    displayName: "Clinic A"
  });

  assert.equal(input.organizationCode, "clinic-a");
  assert.equal(input.status, "trialing");
  assert.equal(input.timezone, "Asia/Tokyo");
  assert.deepEqual(input.access.enabledProducts, ["charting", "fee", "referral"]);
});

test("validates member roles", () => {
  const input = validateCreateMemberInput({
    loginId: "doctor",
    displayName: "Doctor",
    globalRoles: ["doctor", "doctor", ""],
    productRoles: {
      charting: ["doctor"],
      unknown: ["ignored"]
    }
  });

  assert.deepEqual(input.globalRoles, ["doctor"]);
  assert.deepEqual(input.productRoles, { charting: ["doctor"] });
});

test("validates patient input and snapshot", () => {
  const patient = {
    patientId: "pat_123",
    ...validateCreatePatientInput({
      displayName: "Yamada Taro",
      birthDate: "1970-01-01",
      sex: "male"
    })
  };

  assert.deepEqual(patientSnapshot(patient, new Date("2026-05-27T00:00:00.000Z")), {
    patientId: "pat_123",
    displayName: "Yamada Taro",
    displayNameKana: undefined,
    birthDate: "1970-01-01",
    sex: "male",
    snapshotAt: "2026-05-27T00:00:00.000Z"
  });
});

test("rejects invalid patient birth date", () => {
  assert.throws(
    () => validateCreatePatientInput({ displayName: "Yamada Taro", birthDate: "19700101" }),
    /birthDate/
  );
});

