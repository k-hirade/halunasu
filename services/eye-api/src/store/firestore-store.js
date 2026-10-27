import {
  collections,
  eyeAppointmentPath,
  eyeAuditLogPath,
  eyeDailyCounterPath,
  eyeDocumentPath,
  eyeDrugPresetPath,
  eyeEncounterPath,
  eyeEncounterVersionPath,
  eyeOrderSetPath,
  eyePatientProfilePath,
  eyePhrasePath,
  organizationPath
} from "../../../../packages/firestore-schema/src/index.js";
import { sortByDate } from "../../../../packages/eye-core/src/index.js";
import { createId } from "../ids.js";
import { sortAppointments, storeError } from "./memory-store.js";

export class FirestoreEyeStore {
  constructor(options = {}) {
    if (!options.db) throw new TypeError("db is required");
    this.db = options.db;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
  }

  async createEncounter(orgId, encounter) {
    await this.doc(eyeEncounterPath(orgId, encounter.encounterId)).create(encounter);
    return encounter;
  }

  async getEncounter(orgId, encounterId) {
    return dataOrNull(await this.doc(eyeEncounterPath(orgId, encounterId)).get());
  }

  async listPatientEncounters(orgId, patientId) {
    const snapshot = await this.orgCollection(orgId, collections.eyeEncounters)
      .where("patientId", "==", patientId)
      .get();
    return sortByDate(docs(snapshot));
  }

  async listEncountersByDate(orgId, encounterDate) {
    const snapshot = await this.orgCollection(orgId, collections.eyeEncounters)
      .where("encounterDate", "==", encounterDate)
      .get();
    return docs(snapshot).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async replaceEncounter(orgId, encounter, expectedRevision, version = null) {
    return this.db.runTransaction(async (transaction) => {
      const ref = this.doc(eyeEncounterPath(orgId, encounter.encounterId));
      const current = dataOrNull(await transaction.get(ref));
      if (!current) throw storeError("NotFoundError", 404, "encounter not found");
      if (current.revision !== expectedRevision) {
        throw storeError("ConflictError", 409, "encounter was updated by someone else; reload and try again");
      }
      if (version) {
        const versionRef = this.doc(eyeEncounterVersionPath(orgId, version.versionId));
        if ((await transaction.get(versionRef)).exists) {
          throw storeError("ConflictError", 409, "version already exists");
        }
        transaction.create(versionRef, version);
      }
      transaction.set(ref, encounter);
      return encounter;
    });
  }

  async deleteDraftEncounter(orgId, encounterId, expectedRevision) {
    return this.db.runTransaction(async (transaction) => {
      const ref = this.doc(eyeEncounterPath(orgId, encounterId));
      const current = dataOrNull(await transaction.get(ref));
      if (!current) throw storeError("NotFoundError", 404, "encounter not found");
      if (current.revision !== expectedRevision) {
        throw storeError("ConflictError", 409, "encounter was updated by someone else; reload and try again");
      }
      if (current.versionCount > 0) throw storeError("ConflictError", 409, "finalized encounters cannot be deleted");
      transaction.delete(ref);
      return current;
    });
  }

  async listVersions(orgId, encounterId) {
    const snapshot = await this.orgCollection(orgId, collections.eyeEncounterVersions)
      .where("encounterId", "==", encounterId)
      .get();
    return docs(snapshot).sort((left, right) => left.version - right.version);
  }

  async getVersion(orgId, versionId) {
    return dataOrNull(await this.doc(eyeEncounterVersionPath(orgId, versionId)).get());
  }

  async upsertDrugPreset(orgId, preset) {
    const ref = this.doc(eyeDrugPresetPath(orgId, preset.presetId));
    const current = dataOrNull(await ref.get());
    const saved = {
      ...current,
      ...preset,
      orgId,
      createdAt: current?.createdAt || this.timestamp(),
      updatedAt: this.timestamp()
    };
    await ref.set(saved);
    return saved;
  }

  async listDrugPresets(orgId) {
    return docs(await this.orgCollection(orgId, collections.eyeDrugPresets).get())
      .sort((left, right) => String(left.name).localeCompare(String(right.name), "ja"));
  }

  async createDocument(orgId, document) {
    await this.doc(eyeDocumentPath(orgId, document.documentId)).create(document);
    return document;
  }

  async getDocument(orgId, documentId) {
    return dataOrNull(await this.doc(eyeDocumentPath(orgId, documentId)).get());
  }

  async listPatientDocuments(orgId, patientId) {
    const snapshot = await this.orgCollection(orgId, collections.eyeDocuments).where("patientId", "==", patientId).get();
    return docs(snapshot).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async replaceDocument(orgId, document, expectedRevision) {
    return this.db.runTransaction(async (transaction) => {
      const ref = this.doc(eyeDocumentPath(orgId, document.documentId));
      const current = dataOrNull(await transaction.get(ref));
      if (!current) throw storeError("NotFoundError", 404, "document not found");
      if (current.revision !== expectedRevision) throw storeError("ConflictError", 409, "document was updated by someone else; reload and try again");
      transaction.set(ref, document);
      return document;
    });
  }

  async upsertOrderSet(orgId, item) {
    return this.upsertNamed(eyeOrderSetPath(orgId, item.setId), orgId, item);
  }

  async listOrderSets(orgId) {
    return this.listNamed(orgId, collections.eyeOrderSets);
  }

  async upsertPhrase(orgId, item) {
    return this.upsertNamed(eyePhrasePath(orgId, item.phraseId), orgId, item);
  }

  async listPhrases(orgId) {
    return this.listNamed(orgId, collections.eyePhrases);
  }

  async upsertNamed(path, orgId, item) {
    const ref = this.doc(path);
    const current = dataOrNull(await ref.get());
    const saved = { ...current, ...item, orgId, createdAt: current?.createdAt || this.timestamp(), updatedAt: this.timestamp() };
    await ref.set(saved);
    return saved;
  }

  async listNamed(orgId, collectionName) {
    return docs(await this.orgCollection(orgId, collectionName).get())
      .sort((left, right) => String(left.name || left.label || left.text).localeCompare(String(right.name || right.label || right.text), "ja"));
  }

  async getPatientProfile(orgId, patientId) {
    return dataOrNull(await this.doc(eyePatientProfilePath(orgId, patientId)).get());
  }

  async savePatientProfile(orgId, profile, expectedRevision) {
    return this.db.runTransaction(async (transaction) => {
      const ref = this.doc(eyePatientProfilePath(orgId, profile.patientId));
      const current = dataOrNull(await transaction.get(ref));
      if ((current?.revision || 0) !== expectedRevision) {
        throw storeError("ConflictError", 409, "patient profile was updated by someone else; reload and try again");
      }
      transaction.set(ref, profile);
      return profile;
    });
  }

  async createAppointment(orgId, appointment, { assignQueueNumber = false } = {}) {
    return this.db.runTransaction(async (transaction) => {
      const ref = this.doc(eyeAppointmentPath(orgId, appointment.appointmentId));
      if ((await transaction.get(ref)).exists) throw storeError("ConflictError", 409, "appointment already exists");
      const saved = assignQueueNumber
        ? { ...appointment, queueNumber: await this.reserveQueueNumber(transaction, orgId, appointment.date) }
        : appointment;
      transaction.create(ref, saved);
      return saved;
    });
  }

  async getAppointment(orgId, appointmentId) {
    return dataOrNull(await this.doc(eyeAppointmentPath(orgId, appointmentId)).get());
  }

  async listAppointmentsByDate(orgId, date) {
    const snapshot = await this.orgCollection(orgId, collections.eyeAppointments).where("date", "==", date).get();
    return sortAppointments(docs(snapshot));
  }

  async listPatientAppointments(orgId, patientId) {
    const snapshot = await this.orgCollection(orgId, collections.eyeAppointments).where("patientId", "==", patientId).get();
    return sortAppointments(docs(snapshot));
  }

  async replaceAppointment(orgId, appointment, expectedRevision, { assignQueueNumber = false } = {}) {
    return this.db.runTransaction(async (transaction) => {
      const ref = this.doc(eyeAppointmentPath(orgId, appointment.appointmentId));
      const current = dataOrNull(await transaction.get(ref));
      if (!current) throw storeError("NotFoundError", 404, "appointment not found");
      if (current.revision !== expectedRevision) {
        throw storeError("ConflictError", 409, "appointment was updated by someone else; reload and try again");
      }
      const saved = assignQueueNumber
        ? { ...appointment, queueNumber: await this.reserveQueueNumber(transaction, orgId, appointment.date) }
        : appointment;
      transaction.set(ref, saved);
      return saved;
    });
  }

  // トランザクション内の読み取りは書き込みより前に済ませる必要がある。
  async reserveQueueNumber(transaction, orgId, date) {
    const ref = this.doc(eyeDailyCounterPath(orgId, date));
    const current = dataOrNull(await transaction.get(ref));
    const next = Number(current?.lastQueueNumber || 0) + 1;
    transaction.set(ref, { date, orgId, lastQueueNumber: next, updatedAt: this.timestamp() });
    return next;
  }

  async recordAudit(orgId, entry) {
    const auditLogId = entry.auditLogId || this.idFactory("eal");
    const saved = { ...entry, auditLogId, orgId, createdAt: entry.createdAt || this.timestamp() };
    await this.doc(eyeAuditLogPath(orgId, auditLogId)).create(saved);
    return saved;
  }

  async listAuditLogs(orgId, limit = 200) {
    const snapshot = await this.orgCollection(orgId, collections.eyeAuditLogs)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return docs(snapshot);
  }

  doc(path) {
    return this.db.doc(path);
  }

  orgCollection(orgId, collectionName) {
    return this.db.doc(organizationPath(orgId)).collection(collectionName);
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export async function createEyeFirestoreDb(options = {}) {
  const [{ initializeApp, getApps }, { getFirestore }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore")
  ]);
  const projectId = options.projectId
    || process.env.EYE_GOOGLE_CLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || "halunasu-eye-stg";
  const name = "halunasu-eye-api";
  const app = getApps().find((candidate) => candidate.name === name) || initializeApp({ projectId }, name);
  return getFirestore(app);
}

function docs(snapshot) {
  return snapshot.docs.map((doc) => doc.data());
}

function dataOrNull(snapshot) {
  return snapshot.exists ? snapshot.data() : null;
}
