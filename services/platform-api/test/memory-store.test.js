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

