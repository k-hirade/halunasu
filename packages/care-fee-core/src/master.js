import { readFileSync } from "node:fs";

const defaultMaster = deepFreeze(JSON.parse(readFileSync(
  new URL("../data/emergency-treatment-master.json", import.meta.url),
  "utf8"
)));

export function loadDefaultEmergencyTreatmentMaster() {
  return defaultMaster;
}

export function validateEmergencyTreatmentMaster(master = {}) {
  const errors = [];
  if (master.schemaVersion !== "care-service-code-master-v1") {
    errors.push("schemaVersion must be care-service-code-master-v1");
  }
  if (typeof master.masterVersion !== "string" || !master.masterVersion.trim()) {
    errors.push("masterVersion is required");
  }
  if (!Array.isArray(master.records) || master.records.length === 0) {
    errors.push("records must not be empty");
  }

  const keys = new Set();
  for (const [index, record] of (master.records || []).entries()) {
    const prefix = `records.${index}`;
    for (const field of [
      "serviceCode",
      "serviceCodeName",
      "careServiceType",
      "facilityVariant",
      "unitKind",
      "effectiveFrom",
      "effectiveTo"
    ]) {
      if (typeof record[field] !== "string" || !record[field].trim()) {
        errors.push(`${prefix}.${field} is required`);
      }
    }
    if (!Number.isFinite(record.unitScore) || record.unitScore <= 0) {
      errors.push(`${prefix}.unitScore must be positive`);
    }
    if (record.effectiveFrom > record.effectiveTo) {
      errors.push(`${prefix} has an invalid effective period`);
    }
    const key = [record.serviceCode, record.effectiveFrom, record.effectiveTo].join(":");
    if (keys.has(key)) {
      errors.push(`${prefix} duplicates ${key}`);
    }
    keys.add(key);
  }

  if (errors.length > 0) {
    const error = new Error(`Emergency treatment master is invalid: ${errors.join("; ")}`);
    error.name = "CareFeeMasterError";
    error.errors = errors;
    throw error;
  }
  return master;
}

export function resolveEmergencyTreatmentMaster(input = {}, master = defaultMaster) {
  validateEmergencyTreatmentMaster(master);
  const serviceDate = String(input.serviceDate || input.treatmentDate || "").trim();
  const careServiceType = String(input.careServiceType || "").trim();
  const preferredServiceCode = String(input.preferredServiceCode || "").trim();
  const facilityVariant = String(input.facilityVariant || "").trim();

  const candidates = master.records.filter((record) => (
    record.careServiceType === careServiceType
    && record.effectiveFrom <= serviceDate
    && serviceDate <= record.effectiveTo
  ));
  if (candidates.length === 0) {
    return Object.freeze({
      status: "not_found",
      masterVersion: master.masterVersion,
      candidates: []
    });
  }

  const selectedByCode = preferredServiceCode
    ? candidates.filter((record) => record.serviceCode === preferredServiceCode)
    : [];
  const selectedByVariant = facilityVariant
    ? candidates.filter((record) => record.facilityVariant === facilityVariant)
    : [];
  const selected = selectedByCode.length === 1
    ? selectedByCode[0]
    : selectedByVariant.length === 1
      ? selectedByVariant[0]
      : candidates.length === 1
        ? candidates[0]
        : null;

  if (!selected) {
    return Object.freeze({
      status: "ambiguous",
      masterVersion: master.masterVersion,
      unitScore: allSame(candidates.map((record) => record.unitScore)) ? candidates[0].unitScore : null,
      candidates: candidates.map(publicRecord)
    });
  }

  return Object.freeze({
    status: "resolved",
    masterVersion: master.masterVersion,
    ...publicRecord(selected),
    candidates: [publicRecord(selected)]
  });
}

function publicRecord(record) {
  return Object.freeze({
    serviceCode: record.serviceCode,
    serviceCodeName: record.serviceCodeName,
    careServiceType: record.careServiceType,
    facilityVariant: record.facilityVariant,
    unitScore: record.unitScore,
    unitKind: record.unitKind,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo
  });
}

function allSame(values) {
  return new Set(values).size === 1;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
