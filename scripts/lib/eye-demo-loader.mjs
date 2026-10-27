// デモデータを platform / eye のストアに投入する。API と同じ組み立て関数と版管理を使う。
// 何度実行しても重複しない（患者番号・当日の予約・薬剤名で既存を判定する）。
import {
  validateCreateAppointmentInput,
  validateDrugPresetInput,
  validateEncounterContent,
  validatePatientProfileInput
} from "../../packages/eye-contracts/src/index.js";
import { patientSnapshot } from "../../packages/platform-contracts/src/index.js";
import { buildAppointment } from "../../services/eye-api/src/appointments.js";
import { buildDraftEncounter, finalizeEncounter } from "../../services/eye-api/src/encounters.js";
import { createId } from "../../services/eye-api/src/ids.js";
import { applyProfileUpdate } from "../../services/eye-api/src/profiles.js";
import { buildEyeDemoDataset } from "./eye-demo-dataset.mjs";

const DEMO_ACTOR = Object.freeze({ memberId: "demo-seed", loginId: "demo-seed", displayName: "デモデータ" });

export async function loadEyeDemoData({ platformStore, eyeStore, orgId, today, apply = true, log = () => {} }) {
  const dataset = buildEyeDemoDataset({ today });
  const summary = { patientsCreated: 0, patientsSkipped: 0, encountersCreated: 0, appointmentsCreated: 0, drugPresetsCreated: 0 };

  const existingPresets = new Set((await eyeStore.listDrugPresets(orgId)).map((preset) => preset.name));
  for (const preset of dataset.drugPresets) {
    if (existingPresets.has(preset.name)) continue;
    log(`drug preset: ${preset.name}`);
    summary.drugPresetsCreated += 1;
    if (apply) await eyeStore.upsertDrugPreset(orgId, { ...validateDrugPresetInput(preset), presetId: createId("edp") });
  }

  const appointmentsToday = await eyeStore.listAppointmentsByDate(orgId, today);
  for (const entry of dataset.patients) {
    const number = entry.patient.primaryPatientNumber;
    const matches = (await platformStore.listPatients(orgId, { search: number, limit: 5 }))
      .filter((patient) => patient.primaryPatientNumber === number && patient.status === "active");
    let patient = matches[0] || null;
    if (patient) {
      summary.patientsSkipped += 1;
      const history = await eyeStore.listPatientEncounters(orgId, patient.patientId);
      if (history.length === 0) {
        log(`patient exists without history: ${number} ${entry.patient.displayName}（受診 ${entry.visits.length}回を補う）`);
        for (const visit of entry.visits) {
          if (apply) await createFinalizedEncounter({ eyeStore, orgId, patient, visit });
          summary.encountersCreated += 1;
        }
      } else {
        log(`patient exists: ${number} ${entry.patient.displayName}`);
      }
    } else {
      summary.patientsCreated += 1;
      log(`patient: ${number} ${entry.patient.displayName}（受診 ${entry.visits.length}回）`);
      if (apply) {
        patient = await platformStore.createPatient(orgId, { ...entry.patient, notes: "眼科デモ用の架空患者" });
        for (const visit of entry.visits) {
          await createFinalizedEncounter({ eyeStore, orgId, patient, visit });
          summary.encountersCreated += 1;
        }
      } else {
        summary.encountersCreated += entry.visits.length;
      }
    }

    if (patient && apply && !(await eyeStore.getPatientProfile(orgId, patient.patientId))) {
      log(`profile: ${number} ${entry.patient.displayName}`);
      await savePatientProfile({ eyeStore, orgId, patient, entry });
    }

    const alreadyBooked = patient && appointmentsToday.some((item) => item.patientId === patient.patientId);
    if (!alreadyBooked) {
      log(`appointment: ${today} ${entry.appointment.time} ${entry.patient.displayName}`);
      summary.appointmentsCreated += 1;
      if (apply && patient) {
        await createAppointment({ eyeStore, orgId, patient, today, spec: entry.appointment });
      }
    }
  }

  for (const spec of dataset.unregisteredAppointments) {
    if (appointmentsToday.some((item) => !item.patientId && item.patientName === spec.patientName)) continue;
    log(`appointment: ${today} ${spec.time} ${spec.patientName}（未登録）`);
    summary.appointmentsCreated += 1;
    if (apply) await createAppointment({ eyeStore, orgId, patient: null, today, spec });
  }

  return summary;
}

// 受診履歴から傷病名（初出日を開始日に）を組み立て、デモ用のアレルギー・既往と合わせて保存する。
async function savePatientProfile({ eyeStore, orgId, patient, entry }) {
  const firstSeen = new Map();
  for (const visit of entry.visits) {
    for (const diagnosis of visit.content.diagnoses || []) {
      const key = `${diagnosis.name}|${diagnosis.eye || "ou"}`;
      if (!firstSeen.has(key)) firstSeen.set(key, visit.date);
    }
  }
  const latest = entry.visits.at(-1)?.content.diagnoses || [];
  const validated = validatePatientProfileInput({
    expectedRevision: 0,
    ...entry.profile,
    diagnoses: latest.map((diagnosis, index) => ({
      name: diagnosis.name,
      eye: diagnosis.eye || "ou",
      status: diagnosis.status || "active",
      startDate: firstSeen.get(`${diagnosis.name}|${diagnosis.eye || "ou"}`) || "",
      primary: index === 0
    }))
  });
  const profile = applyProfileUpdate({ current: null, validated, orgId, patientId: patient.patientId, actor: DEMO_ACTOR, now: new Date().toISOString() });
  await eyeStore.savePatientProfile(orgId, profile, 0);
}

async function createFinalizedEncounter({ eyeStore, orgId, patient, visit }) {
  const now = `${visit.date}T01:00:00.000Z`;
  const draft = buildDraftEncounter({
    encounterId: createId("eenc"),
    orgId,
    patientSnapshot: patientSnapshot(patient, new Date(now)),
    input: { encounterDate: visit.date, visitType: visit.visitType, content: validateEncounterContent(visit.content) },
    copySource: null,
    actor: DEMO_ACTOR,
    now
  });
  await eyeStore.createEncounter(orgId, draft);
  const { encounter, version } = finalizeEncounter(draft, { actor: DEMO_ACTOR, now: `${visit.date}T02:00:00.000Z` });
  await eyeStore.replaceEncounter(orgId, encounter, draft.revision, version);
}

async function createAppointment({ eyeStore, orgId, patient, today, spec }) {
  const input = validateCreateAppointmentInput({
    date: today,
    time: spec.time,
    patientId: patient?.patientId || "",
    patientName: patient ? "" : spec.patientName,
    purpose: spec.purpose,
    note: spec.note
  });
  const now = new Date().toISOString();
  const appointment = buildAppointment({
    appointmentId: createId("eapt"),
    orgId,
    input,
    patientSnapshot: patient ? patientSnapshot(patient, new Date(now)) : null,
    actor: DEMO_ACTOR,
    now
  });
  await eyeStore.createAppointment(orgId, appointment);
}
