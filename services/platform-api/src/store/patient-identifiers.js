import crypto from "node:crypto";

export function normalizePatientIdentifierPart(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .trim();
}

export function patientIdentifierKey(identifier = {}) {
  const sourceSystem = normalizePatientIdentifierPart(identifier.sourceSystem);
  const facilityId = normalizePatientIdentifierPart(identifier.facilityId);
  const patientNumber = normalizePatientIdentifierPart(
    identifier.patientNumber || identifier.value || identifier.externalPatientId
  );
  return sourceSystem && facilityId && patientNumber
    ? `${sourceSystem}\u001f${facilityId}\u001f${patientNumber}`
    : "";
}

export function patientIdentifierIndexId(identifier = {}) {
  const identifierKey = typeof identifier === "string"
    ? identifier
    : patientIdentifierKey(identifier);
  return identifierKey
    ? crypto.createHash("sha256").update(identifierKey).digest("hex")
    : "";
}

export function patientIdentifierKeys(patient = {}) {
  return [...new Set(
    (Array.isArray(patient.patientIdentifiers) ? patient.patientIdentifiers : [])
      .map((identifier) => patientIdentifierKey(identifier))
      .filter(Boolean)
  )];
}

export function patientMatchesIdentifier(patient = {}, input = {}) {
  const expectedKey = patientIdentifierKey(input);
  if (!expectedKey) {
    return false;
  }
  return (Array.isArray(patient.patientIdentifiers) ? patient.patientIdentifiers : []).some((identifier) => (
    patientIdentifierKey(identifier) === expectedKey
    && String(identifier?.status || "active") === "active"
  ));
}
