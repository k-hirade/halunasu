import { sortByDate } from "../../../../packages/eye-core/src/index.js";
import { createId } from "../ids.js";

export class MemoryEyeStore {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || createId;
    this.encounters = new Map();
    this.versions = new Map();
    this.drugPresets = new Map();
    this.auditLogs = new Map();
    this.appointments = new Map();
    this.dailyCounters = new Map();
    this.patientProfiles = new Map();
    this.orderSets = new Map();
    this.phrases = new Map();
  }

  upsertOrderSet(orgId, item) {
    return this.upsertNamed(this.orderSets, orgId, item, "setId");
  }

  listOrderSets(orgId) {
    return this.listNamed(this.orderSets, orgId);
  }

  upsertPhrase(orgId, item) {
    return this.upsertNamed(this.phrases, orgId, item, "phraseId");
  }

  listPhrases(orgId) {
    return this.listNamed(this.phrases, orgId);
  }

  upsertNamed(map, orgId, item, idKey) {
    const records = this.forOrg(map, orgId);
    const current = records.get(item[idKey]);
    const saved = { ...current, ...item, orgId, createdAt: current?.createdAt || this.timestamp(), updatedAt: this.timestamp() };
    records.set(item[idKey], clone(saved));
    return clone(saved);
  }

  listNamed(map, orgId) {
    return [...this.forOrg(map, orgId).values()]
      .sort((left, right) => String(left.name || left.label || left.text).localeCompare(String(right.name || right.label || right.text), "ja"))
      .map(clone);
  }

  getPatientProfile(orgId, patientId) {
    return cloneOrNull(this.forOrg(this.patientProfiles, orgId).get(patientId));
  }

  savePatientProfile(orgId, profile, expectedRevision) {
    const records = this.forOrg(this.patientProfiles, orgId);
    const currentRevision = records.get(profile.patientId)?.revision || 0;
    if (currentRevision !== expectedRevision) {
      throw storeError("ConflictError", 409, "patient profile was updated by someone else; reload and try again");
    }
    records.set(profile.patientId, clone(profile));
    return clone(profile);
  }

  createEncounter(orgId, encounter) {
    const records = this.forOrg(this.encounters, orgId);
    if (records.has(encounter.encounterId)) throw storeError("ConflictError", 409, "encounter already exists");
    records.set(encounter.encounterId, clone(encounter));
    return clone(encounter);
  }

  getEncounter(orgId, encounterId) {
    return cloneOrNull(this.forOrg(this.encounters, orgId).get(encounterId));
  }

  listPatientEncounters(orgId, patientId) {
    return sortByDate([...this.forOrg(this.encounters, orgId).values()]
      .filter((encounter) => encounter.patientId === patientId))
      .map(clone);
  }

  listEncountersByDate(orgId, encounterDate) {
    return [...this.forOrg(this.encounters, orgId).values()]
      .filter((encounter) => encounter.encounterDate === encounterDate)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map(clone);
  }

  replaceEncounter(orgId, encounter, expectedRevision, version = null) {
    const records = this.forOrg(this.encounters, orgId);
    const current = records.get(encounter.encounterId);
    if (!current) throw storeError("NotFoundError", 404, "encounter not found");
    if (current.revision !== expectedRevision) {
      throw storeError("ConflictError", 409, "encounter was updated by someone else; reload and try again");
    }
    if (version) {
      const versions = this.forOrg(this.versions, orgId);
      if (versions.has(version.versionId)) throw storeError("ConflictError", 409, "version already exists");
      versions.set(version.versionId, clone(version));
    }
    records.set(encounter.encounterId, clone(encounter));
    return clone(encounter);
  }

  deleteDraftEncounter(orgId, encounterId, expectedRevision) {
    const records = this.forOrg(this.encounters, orgId);
    const current = records.get(encounterId);
    if (!current) throw storeError("NotFoundError", 404, "encounter not found");
    if (current.revision !== expectedRevision) {
      throw storeError("ConflictError", 409, "encounter was updated by someone else; reload and try again");
    }
    if (current.versionCount > 0) throw storeError("ConflictError", 409, "finalized encounters cannot be deleted");
    records.delete(encounterId);
    return clone(current);
  }

  listVersions(orgId, encounterId) {
    return [...this.forOrg(this.versions, orgId).values()]
      .filter((version) => version.encounterId === encounterId)
      .sort((left, right) => left.version - right.version)
      .map(clone);
  }

  getVersion(orgId, versionId) {
    return cloneOrNull(this.forOrg(this.versions, orgId).get(versionId));
  }

  upsertDrugPreset(orgId, preset) {
    const records = this.forOrg(this.drugPresets, orgId);
    const current = records.get(preset.presetId);
    const saved = {
      ...current,
      ...preset,
      orgId,
      createdAt: current?.createdAt || this.timestamp(),
      updatedAt: this.timestamp()
    };
    records.set(preset.presetId, clone(saved));
    return clone(saved);
  }

  listDrugPresets(orgId) {
    return [...this.forOrg(this.drugPresets, orgId).values()]
      .sort((left, right) => String(left.name).localeCompare(String(right.name), "ja"))
      .map(clone);
  }

  createAppointment(orgId, appointment, { assignQueueNumber = false } = {}) {
    const records = this.forOrg(this.appointments, orgId);
    if (records.has(appointment.appointmentId)) throw storeError("ConflictError", 409, "appointment already exists");
    const saved = assignQueueNumber ? { ...appointment, queueNumber: this.nextQueueNumber(orgId, appointment.date) } : appointment;
    records.set(saved.appointmentId, clone(saved));
    return clone(saved);
  }

  getAppointment(orgId, appointmentId) {
    return cloneOrNull(this.forOrg(this.appointments, orgId).get(appointmentId));
  }

  listAppointmentsByDate(orgId, date) {
    return sortAppointments([...this.forOrg(this.appointments, orgId).values()].filter((item) => item.date === date)).map(clone);
  }

  listPatientAppointments(orgId, patientId) {
    return sortAppointments([...this.forOrg(this.appointments, orgId).values()].filter((item) => item.patientId === patientId)).map(clone);
  }

  replaceAppointment(orgId, appointment, expectedRevision, { assignQueueNumber = false } = {}) {
    const records = this.forOrg(this.appointments, orgId);
    const current = records.get(appointment.appointmentId);
    if (!current) throw storeError("NotFoundError", 404, "appointment not found");
    if (current.revision !== expectedRevision) {
      throw storeError("ConflictError", 409, "appointment was updated by someone else; reload and try again");
    }
    const saved = assignQueueNumber ? { ...appointment, queueNumber: this.nextQueueNumber(orgId, appointment.date) } : appointment;
    records.set(saved.appointmentId, clone(saved));
    return clone(saved);
  }

  nextQueueNumber(orgId, date) {
    const counters = this.forOrg(this.dailyCounters, orgId);
    const next = (counters.get(date) || 0) + 1;
    counters.set(date, next);
    return next;
  }

  recordAudit(orgId, entry) {
    const auditLogId = entry.auditLogId || this.idFactory("eal");
    const saved = { ...entry, auditLogId, orgId, createdAt: entry.createdAt || this.timestamp() };
    this.forOrg(this.auditLogs, orgId).set(auditLogId, clone(saved));
    return clone(saved);
  }

  listAuditLogs(orgId, limit = 200) {
    return [...this.forOrg(this.auditLogs, orgId).values()]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, limit)
      .map(clone);
  }

  forOrg(map, orgId) {
    if (!map.has(orgId)) map.set(orgId, new Map());
    return map.get(orgId);
  }

  timestamp() {
    return this.now().toISOString();
  }
}

export function storeError(name, statusCode, message) {
  const error = new Error(message);
  error.name = name;
  error.statusCode = statusCode;
  return error;
}

export function sortAppointments(appointments) {
  return [...appointments].sort((left, right) => (
    String(left.date).localeCompare(String(right.date))
    || String(left.time || "99:99").localeCompare(String(right.time || "99:99"))
    || String(left.createdAt).localeCompare(String(right.createdAt))
  ));
}

function clone(value) {
  return structuredClone(value);
}

function cloneOrNull(value) {
  return value ? clone(value) : null;
}
