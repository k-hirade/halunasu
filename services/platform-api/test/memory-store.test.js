import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryPlatformStore } from "../src/store/memory-store.js";

test("stores organizations, members, and patients in org scope", () => {
  const store = new MemoryPlatformStore({
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_fixed`
  });

  const organization = store.createOrganization({
    organizationCode: "Clinic",
    displayName: "Clinic"
  });
  const member = store.createMember(organization.orgId, {
    loginId: "doctor",
    displayName: "Doctor"
  });
  const patient = store.createPatient(organization.orgId, {
    displayName: "Patient"
  });

  assert.equal(organization.orgId, "org_fixed");
  assert.equal(member.orgId, "org_fixed");
  assert.equal(patient.orgId, "org_fixed");
  assert.equal(store.listMembers(organization.orgId).length, 1);
  assert.equal(store.listPatients(organization.orgId).length, 1);
});

test("stores login identities and shared master data", () => {
  let counter = 0;
  const store = new MemoryPlatformStore({
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });

  const organization = store.createOrganization({
    organizationCode: "Clinic Auth",
    displayName: "Clinic Auth"
  });
  const member = store.createMember(organization.orgId, {
    loginId: "Admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });
  const identity = store.getLoginIdentity("clinic-auth", "admin");
  const facility = store.createFacility(organization.orgId, {
    displayName: "Main Clinic",
    medicalInstitutionCode: "1234567"
  });
  const department = store.createDepartment(organization.orgId, {
    facilityId: facility.facilityId,
    displayName: "Internal Medicine"
  });
  const entitlement = store.upsertProductEntitlement(organization.orgId, {
    productId: "charting",
    status: "enabled"
  });
  const auditEvent = store.createAuditEvent(organization.orgId, {
    eventType: "member.created",
    actorMemberId: member.memberId,
    safePayload: { memberId: member.memberId }
  });

  assert.equal(member.loginId, "admin");
  assert.equal(identity.memberId, member.memberId);
  assert.equal(identity.mfaRequired, true);
  assert.match(identity.passwordHash, /^scrypt\$/);
  assert.equal(store.listFacilities(organization.orgId).length, 1);
  assert.equal(department.departmentId, "dep_004");
  assert.equal(entitlement.productId, "charting");
  assert.equal(auditEvent.eventId, "aud_005");
  assert.equal(store.listAuditEvents(organization.orgId).length, 1);
});

test("updates platform resources and applies rate limits", () => {
  let counter = 0;
  const store = new MemoryPlatformStore({
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const organization = store.createOrganization({
    organizationCode: "Clinic Update",
    displayName: "Clinic Update"
  });
  const signupApplication = store.createSignupApplication({
    organizationCode: "Signup Clinic",
    organizationDisplayName: "Signup Clinic",
    applicantName: "Applicant",
    applicantEmail: "Applicant@example.com"
  });
  const member = store.createMember(organization.orgId, {
    loginId: "doctor",
    displayName: "Doctor",
    password: "correct horse battery staple"
  });
  const facility = store.createFacility(organization.orgId, {
    displayName: "Main Clinic"
  });
  const department = store.createDepartment(organization.orgId, {
    displayName: "Internal Medicine"
  });
  const patient = store.createPatient(organization.orgId, {
    displayName: "Patient"
  });
  store.upsertProductEntitlement(organization.orgId, {
    productId: "charting",
    status: "trialing"
  });

  assert.equal(store.updateOrganization(organization.orgId, { displayName: "Updated" }).displayName, "Updated");
  assert.equal(store.updateMember(organization.orgId, member.memberId, { displayName: "Updated Doctor" }).displayName, "Updated Doctor");
  assert.equal(store.updateFacility(organization.orgId, facility.facilityId, { medicalInstitutionCode: "1234567" }).medicalInstitutionCode, "1234567");
  assert.equal(store.updateDepartment(organization.orgId, department.departmentId, { facilityId: facility.facilityId }).facilityId, facility.facilityId);
  assert.equal(store.updatePatient(organization.orgId, patient.patientId, { displayNameKana: "YAMADA TARO" }).displayNameKana, "YAMADA TARO");
  assert.equal(store.updateProductEntitlement(organization.orgId, "charting", { status: "enabled" }).status, "enabled");
  assert.equal(store.getSignupApplication(signupApplication.applicationId).organizationCode, "signup-clinic");
  assert.equal(store.listSignupApplications().length, 1);

  store.consumeRateLimit("login:local:clinic:doctor", { limit: 1, windowSeconds: 60 });
  assert.throws(
    () => store.consumeRateLimit("login:local:clinic:doctor", { limit: 1, windowSeconds: 60 }),
    /Too many requests/
  );
});

test("prevents duplicate organization codes", () => {
  const store = new MemoryPlatformStore({
    idFactory: (prefix) => `${prefix}_${Math.random()}`
  });

  store.createOrganization({
    organizationCode: "Clinic",
    displayName: "Clinic"
  });

  assert.throws(
    () => store.createOrganization({ organizationCode: "clinic", displayName: "Duplicate" }),
    /already exists/
  );
});

test("prevents duplicate login identities", () => {
  let counter = 0;
  const store = new MemoryPlatformStore({
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const organization = store.createOrganization({
    organizationCode: "Clinic Login",
    displayName: "Clinic Login"
  });

  store.createMember(organization.orgId, {
    loginId: "doctor",
    displayName: "Doctor",
    password: "correct horse battery staple"
  });

  assert.throws(
    () => store.createMember(organization.orgId, {
      loginId: "Doctor",
      displayName: "Duplicate",
      password: "correct horse battery staple"
    }),
    /loginId already exists/
  );
});
