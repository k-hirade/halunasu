import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyPassword } from "../src/auth/password.js";
import { FirestorePlatformStore } from "../src/store/firestore-store.js";

test("stores organizations with organization code uniqueness", async () => {
  const store = createTestStore();

  const organization = await store.createOrganization({
    organizationCode: "Clinic A",
    displayName: "Clinic A"
  });

  assert.equal(organization.orgId, "org_001");
  assert.equal(organization.organizationCode, "clinic-a");
  assert.equal((await store.getOrganization("org_001")).displayName, "Clinic A");
  assert.equal((await store.listOrganizations()).length, 1);
  await assert.rejects(
    () => store.createOrganization({ organizationCode: "Clinic A", displayName: "Duplicate" }),
    /already exists/
  );
});

test("stores members and patients below organization documents", async () => {
  const store = createTestStore();
  const organization = await store.createOrganization({
    organizationCode: "Clinic B",
    displayName: "Clinic B"
  });
  const member = await store.createMember(organization.orgId, {
    loginId: "doctor",
    displayName: "Doctor"
  });
  const patient = await store.createPatient(organization.orgId, {
    displayName: "Patient",
    birthDate: "1970-01-01",
    sex: "female",
    primaryPatientNumber: "000123",
    patientIdentifiers: [{ sourceSystem: "legacy", patientNumber: "legacy-001" }]
  });

  assert.equal(member.memberId, "mem_002");
  assert.equal(patient.patientId, "pat_003");
  assert.equal((await store.listMembers(organization.orgId)).length, 1);
  assert.equal((await store.listPatients(organization.orgId)).length, 1);
  assert.equal((await store.getMember(organization.orgId, member.memberId)).loginId, "doctor");
  assert.equal((await store.getPatient(organization.orgId, patient.patientId)).sex, "female");
  assert.equal((await store.getPatient(organization.orgId, patient.patientId)).primaryPatientNumber, "000123");
  assert.equal((await store.getPatient(organization.orgId, patient.patientId)).patientIdentifiers[0].value, "legacy-001");
});

test("stores login identities and shared master data", async () => {
  const store = createTestStore();
  const organization = await store.createOrganization({
    organizationCode: "Clinic Auth",
    displayName: "Clinic Auth"
  });
  const member = await store.createMember(organization.orgId, {
    loginId: "Admin",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    password: "correct horse battery staple"
  });
  const identity = await store.getLoginIdentity("clinic-auth", "admin");
  const facility = await store.createFacility(organization.orgId, {
    displayName: "Main Clinic",
    medicalInstitutionCode: "1234567"
  });
  const department = await store.createDepartment(organization.orgId, {
    facilityId: facility.facilityId,
    displayName: "Internal Medicine"
  });
  const entitlement = await store.upsertProductEntitlement(organization.orgId, {
    productId: "charting",
    status: "enabled"
  });
  const auditEvent = await store.createAuditEvent(organization.orgId, {
    eventType: "member.created",
    actorMemberId: member.memberId,
    safePayload: { memberId: member.memberId, displayName: "Admin" }
  });
  const dataRequest = await store.createDataRequest(organization.orgId, {
    requestType: "deletion",
    requesterMemberId: member.memberId,
    subjectPatientId: "pat_123",
    productIds: ["charting", "unknown"],
    safePayload: { patientId: "pat_123", displayName: "Patient" }
  });

  assert.equal(member.loginId, "admin");
  assert.equal(identity.memberId, member.memberId);
  assert.match(identity.passwordHash, /^scrypt\$/);
  assert.equal((await store.listFacilities(organization.orgId)).length, 1);
  assert.equal((await store.getDepartment(organization.orgId, department.departmentId)).displayName, "Internal Medicine");
  assert.equal((await store.listDepartments(organization.orgId)).length, 1);
  assert.equal(entitlement.productId, "charting");
  assert.equal((await store.getProductEntitlement(organization.orgId, "charting")).status, "enabled");
  assert.equal(auditEvent.eventType, "member.created");
  assert.equal(auditEvent.safePayload.displayName, undefined);
  assert.equal(dataRequest.requestId, "drq_006");
  assert.deepEqual(dataRequest.productIds, ["charting"]);
  assert.equal(dataRequest.safePayload.displayName, undefined);
  assert.equal((await store.listDataRequests(organization.orgId)).length, 1);
  assert.equal((await store.listAuditEvents(organization.orgId)).length, 1);
});

test("updates login identity auth state", async () => {
  const store = createTestStore();
  const organization = await store.createOrganization({
    organizationCode: "Clinic State",
    displayName: "Clinic State"
  });
  await store.createMember(organization.orgId, {
    loginId: "admin",
    displayName: "Admin",
    password: "correct horse battery staple"
  });
  const identity = await store.getLoginIdentity("clinic-state", "admin");

  const failed = await store.recordLoginFailure(identity);
  const enrolled = await store.beginMfaEnrollment(failed, "MZXW6YTBOI======");
  const verified = await store.completeMfaEnrollment(enrolled);
  const revoked = await store.revokeMemberSessions(verified);

  assert.equal(failed.failedLoginCount, 1);
  assert.equal(enrolled.mfaPendingSecret, undefined);
  assert.match(enrolled.mfaPendingSecretEncrypted, /^(plain:|v1:)/);
  assert.equal(verified.mfaEnrolled, true);
  assert.equal(verified.mfaSecret, undefined);
  assert.match(verified.mfaSecretEncrypted, /^(plain:|v1:)/);
  assert.equal(verified.tokenVersion, 2);
  assert.equal(revoked.tokenVersion, 3);
});

test("updates platform resources and applies rate limits", async () => {
  const store = createTestStore();
  const organization = await store.createOrganization({
    organizationCode: "Clinic Update",
    displayName: "Clinic Update"
  });
  const signupApplication = await store.createSignupApplication({
    organizationCode: "Signup Clinic",
    organizationDisplayName: "Signup Clinic",
    applicantName: "Applicant",
    applicantEmail: "Applicant@example.com"
  });
  const member = await store.createMember(organization.orgId, {
    loginId: "doctor",
    displayName: "Doctor",
    password: "correct horse battery staple"
  });
  const facility = await store.createFacility(organization.orgId, {
    displayName: "Main Clinic"
  });
  const department = await store.createDepartment(organization.orgId, {
    displayName: "Internal Medicine"
  });
  const patient = await store.createPatient(organization.orgId, {
    displayName: "Patient"
  });
  await store.upsertProductEntitlement(organization.orgId, {
    productId: "charting",
    status: "trialing"
  });

  assert.equal((await store.updateOrganization(organization.orgId, { displayName: "Updated" })).displayName, "Updated");
  assert.equal((await store.updateMember(organization.orgId, member.memberId, { displayName: "Updated Doctor" })).displayName, "Updated Doctor");
  assert.equal((await store.updateFacility(organization.orgId, facility.facilityId, { medicalInstitutionCode: "1234567" })).medicalInstitutionCode, "1234567");
  assert.equal((await store.updateDepartment(organization.orgId, department.departmentId, { facilityId: facility.facilityId })).facilityId, facility.facilityId);
  assert.equal((await store.updatePatient(organization.orgId, patient.patientId, { displayNameKana: "YAMADA TARO" })).displayNameKana, "YAMADA TARO");
  assert.equal((await store.updateProductEntitlement(organization.orgId, "charting", { status: "enabled" })).status, "enabled");
  const dataRequest = await store.createDataRequest(organization.orgId, {
    requestType: "access",
    subjectPatientId: patient.patientId
  });
  assert.equal((await store.updateDataRequest(organization.orgId, dataRequest.requestId, {
    status: "completed",
    completedAt: "2026-05-28T00:00:00.000Z"
  })).status, "completed");
  assert.equal((await store.getSignupApplication(signupApplication.applicationId)).organizationCode, "signup-clinic");
  assert.equal((await store.listSignupApplications()).length, 1);

  await store.consumeRateLimit("login:local:clinic:doctor", { limit: 1, windowSeconds: 60 });
  await assert.rejects(
    () => store.consumeRateLimit("login:local:clinic:doctor", { limit: 1, windowSeconds: 60 }),
    /Too many requests/
  );
});

test("provisions organizations from verified signup applications", async () => {
  const store = createTestStore();
  const created = await store.createSignupApplicationWithEmailToken({
    organizationCode: "Signup Clinic",
    organizationDisplayName: "Signup Clinic",
    applicantName: "Admin User",
    applicantEmail: "Admin@example.com",
    requestedProducts: ["charting", "fee"]
  });
  const provisioned = await store.verifySignupEmail({
    token: created.emailVerification.token
  });
  const setup = await store.setupAdminPassword({
    token: provisioned.passwordSetup.token,
    password: "correct horse battery staple"
  });
  const identity = await store.getLoginIdentity("signup-clinic", "admin@example.com");

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
  assert.equal((await store.getProductEntitlement(provisioned.organization.orgId, "charting")).status, "trialing");
  assert.equal(await store.getProductEntitlement(provisioned.organization.orgId, "fee"), null);
  assert.equal(verifyPassword("correct horse battery staple", identity.passwordHash), true);
  assert.equal((await store.listAuditEvents(provisioned.organization.orgId)).length, 3);
  await assert.rejects(
    () => store.verifySignupEmail({ token: created.emailVerification.token }),
    /already used/
  );
  await assert.rejects(
    () => store.setupAdminPassword({ token: provisioned.passwordSetup.token, password: "new secure password" }),
    /already used/
  );
});

test("rejects child writes for missing organization", async () => {
  const store = createTestStore();

  await assert.rejects(
    () => store.createPatient("org_missing", { displayName: "Patient" }),
    /organization not found/
  );
});

function createTestStore() {
  let counter = 0;
  let tokenCounter = 0;
  return new FirestorePlatformStore({
    db: new FakeFirestoreDb(),
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`,
    tokenFactory: (prefix) => `${prefix}_${String(++tokenCounter).padStart(3, "0")}`
  });
}

class FakeFirestoreDb {
  constructor() {
    this.documents = new Map();
  }

  doc(path) {
    return new FakeDocumentRef(this, path);
  }

  collection(path) {
    return new FakeCollectionRef(this, path);
  }

  async runTransaction(callback) {
    return callback(new FakeTransaction(this));
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
  }

  async get(ref) {
    return ref.get();
  }

  set(ref, value) {
    this.db.documents.set(ref.path, structuredClone(value));
  }
}

class FakeDocumentRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  async get() {
    const value = this.db.documents.get(this.path);
    return new FakeDocumentSnapshot(value);
  }

  async set(value) {
    this.db.documents.set(this.path, structuredClone(value));
  }

  collection(collectionName) {
    return new FakeCollectionRef(this.db, `${this.path}/${collectionName}`);
  }
}

class FakeCollectionRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  orderBy(fieldName, direction) {
    return new FakeQuery(this.db, this.path, fieldName, direction);
  }
}

class FakeQuery {
  constructor(db, path, fieldName, direction) {
    this.db = db;
    this.path = path;
    this.fieldName = fieldName;
    this.direction = direction;
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.documents.entries()]
      .filter(([path]) => path.startsWith(prefix) && path.slice(prefix.length).split("/").length === 1)
      .map(([, value]) => new FakeDocumentSnapshot(value))
      .sort((left, right) => compare(left.data()[this.fieldName], right.data()[this.fieldName], this.direction));

    return { docs };
  }
}

class FakeDocumentSnapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return structuredClone(this.value);
  }
}

function compare(left, right, direction) {
  const result = String(left).localeCompare(String(right));
  return direction === "desc" ? -result : result;
}
