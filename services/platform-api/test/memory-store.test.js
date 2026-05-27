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
