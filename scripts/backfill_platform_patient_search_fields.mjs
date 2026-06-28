import { createFirestoreDb } from "../services/platform-api/src/store/firestore-store.js";
import { collections, organizationPath, patientPath } from "../packages/firestore-schema/src/index.js";

const apply = process.argv.includes("--apply");
const db = await createFirestoreDb({ appName: "halunasu-platform-patient-search-backfill" });
const orgSnapshot = await db.collection(collections.organizations).get();

let scanned = 0;
let updated = 0;

for (const orgDoc of orgSnapshot.docs) {
  const organization = orgDoc.data();
  const orgId = organization.orgId || orgDoc.id;
  if (!orgId) {
    continue;
  }
  const patientSnapshot = await db.doc(organizationPath(orgId)).collection(collections.patients).get();
  for (const patientDoc of patientSnapshot.docs) {
    scanned += 1;
    const patient = patientDoc.data();
    const fields = buildPatientSearchFields({
      ...patient,
      patientId: patient.patientId || patientDoc.id,
      orgId
    });
    if (!needsSearchFieldUpdate(patient, fields)) {
      continue;
    }
    updated += 1;
    if (apply) {
      await db.doc(patientPath(orgId, patient.patientId || patientDoc.id)).set({
        ...patient,
        ...fields
      });
    }
  }
}

console.log(JSON.stringify({
  apply,
  scanned,
  updated,
  message: apply ? "patient search fields backfilled" : "dry run only; rerun with --apply to write changes"
}, null, 2));

function needsSearchFieldUpdate(patient = {}, fields = {}) {
  return Object.entries(fields).some(([key, value]) => JSON.stringify(patient[key] ?? null) !== JSON.stringify(value ?? null));
}

function buildPatientSearchFields(patient = {}) {
  const primaryCode = patient.primaryPatientNumber
    || patient.patientCode
    || firstPatientIdentifierValue(patient)
    || "";
  const externalId = Array.isArray(patient.externalPatientIds) ? patient.externalPatientIds[0] : "";
  const name = normalizePatientSearchValue(patient.displayName);
  const kana = normalizePatientSearchValue(patient.displayNameKana);
  const primaryNumber = normalizePatientSearchValue(primaryCode);
  const external = normalizePatientSearchValue(externalId);
  const patientId = normalizePatientSearchValue(patient.patientId);
  return compactObject({
    patientSearchName: name || undefined,
    patientSearchKana: kana || undefined,
    patientSearchPrimaryNumber: primaryNumber || undefined,
    patientSearchExternalId: external || undefined,
    patientSearchId: patientId || undefined,
    patientSearchPrefixes: buildPatientSearchPrefixes(patient),
    patientSearchText: normalizePatientSearchValue([
      patient.displayName,
      patient.displayNameKana,
      primaryCode,
      externalId,
      patient.patientId
    ].filter(Boolean).join(" ")) || undefined
  });
}

function buildPatientSearchPrefixes(patient = {}) {
  const fields = buildPatientSearchFieldsWithoutPrefixes(patient);
  const values = [
    fields.patientSearchName,
    fields.patientSearchKana,
    fields.patientSearchPrimaryNumber,
    fields.patientSearchExternalId,
    fields.patientSearchId,
    ...normalizePatientIdentifierValues(patient)
  ].filter(Boolean);
  const prefixes = new Set();
  for (const value of values) {
    const chars = [...value].slice(0, 32);
    for (let index = 1; index <= chars.length; index += 1) {
      prefixes.add(chars.slice(0, index).join(""));
    }
  }
  return prefixes.size ? [...prefixes].slice(0, 200) : undefined;
}

function buildPatientSearchFieldsWithoutPrefixes(patient = {}) {
  const primaryCode = patient.primaryPatientNumber
    || patient.patientCode
    || firstPatientIdentifierValue(patient)
    || "";
  const externalId = Array.isArray(patient.externalPatientIds) ? patient.externalPatientIds[0] : "";
  return compactObject({
    patientSearchName: normalizePatientSearchValue(patient.displayName) || undefined,
    patientSearchKana: normalizePatientSearchValue(patient.displayNameKana) || undefined,
    patientSearchPrimaryNumber: normalizePatientSearchValue(primaryCode) || undefined,
    patientSearchExternalId: normalizePatientSearchValue(externalId) || undefined,
    patientSearchId: normalizePatientSearchValue(patient.patientId) || undefined
  });
}

function firstPatientIdentifierValue(patient = {}) {
  return normalizePatientIdentifierValues(patient)[0] || "";
}

function normalizePatientIdentifierValues(patient = {}) {
  const identifiers = Array.isArray(patient.patientIdentifiers) ? patient.patientIdentifiers : [];
  return identifiers
    .map((identifier) => identifier?.value || identifier?.patientNumber || identifier?.id || "")
    .map(normalizePatientSearchValue)
    .filter(Boolean);
}

function normalizePatientSearchValue(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .trim();
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
