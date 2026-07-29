import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyPassword } from "../src/auth/password.js";
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
    displayName: "Patient",
    primaryPatientNumber: "000123",
    patientIdentifiers: [{ sourceSystem: "legacy", facilityId: "fac_001", patientNumber: "legacy-001" }]
  });

  assert.equal(organization.orgId, "org_fixed");
  assert.equal(member.orgId, "org_fixed");
  assert.equal(patient.orgId, "org_fixed");
  assert.equal(patient.primaryPatientNumber, "000123");
  assert.equal(patient.patientIdentifiers[0].value, "legacy-001");
  assert.equal(store.listMembers(organization.orgId).length, 1);
  assert.equal(store.listPatients(organization.orgId).length, 1);
  assert.deepEqual(
    store.findPatientsByIdentifier(organization.orgId, {
      sourceSystem: "legacy",
      facilityId: "fac_001",
      patientNumber: "legacy-001"
    }).map((item) => item.patientId),
    [patient.patientId]
  );
});

test("lists patients with bounded recent and search options", () => {
  let now = new Date("2026-05-27T00:00:00.000Z");
  let counter = 0;
  const store = new MemoryPlatformStore({
    now: () => now,
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const organization = store.createOrganization({
    organizationCode: "Clinic Patient Search",
    displayName: "Clinic Patient Search"
  });

  const alpha = store.createPatient(organization.orgId, {
    displayName: "Alpha Patient",
    primaryPatientNumber: "000111"
  });
  now = new Date("2026-05-28T00:00:00.000Z");
  const beta = store.createPatient(organization.orgId, {
    displayName: "Beta Patient",
    primaryPatientNumber: "000222",
    externalPatientIds: ["legacy-222"]
  });

  assert.equal(alpha.patientSearchName, undefined);
  assert.equal(beta.patientSearchPrimaryNumber, undefined);
  assert.deepEqual(
    store.listPatients(organization.orgId, { limit: 1 }).map((patient) => patient.patientId),
    [beta.patientId]
  );
  assert.deepEqual(
    store.listPatients(organization.orgId, { search: "0001", limit: 10 }).map((patient) => patient.patientId),
    [alpha.patientId]
  );
  assert.deepEqual(
    store.listPatients(organization.orgId, { search: "legacy", limit: 10 }).map((patient) => patient.patientId),
    [beta.patientId]
  );
});

test("provisions a sidecar patient idempotently and indexes the identifier", () => {
  const store = new MemoryPlatformStore({
    now: () => new Date("2026-07-29T00:00:00.000Z")
  });
  const organization = store.createOrganization({
    organizationCode: "Sidecar Clinic",
    displayName: "Sidecar Clinic"
  });
  const input = {
    sourceSystem: "homis",
    facilityId: "fac_001",
    patientNumber: "1004",
    sidecarPatientKey: `sidecar_patient_${"a".repeat(26)}`
  };

  const first = store.provisionPatientFromIdentifier(organization.orgId, input);
  const second = store.provisionPatientFromIdentifier(organization.orgId, input);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.patient.patientId, input.sidecarPatientKey);
  assert.equal(second.patient.patientId, input.sidecarPatientKey);
  assert.equal(first.patient.primaryPatientNumber, "1004");
  assert.deepEqual(first.patient.provenance, {
    source: "sidecar_auto_provision",
    firstSeenAt: "2026-07-29T00:00:00.000Z"
  });
  assert.deepEqual(
    store.findPatientsByIdentifier(organization.orgId, input).map((patient) => patient.patientId),
    [input.sidecarPatientKey]
  );
  assert.equal(store.patientIdentifierIndexForOrg(organization.orgId).size, 1);
});

test("enforces patient identifier uniqueness across normal and sidecar creation", () => {
  let counter = 0;
  const store = new MemoryPlatformStore({
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const organization = store.createOrganization({
    organizationCode: "Unique Clinic",
    displayName: "Unique Clinic"
  });
  const identifier = {
    sourceSystem: "homis",
    facilityId: "fac_001",
    patientNumber: "1004"
  };
  const normal = store.createPatient(organization.orgId, {
    displayName: "Existing Patient",
    patientIdentifiers: [identifier]
  });
  const provisioned = store.provisionPatientFromIdentifier(organization.orgId, {
    ...identifier,
    sidecarPatientKey: `sidecar_patient_${"b".repeat(26)}`
  });

  assert.equal(provisioned.created, false);
  assert.equal(provisioned.patient.patientId, normal.patientId);
  assert.equal(store.listPatients(organization.orgId).length, 1);
  assert.throws(
    () => store.createPatient(organization.orgId, {
      displayName: "Duplicate",
      patientIdentifiers: [identifier]
    }),
    /already belongs to another patient/
  );
  const replacement = store.createPatient(organization.orgId, {
    displayName: "Replacement"
  });
  assert.throws(
    () => store.updatePatient(organization.orgId, replacement.patientId, {
      patientIdentifiers: [identifier]
    }),
    /already belongs to another patient/
  );
  store.updatePatient(organization.orgId, normal.patientId, { patientIdentifiers: [] });
  assert.equal(
    store.updatePatient(organization.orgId, replacement.patientId, {
      patientIdentifiers: [identifier]
    }).patientIdentifiers[0].patientNumber,
    "1004"
  );
});

test("keeps facility identifiers separate and detects inconsistent mappings", () => {
  const store = new MemoryPlatformStore({
    now: () => new Date("2026-07-29T00:00:00.000Z")
  });
  const organization = store.createOrganization({
    organizationCode: "Boundary Clinic",
    displayName: "Boundary Clinic"
  });
  const first = store.provisionPatientFromIdentifier(organization.orgId, {
    sourceSystem: "homis",
    facilityId: "fac_001",
    patientNumber: "1004",
    sidecarPatientKey: `sidecar_patient_${"c".repeat(26)}`
  });
  const second = store.provisionPatientFromIdentifier(organization.orgId, {
    sourceSystem: "homis",
    facilityId: "fac_002",
    patientNumber: "1004",
    sidecarPatientKey: `sidecar_patient_${"d".repeat(26)}`
  });
  const unlinked = store.createPatient(organization.orgId, {
    displayName: "Identifier Unknown"
  });

  assert.notEqual(first.patient.patientId, second.patient.patientId);
  assert.equal(store.listPatients(organization.orgId).length, 3);
  assert.equal(unlinked.provenance, undefined);
  assert.equal(
    store.listPatients(organization.orgId)
      .filter((patient) => patient.provenance?.source === "sidecar_auto_provision")
      .length,
    2
  );

  const mapping = [...store.patientIdentifierIndexForOrg(organization.orgId).values()][0];
  mapping.patientId = "pat_missing";
  assert.throws(
    () => store.provisionPatientFromIdentifier(organization.orgId, {
      sourceSystem: "homis",
      facilityId: "fac_001",
      patientNumber: "1004",
      sidecarPatientKey: first.patient.patientId
    }),
    /mapping is inconsistent/
  );
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
    safePayload: { memberId: member.memberId, displayName: "Admin" }
  });
  const dataRequest = store.createDataRequest(organization.orgId, {
    requestType: "deletion",
    requesterMemberId: member.memberId,
    subjectPatientId: "pat_123",
    productIds: ["charting", "unknown"],
    safePayload: { patientId: "pat_123", displayName: "Patient" }
  });

  assert.equal(member.loginId, "admin");
  assert.equal(identity.memberId, member.memberId);
  assert.equal(identity.mfaRequired, true);
  assert.match(identity.passwordHash, /^scrypt\$/);
  assert.equal(store.listFacilities(organization.orgId).length, 1);
  assert.equal(department.departmentId, "dep_004");
  assert.equal(entitlement.productId, "charting");
  assert.equal(auditEvent.eventId, "aud_005");
  assert.equal(auditEvent.safePayload.displayName, undefined);
  assert.equal(dataRequest.requestId, "drq_006");
  assert.deepEqual(dataRequest.productIds, ["charting"]);
  assert.equal(dataRequest.safePayload.displayName, undefined);
  assert.equal(store.listDataRequests(organization.orgId).length, 1);
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
  const dataRequest = store.createDataRequest(organization.orgId, {
    requestType: "access",
    subjectPatientId: patient.patientId
  });
  assert.equal(store.updateDataRequest(organization.orgId, dataRequest.requestId, {
    status: "completed",
    completedAt: "2026-05-28T00:00:00.000Z"
  }).status, "completed");
  assert.equal(store.getSignupApplication(signupApplication.applicationId).organizationCode, "signup-clinic");
  assert.equal(store.listSignupApplications().length, 1);

  store.consumeRateLimit("login:local:clinic:doctor", { limit: 1, windowSeconds: 60 });
  assert.throws(
    () => store.consumeRateLimit("login:local:clinic:doctor", { limit: 1, windowSeconds: 60 }),
    /Too many requests/
  );
});

test("provisions organizations from verified signup applications", () => {
  let idCounter = 0;
  let tokenCounter = 0;
  const store = new MemoryPlatformStore({
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++idCounter).padStart(3, "0")}`,
    tokenFactory: (prefix) => `${prefix}_${String(++tokenCounter).padStart(3, "0")}`
  });
  const created = store.createSignupApplicationWithEmailToken({
    organizationCode: "Signup Clinic",
    organizationDisplayName: "Signup Clinic",
    applicantName: "Admin User",
    applicantEmail: "Admin@example.com",
    requestedProducts: ["charting", "fee"]
  });
  const provisioned = store.verifySignupEmail({
    token: created.emailVerification.token
  });
  const setup = store.setupAdminPassword({
    token: provisioned.passwordSetup.token,
    password: "correct horse battery staple"
  });
  const identity = store.getLoginIdentity("signup-clinic", "admin@example.com");

  assert.equal(created.signupApplication.status, "submitted");
  assert.equal(created.emailVerification.token, "emv_001");
  assert.equal(provisioned.signupApplication.status, "provisioned");
  assert.equal(provisioned.organization.organizationCode, "signup-clinic");
  assert.equal(provisioned.adminMember.loginId, "admin@example.com");
  assert.deepEqual(provisioned.adminMember.productRoles, {
    charting: ["admin"]
  });
  assert.equal(provisioned.productEntitlements.length, 1);
  assert.equal(provisioned.productEntitlements[0].productId, "charting");
  assert.equal(setup.login.organizationCode, "signup-clinic");
  assert.equal(setup.login.loginId, "admin@example.com");
  assert.equal(store.getProductEntitlement(provisioned.organization.orgId, "charting").status, "trialing");
  assert.equal(store.getProductEntitlement(provisioned.organization.orgId, "fee"), null);
  assert.equal(verifyPassword("correct horse battery staple", identity.passwordHash), true);
  assert.equal(store.listAuditEvents(provisioned.organization.orgId).length, 3);
  assert.throws(
    () => store.verifySignupEmail({ token: created.emailVerification.token }),
    /already used/
  );
  assert.throws(
    () => store.setupAdminPassword({ token: provisioned.passwordSetup.token, password: "new secure password" }),
    /already used/
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
