import {
  buildChartingEncounter,
  buildMockSoapDraft,
  createId,
  patchChartingEncounter,
  patchSoapDraft
} from "../../../../packages/charting-core/src/index.js";

export class MemoryChartingStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
    this.encountersByOrg = new Map();
    this.soapDraftsByEncounter = new Map();
  }

  createEncounter(input) {
    const encounter = buildChartingEncounter(input, {
      encounterId: this.idFactory("enc"),
      now: this.timestamp()
    });

    this.encountersForOrg(encounter.orgId).set(encounter.encounterId, encounter);
    return encounter;
  }

  listEncounters(orgId) {
    return sortByCreatedAt([...this.encountersForOrg(orgId).values()]);
  }

  getEncounter(orgId, encounterId) {
    return this.encountersForOrg(orgId).get(encounterId) || null;
  }

  updateEncounter(orgId, encounterId, input) {
    const current = this.getEncounter(orgId, encounterId);
    if (!current) {
      throw notFoundError("encounter not found");
    }

    const updated = patchChartingEncounter(current, input, {
      now: this.timestamp()
    });
    this.encountersForOrg(orgId).set(encounterId, updated);
    return updated;
  }

  createMockSoapDraft(orgId, encounterId, input) {
    const current = this.getEncounter(orgId, encounterId);
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

    this.encountersForOrg(orgId).set(encounterId, updated);
    this.soapDraftsForEncounter(encounterId).set(soapDraft.soapDraftId, soapDraft);

    return { encounter: updated, soapDraft };
  }

  listSoapDrafts(orgId, encounterId) {
    const current = this.getEncounter(orgId, encounterId);
    if (!current) {
      throw notFoundError("encounter not found");
    }

    return sortByCreatedAt([...this.soapDraftsForEncounter(encounterId).values()]);
  }

  updateSoapDraft(orgId, encounterId, soapDraftId, input) {
    const encounter = this.getEncounter(orgId, encounterId);
    if (!encounter) {
      throw notFoundError("encounter not found");
    }

    const current = this.soapDraftsForEncounter(encounterId).get(soapDraftId);
    if (!current || current.orgId !== orgId) {
      throw notFoundError("soap draft not found");
    }

    const updatedSoapDraft = patchSoapDraft(current, input, {
      now: this.timestamp()
    });
    const updatedEncounter = {
      ...encounter,
      status: updatedSoapDraft.status === "approved" ? "approved" : "soap_ready",
      latestSoapDraftId: updatedSoapDraft.soapDraftId,
      approvedAt: updatedSoapDraft.status === "approved" ? updatedSoapDraft.approvedAt : encounter.approvedAt,
      updatedAt: this.timestamp()
    };

    this.soapDraftsForEncounter(encounterId).set(soapDraftId, updatedSoapDraft);
    this.encountersForOrg(orgId).set(encounterId, updatedEncounter);

    return { encounter: updatedEncounter, soapDraft: updatedSoapDraft };
  }

  encountersForOrg(orgId) {
    if (!this.encountersByOrg.has(orgId)) {
      this.encountersByOrg.set(orgId, new Map());
    }

    return this.encountersByOrg.get(orgId);
  }

  soapDraftsForEncounter(encounterId) {
    if (!this.soapDraftsByEncounter.has(encounterId)) {
      this.soapDraftsByEncounter.set(encounterId, new Map());
    }

    return this.soapDraftsByEncounter.get(encounterId);
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export function notFoundError(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  error.statusCode = 404;
  return error;
}

function sortByCreatedAt(items) {
  return items.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}
