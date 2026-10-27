import { sortByDate } from "../../../packages/eye-core/src/index.js";
import { createId } from "./ids.js";

// 患者単位のプロファイル（アレルギー・副作用歴・傷病名・既往）。
// まだ保存されていない患者は、確定済みカルテの病名から初期値を組み立てる（revision 0）。

export function deriveProfileFromHistory({ orgId, patientId, encounters = [] }) {
  const finalized = sortByDate(encounters.filter((encounter) => encounter.status === "finalized"));
  const latest = finalized.at(-1);
  const firstSeen = new Map();
  for (const encounter of finalized) {
    for (const diagnosis of encounter.content?.diagnoses || []) {
      const key = diagnosisKey(diagnosis);
      if (!firstSeen.has(key)) firstSeen.set(key, encounter.encounterDate);
    }
  }
  return {
    patientId,
    orgId,
    allergies: [],
    noKnownAllergies: false,
    diagnoses: (latest?.content?.diagnoses || []).map((diagnosis) => ({
      diagnosisId: "",
      name: diagnosis.name,
      eye: diagnosis.eye || "ou",
      status: diagnosis.status || "active",
      startDate: diagnosis.onsetDate || firstSeen.get(diagnosisKey(diagnosis)) || "",
      endDate: "",
      outcome: diagnosis.status === "resolved" ? "cured" : "",
      primary: false,
      note: ""
    })),
    medicalHistory: "",
    ophthalmicHistory: "",
    contactLensUser: false,
    revision: 0,
    derived: true,
    updatedAt: "",
    updatedBy: null
  };
}

export function applyProfileUpdate({ current, validated, orgId, patientId, actor, now }) {
  return {
    patientId,
    orgId,
    allergies: validated.allergies.map((item) => ({ ...item, allergyId: item.allergyId || createId("ealg") })),
    noKnownAllergies: validated.noKnownAllergies,
    diagnoses: validated.diagnoses.map((item) => ({ ...item, diagnosisId: item.diagnosisId || createId("edx") })),
    medicalHistory: validated.medicalHistory,
    ophthalmicHistory: validated.ophthalmicHistory,
    contactLensUser: validated.contactLensUser,
    revision: (current?.revision || 0) + 1,
    derived: false,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    updatedBy: actor,
    schemaVersion: 1
  };
}

export function diagnosesChanged(before = [], after = []) {
  const normalize = (list) => JSON.stringify(list.map((item) => [
    item.name, item.eye, item.status, item.startDate, item.endDate, item.outcome, Boolean(item.primary), item.note || ""
  ]));
  return normalize(before) !== normalize(after);
}

// 確定するカルテに写し取る病名。受診日の時点で続いているもの（終了日が受診日以降を含む）。
export function diagnosesForEncounter(profile, encounterDate) {
  return (profile?.diagnoses || [])
    .filter((item) => !item.startDate || item.startDate <= encounterDate)
    .filter((item) => item.status !== "resolved" || !item.endDate || item.endDate >= encounterDate)
    .map((item) => ({
      name: item.name,
      eye: item.eye,
      status: item.status,
      onsetDate: item.startDate || ""
    }));
}

function diagnosisKey(diagnosis) {
  return `${diagnosis.name}|${diagnosis.eye || "ou"}`;
}
