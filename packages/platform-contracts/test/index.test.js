import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeOrganizationCode,
  validateCreateAuditEventInput,
  validateCreateDepartmentInput,
  validateCreateFacilityInput,
  patientSnapshot,
  validateCreateMemberInput,
  validateCreateOrganizationInput,
  validateCreatePatientInput,
  validateCreateSignupApplicationInput,
  validateLoginInput,
  validatePatchMemberInput,
  validatePatchOrganizationInput,
  validatePatchPatientInput,
  validateUpsertProductEntitlementInput
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
    loginId: "Doctor",
    displayName: "Doctor",
    globalRoles: ["doctor", "doctor", ""],
    productRoles: {
      charting: ["doctor"],
      unknown: ["ignored"]
    }
  });

  assert.equal(input.loginId, "doctor");
  assert.deepEqual(input.globalRoles, ["doctor"]);
  assert.deepEqual(input.productRoles, { charting: ["doctor"] });
});

test("validates login input", () => {
  const input = validateLoginInput({
    organizationCode: " Clinic A ",
    loginId: "Admin",
    password: "correct horse battery staple"
  });

  assert.equal(input.organizationCode, "clinic-a");
  assert.equal(input.loginId, "admin");
  assert.equal(input.password, "correct horse battery staple");
});

test("validates signup applications and patch input", () => {
  const signup = validateCreateSignupApplicationInput({
    organizationCode: "Signup Clinic",
    organizationDisplayName: "Signup Clinic",
    applicantName: "Applicant",
    applicantEmail: "Applicant@Example.com",
    requestedProducts: ["charting", "unknown"]
  });

  assert.equal(signup.organizationCode, "signup-clinic");
  assert.equal(signup.applicantEmail, "applicant@example.com");
  assert.deepEqual(signup.requestedProducts, ["charting"]);
  assert.deepEqual(validatePatchOrganizationInput({ displayName: "Updated" }), {
    displayName: "Updated"
  });
  assert.deepEqual(validatePatchMemberInput({ globalRoles: ["doctor", "doctor"] }), {
    globalRoles: ["doctor"]
  });
  assert.deepEqual(validatePatchPatientInput({ displayNameKana: "YAMADA TARO" }), {
    displayNameKana: "YAMADA TARO"
  });
  assert.throws(() => validatePatchOrganizationInput({ organizationCode: "new-code" }), /cannot be changed/);
  assert.throws(() => validatePatchMemberInput({ loginId: "new-login" }), /cannot be changed/);
});

test("validates facility and department input", () => {
  const facility = validateCreateFacilityInput({
    displayName: "Main Clinic",
    facilityStandardKeys: ["basic", "basic", ""]
  });
  const department = validateCreateDepartmentInput({
    facilityId: "fac_123",
    displayName: "Internal Medicine",
    status: "active"
  });

  assert.deepEqual(facility.facilityStandardKeys, ["basic"]);
  assert.equal(facility.status, "active");
  assert.equal(department.facilityId, "fac_123");
  assert.equal(department.displayName, "Internal Medicine");
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

test("validates product entitlements and audit events", () => {
  const entitlement = validateUpsertProductEntitlementInput({
    productId: "charting",
    status: "enabled",
    limits: { monthlyEncounters: 100 },
    startsAt: "2026-05-27T00:00:00.000Z"
  });
  const auditEvent = validateCreateAuditEventInput({
    eventType: "member.created",
    actorMemberId: "mem_123",
    productId: "charting",
    safePayload: { changedFields: ["displayName"] }
  });

  assert.equal(entitlement.productId, "charting");
  assert.equal(entitlement.startsAt, "2026-05-27T00:00:00.000Z");
  assert.deepEqual(auditEvent.safePayload.changedFields, ["displayName"]);
});

test("rejects invalid patient birth date", () => {
  assert.throws(
    () => validateCreatePatientInput({ displayName: "Yamada Taro", birthDate: "19700101" }),
    /birthDate/
  );
});
