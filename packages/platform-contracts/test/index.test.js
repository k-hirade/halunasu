import assert from "node:assert/strict";
import { test } from "node:test";
import {
  departmentSnapshot,
  facilitySnapshot,
  memberSnapshot,
  memberRequiresMfa,
  productIds,
  normalizeOrganizationCode,
  resolveMfaState,
  validateCreateAuditEventInput,
  validateCreateDataRequestInput,
  validateCreateDepartmentInput,
  validateCreateFacilityInput,
  patientSnapshot,
  insuranceSnapshot,
  validateInsurance,
  validatePublicInsurance,
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
    },
    defaultRecordingSource: "local_browser"
  });

  assert.equal(input.loginId, "doctor");
  assert.deepEqual(input.globalRoles, ["doctor"]);
  assert.deepEqual(input.productRoles, { charting: ["doctor"] });
  assert.equal(input.defaultRecordingSource, "local_browser");
});

test("resolves one MFA policy for every privileged Platform role", () => {
  for (const role of ["platform_admin", "org_owner", "org_admin", "it_admin", "billing_admin"]) {
    assert.equal(memberRequiresMfa({ globalRoles: [role] }), true, `${role} must require MFA`);
  }
  assert.equal(memberRequiresMfa({ globalRoles: ["doctor"] }), false);
  assert.equal(memberRequiresMfa({ globalRoles: [], productRoles: { fee: ["admin"] } }), true);
  assert.equal(memberRequiresMfa({ globalRoles: [], productRoles: { fee: ["medical_clerk"] } }), false);
  assert.equal(memberRequiresMfa({ globalRoles: [], productRoles: { homis_sidecar: ["medical_clerk"] } }), true);
  assert.equal(productIds.homisSidecar, "homis_sidecar");
  assert.deepEqual(
    resolveMfaState({ mfaRequired: false, mfaEnrolled: false }, { globalRoles: ["org_owner"] }),
    { required: true, enrolled: false }
  );
  assert.deepEqual(
    resolveMfaState({ mfaRequired: true, mfaEnrolled: true }, { globalRoles: [] }),
    { required: true, enrolled: true }
  );
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
    requestedProducts: ["charting", "unknown"],
    safePayload: {
      source: "lp_contact_form",
      phoneNumber: "03-0000-0000",
      seatEstimate: 5
    }
  });

  assert.equal(signup.organizationCode, "signup-clinic");
  assert.equal(signup.applicantEmail, "applicant@example.com");
  assert.deepEqual(signup.requestedProducts, ["charting"]);
  assert.equal(signup.safePayload.phoneNumber, undefined);
  assert.equal(signup.safePayload.seatEstimate, 5);
  assert.deepEqual(validatePatchOrganizationInput({ displayName: "Updated", defaultPromptProfileId: "system-default" }), {
    displayName: "Updated",
    defaultPromptProfileId: "system-default"
  });
  assert.deepEqual(validatePatchMemberInput({ globalRoles: ["doctor", "doctor"], defaultPromptProfileId: "fmt_123" }), {
    globalRoles: ["doctor"],
    defaultPromptProfileId: "fmt_123"
  });
  assert.deepEqual(validatePatchMemberInput({ defaultRecordingSource: "local_browser" }), {
    defaultRecordingSource: "local_browser"
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
      memberId: "mem_123",
      warningCodes: ["meisaisho_hakko_facility_type_unconfirmed"],
      meisaishoHakkoFacilityTypeStatus: "missing",
      authMode: "device_poll",
      deviceAuthId: "sda_123",
      extensionId: "nhbmaniknlcaaelpaoogepmkhphmmjof",
      grantRecordId: "sgr_123",
      scopes: ["sidecar:calculate"]
    }
  });

  assert.equal(entitlement.productId, "charting");
  assert.equal(entitlement.startsAt, "2026-05-27T00:00:00.000Z");
  assert.deepEqual(auditEvent.safePayload.changedFields, ["displayName"]);
  assert.equal(auditEvent.safePayload.memberId, "mem_123");
  assert.deepEqual(auditEvent.safePayload.warningCodes, ["meisaisho_hakko_facility_type_unconfirmed"]);
  assert.equal(auditEvent.safePayload.meisaishoHakkoFacilityTypeStatus, "missing");
  assert.equal(auditEvent.safePayload.authMode, "device_poll");
  assert.equal(auditEvent.safePayload.deviceAuthId, "sda_123");
  assert.equal(auditEvent.safePayload.extensionId, "nhbmaniknlcaaelpaoogepmkhphmmjof");
  assert.equal(auditEvent.safePayload.grantRecordId, "sgr_123");
  assert.deepEqual(auditEvent.safePayload.scopes, ["sidecar:calculate"]);
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

test("validates and structures insurance, preserving unknown keys", () => {
  const insurance = validateInsurance({
    insurerType: "shaho",
    insurerNumber: "01130012",
    insuredSymbol: "12",
    insuredNumber: "3456",
    burdenRatio: 0.3,
    legacyField: "keep-me"
  });
  assert.equal(insurance.insurerType, "shaho");
  assert.equal(insurance.burdenRatio, 0.3);
  assert.equal(insurance.legacyField, "keep-me", "unknown keys preserved for backward compatibility");

  assert.deepEqual(validateInsurance({}), {});
  assert.deepEqual(validateInsurance(undefined), {});
  assert.throws(() => validateInsurance({ insurerType: "invalid" }), /insurerType/);
  assert.throws(() => validateInsurance({ burdenRatio: 2 }), /burdenRatio/);
});

test("validates public insurance as an array and accepts legacy single object", () => {
  const list = validatePublicInsurance([{ payerNumber: "54136015", recipientNumber: "0000001", priority: 1 }]);
  assert.equal(list.length, 1);
  assert.equal(list[0].payerNumber, "54136015");

  const legacy = validatePublicInsurance({ payerNumber: "54136015" });
  assert.equal(legacy.length, 1, "legacy single object becomes one-element array");
  assert.deepEqual(validatePublicInsurance(undefined), []);
});

test("creates insurance snapshot fixed at the service date", () => {
  const snapshot = insuranceSnapshot(
    { insurance: { insurerType: "kokuho", burdenRatio: 0.3 }, publicInsurance: [{ payerNumber: "1" }] },
    "2026-06-01",
    new Date("2026-06-01T00:00:00.000Z")
  );
  assert.equal(snapshot.insurance.insurerType, "kokuho");
  assert.equal(snapshot.publicInsurance.length, 1);
  assert.equal(snapshot.serviceDate, "2026-06-01");
  assert.equal(snapshot.snapshotAt, "2026-06-01T00:00:00.000Z");
});
