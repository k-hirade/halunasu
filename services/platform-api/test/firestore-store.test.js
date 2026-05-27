import assert from "node:assert/strict";
import { test } from "node:test";
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
    sex: "female"
  });

  assert.equal(member.memberId, "mem_002");
  assert.equal(patient.patientId, "pat_003");
  assert.equal((await store.listMembers(organization.orgId)).length, 1);
  assert.equal((await store.listPatients(organization.orgId)).length, 1);
  assert.equal((await store.getMember(organization.orgId, member.memberId)).loginId, "doctor");
  assert.equal((await store.getPatient(organization.orgId, patient.patientId)).sex, "female");
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
  return new FirestorePlatformStore({
    db: new FakeFirestoreDb(),
    now: () => new Date("2026-05-27T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
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

