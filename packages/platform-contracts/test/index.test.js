import assert from "node:assert/strict";
import { test } from "node:test";
import {
  departmentSnapshot,
  facilitySnapshot,
  memberSnapshot,
  normalizeOrganizationCode,
  validateCreateAuditEventInput,
  validateCreateDataRequestInput,
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
  validatePatchDataRequestInput,
  validatePatchPatientInput,
  validateSetupAdminPasswordInput,
  validateVerifySignupEmailInput,
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

test("validates signup token inputs", () => {
  assert.deepEqual(validateVerifySignupEmailInput({ token: " emv_token " }), {
    token: "emv_token"
  });
  assert.deepEqual(validateSetupAdminPasswordInput({
    token: " setup_token ",
    password: "correct horse battery staple"
  }), {
    token: "setup_token",
    password: "correct horse battery staple"
  });
  assert.throws(() => validateVerifySignupEmailInput({}), /token is required/);
  assert.throws(() => validateSetupAdminPasswordInput({ token: "setup_token" }), /password is required/);
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
      sex: "male",
      primaryPatientNumber: "000123",
      patientIdentifiers: [
        { sourceSystem: "legacy", facilityId: "fac_123", patientNumber: "legacy-001" },
        { sourceSystem: "ignored" }
      ],
      contact: { phone: "03-0000-0000" },
      insurance: { insurerNumber: "06123456" },
      duplicateCandidateIds: ["pat_dup", "pat_dup"]
    })
  };

  assert.equal(patient.primaryPatientNumber, "000123");
  assert.deepEqual(patient.patientIdentifiers, [{
    sourceSystem: "legacy",
    facilityId: "fac_123",
    patientNumber: "legacy-001",
    value: "legacy-001",
    status: "active"
  }]);
  assert.deepEqual(patient.duplicateCandidateIds, ["pat_dup"]);
  assert.deepEqual(patientSnapshot(patient, new Date("2026-05-27T00:00:00.000Z")), {
    patientId: "pat_123",
    displayName: "Yamada Taro",
    displayNameKana: undefined,
    birthDate: "1970-01-01",
    sex: "male",
    snapshotAt: "2026-05-27T00:00:00.000Z"
  });
});

test("creates facility and department snapshots for product records", () => {
  const snappedFacility = facilitySnapshot({
    facilityId: "fac_123",
    displayName: "春ナスクリニック",
    medicalInstitutionCode: "1312345",
    regionalBureau: "kanto-shinetsu",
    prefecture: "tokyo",
    facilityStandardKeys: ["basic-a"]
  }, new Date("2026-05-28T00:00:00.000Z"));
  const snappedDepartment = departmentSnapshot({
    departmentId: "dep_123",
    facilityId: "fac_123",
    displayName: "内科",
    code: "01"
  }, new Date("2026-05-28T00:00:00.000Z"));

  assert.equal(snappedFacility.medicalInstitutionCode, "1312345");
  assert.equal(snappedFacility.regionalBureau, "kanto-shinetsu");
  assert.deepEqual(snappedFacility.facilityStandardKeys, ["basic-a"]);
  assert.equal(snappedDepartment.displayName, "内科");
  assert.equal(snappedDepartment.snapshotAt, "2026-05-28T00:00:00.000Z");
});

test("creates member snapshots for product records", () => {
  const snappedMember = memberSnapshot({
    memberId: "mem_123",
    displayName: "紹介 医師",
    loginId: "doctor@example.com",
    productRoles: {
      referral: ["doctor"]
    }
  }, new Date("2026-05-28T00:00:00.000Z"));

  assert.equal(snappedMember.memberId, "mem_123");
  assert.equal(snappedMember.displayName, "紹介 医師");
  assert.deepEqual(snappedMember.productRoles, { referral: ["doctor"] });
  assert.equal(snappedMember.snapshotAt, "2026-05-28T00:00:00.000Z");
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
    safePayload: {
      changedFields: ["displayName"],
      displayName: "Yamada Taro",
      birthDate: "1970-01-01",
      memberId: "mem_123"
    }
  });

  assert.equal(entitlement.productId, "charting");
  assert.equal(entitlement.startsAt, "2026-05-27T00:00:00.000Z");
  assert.deepEqual(auditEvent.safePayload.changedFields, ["displayName"]);
  assert.equal(auditEvent.safePayload.memberId, "mem_123");
  assert.equal(auditEvent.safePayload.displayName, undefined);
  assert.equal(auditEvent.safePayload.birthDate, undefined);
});

test("validates data request model for deletion and retention workflows", () => {
  const dataRequest = validateCreateDataRequestInput({
    requestType: "deletion",
    requesterMemberId: "mem_123",
    subjectPatientId: "pat_123",
    productIds: ["charting", "unknown", "fee"],
    reason: "patient requested deletion"
  });
  const patch = validatePatchDataRequestInput({
    status: "completed",
    assignedMemberId: "mem_admin",
    completedAt: "2026-05-28T00:00:00.000Z"
  });

  assert.equal(dataRequest.requestType, "deletion");
  assert.deepEqual(dataRequest.productIds, ["charting", "fee"]);
  assert.equal(dataRequest.status, "submitted");
  assert.equal(patch.completedAt, "2026-05-28T00:00:00.000Z");
  assert.throws(() => validateCreateDataRequestInput({ requestType: "erase" }), /requestType/);
});

test("rejects invalid patient birth date", () => {
  assert.throws(
    () => validateCreatePatientInput({ displayName: "Yamada Taro", birthDate: "19700101" }),
    /birthDate/
  );
});
