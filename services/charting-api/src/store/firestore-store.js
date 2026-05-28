import {
  buildChartingEncounter,
  buildMockSoapDraft,
  createId,
  patchChartingEncounter
} from "../../../../packages/charting-core/src/index.js";
import {
  chartingEncounterPath,
  collections,
  organizationPath
} from "../../../../packages/firestore-schema/src/index.js";
import { notFoundError } from "./memory-store.js";

export class FirestoreChartingStore {
  constructor(options = {}) {
    if (!options.db) {
      throw new TypeError("db is required");
    }

    this.db = options.db;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
  }

  async createEncounter(input) {
    const encounter = buildChartingEncounter(input, {
      encounterId: this.idFactory("enc"),
      now: this.timestamp()
    });

    await this.doc(chartingEncounterPath(encounter.orgId, encounter.encounterId)).set(encounter);
    return encounter;
  }

  async listEncounters(orgId) {
    const snapshot = await this.orgCollection(orgId, collections.chartingEncounters).orderBy("createdAt", "asc").get();
    return docsFromSnapshot(snapshot);
  }

  async getEncounter(orgId, encounterId) {
    return docDataOrNull(await this.doc(chartingEncounterPath(orgId, encounterId)).get());
  }

  async updateEncounter(orgId, encounterId, input) {
    const current = await this.getEncounter(orgId, encounterId);
    if (!current) {
      throw notFoundError("encounter not found");
    }

    const updated = patchChartingEncounter(current, input, {
      now: this.timestamp()
    });
    await this.doc(chartingEncounterPath(orgId, encounterId)).set(updated);
    return updated;
  }

  async createMockSoapDraft(orgId, encounterId, input) {
    const current = await this.getEncounter(orgId, encounterId);
    if (!current) {
      throw notFoundError("encounter not found");
    }

    const soapDraft = buildMockSoapDraft(current, input, {
      soapDraftId: this.idFactory("soap"),
      now: this.timestamp()
    });
    const updated = {
      ...current,
      status: "soap_ready",
      latestSoapDraftId: soapDraft.soapDraftId,
      updatedAt: this.timestamp()
    };

    await this.db.runTransaction(async (transaction) => {
      transaction.set(this.doc(chartingEncounterPath(orgId, encounterId)), updated);
      transaction.set(this.soapDraftDoc(orgId, encounterId, soapDraft.soapDraftId), soapDraft);
    });

    return { encounter: updated, soapDraft };
  }

  async listSoapDrafts(orgId, encounterId) {
    const current = await this.getEncounter(orgId, encounterId);
    if (!current) {
      throw notFoundError("encounter not found");
    }

    const snapshot = await this.doc(chartingEncounterPath(orgId, encounterId))
      .collection("soap_drafts")
      .orderBy("createdAt", "asc")
      .get();
    return docsFromSnapshot(snapshot);
  }

  doc(path) {
    return this.db.doc(path);
  }

  orgCollection(orgId, collectionName) {
    return this.doc(organizationPath(orgId)).collection(collectionName);
  }

  soapDraftDoc(orgId, encounterId, soapDraftId) {
    return this.doc(`${chartingEncounterPath(orgId, encounterId)}/soap_drafts/${soapDraftId}`);
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export async function createFirestoreDb(options = {}) {
  const [{ initializeApp, getApps }, { getFirestore }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore")
  ]);
  const projectId = options.projectId
    || process.env.CHARTING_GOOGLE_CLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || "halunasu-charting-stg";
  const app = getApps().find((candidate) => candidate.name === "halunasu-charting-api")
    || initializeApp({ projectId }, "halunasu-charting-api");

  return getFirestore(app);
}

function docsFromSnapshot(snapshot) {
  return snapshot.docs.map((doc) => doc.data());
}

function docDataOrNull(snapshot) {
  return snapshot.exists ? snapshot.data() : null;
}
