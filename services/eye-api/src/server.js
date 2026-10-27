import { createHash } from "node:crypto";
import http from "node:http";
import {
  forbiddenError,
  hasProductAccess,
  publicAuthErrorCode,
  requirePlatformCsrf,
  requireProductContext
} from "../../../packages/auth-client/src/index.js";
import {
  DEFAULT_ORDER_CATALOG,
  EYE_DOCUMENT_ROLES,
  EYE_FINALIZE_ROLES,
  EYE_PRODUCT_ID,
  EYE_PROFILE_ROLES,
  EYE_READ_ROLES,
  EYE_RECEPTION_ROLES,
  EYE_SETTINGS_ROLES,
  EYE_WRITE_ROLES,
  validateAmendEncounterInput,
  validateAppointmentStatusInput,
  validateCreateAppointmentInput,
  validateCreateDocumentInput,
  validateCreateFileInput,
  validateCreateEncounterInput,
  validateExamConfirmInput,
  validateDrugPresetInput,
  validateFinalizeEncounterInput,
  validateOrderSetInput,
  validatePhraseInput,
  validatePatientProfileInput,
  validateUpdateAppointmentInput,
  validateUpdateDocumentInput,
  validateUpdateFileInput,
  validateUpdateEncounterInput
} from "../../../packages/eye-contracts/src/index.js";
import {
  buildTrend,
  diffEncounterContent,
  evaluateFinalizeReadiness,
  suggestNextVisit
} from "../../../packages/eye-core/src/index.js";
import { patientSnapshot } from "../../../packages/platform-contracts/src/index.js";
import { createPlatformStoreFromEnv } from "../../platform-api/src/store/create-store.js";
import {
  amendEncounter,
  applyEncounterUpdate,
  confirmExam,
  buildDraftEncounter,
  encounterSummary,
  eyeDropBottleSuggestions,
  finalizeEncounter,
  previousFinalizedEncounter
} from "./encounters.js";
import {
  applyAppointmentStatus,
  applyAppointmentUpdate,
  buildAppointment,
  isActiveAppointment
} from "./appointments.js";
import { billingCsv, buildBillingEncounter, handoffStatus } from "./billing.js";
import {
  applyDocumentUpdate,
  buildDocumentDraft,
  documentSummary,
  duplicateDocument,
  finalizeDocument
} from "./documents.js";
import { createId } from "./ids.js";
import {
  applyProfileUpdate,
  deriveProfileFromHistory,
  diagnosesChanged,
  diagnosesForEncounter
} from "./profiles.js";
import { createBlobStoreFromEnv, MAX_FILE_BYTES, sniffContentType } from "./store/blob-store.js";
import { createEyeStoreFromEnv } from "./store/create-store.js";

const PATIENT_WRITE_ROLES = [...EYE_WRITE_ROLES, "medical_clerk"];
const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function createEyeApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.EYE_GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "halunasu-eye-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const platformStore = options.platformStore || createPlatformStoreFromEnv();
  const eyeStore = options.eyeStore || createEyeStoreFromEnv();
  const blobStore = options.blobStore || createBlobStoreFromEnv();

  return http.createServer(async (req, res) => {
    try {
      const rawUpload = req.method === "PUT" && /^\/v1\/eye\/files\/[^/]+\/blob(\?|$)/u.test(req.url || "");
      const rawBody = rawUpload ? await readRawBody(req, MAX_FILE_BYTES) : undefined;
      const body = rawUpload ? undefined : await readJsonBody(req, options.maxJsonBytes || DEFAULT_MAX_JSON_BYTES);
      const response = await handleEyeApiRequest({
        method: req.method,
        path: req.url,
        body,
        headers: req.headers,
        env,
        projectId,
        region,
        startedAt,
        platformStore,
        eyeStore,
        blobStore,
        rawBody,
        now: options.now,
        sessionSecret: options.sessionSecret
      });
      if (response.raw) {
        sendRaw(res, response);
        return;
      }
      sendJson(res, response.statusCode, response.body, response.headers);
    } catch (error) {
      const response = errorResponse(error);
      sendJson(res, response.statusCode, response.body, response.headers);
    }
  });
}

export async function handleEyeApiRequest(input = {}) {
  try {
    return withCors(input, await routeEyeApiRequest(input));
  } catch (error) {
    return withCors(input, errorResponse(error));
  }
}

async function routeEyeApiRequest(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const platformStore = input.platformStore || createPlatformStoreFromEnv();
  const eyeStore = input.eyeStore || createEyeStoreFromEnv();
  const blobStore = input.blobStore || createBlobStoreFromEnv();

  if (method === "GET" && url.pathname === "/healthz") {
    return ok({ status: "ok", service: "eye-api" });
  }
  if (method === "GET" && url.pathname === "/readyz") {
    // deep=1 のときだけ、患者データを使わずに署名付き URL の発行を試す（本番の権限設定の確認用）。
    let fileSigning;
    if (url.searchParams.get("deep") === "1" && blobStore.configured) {
      try {
        await blobStore.createUploadUrl({ storagePath: "healthcheck/readyz", contentType: "application/pdf", fileId: "healthcheck" });
        fileSigning = "ok";
      } catch (error) {
        fileSigning = `error: ${error.name}`;
      }
    }
    return ok({
      fileSigning,
      status: "ok",
      service: "eye-api",
      env: input.env || "local",
      projectId: input.projectId || "halunasu-eye-stg",
      region: input.region || "asia-northeast1",
      fileStorage: blobStore.configured ? "configured" : "not_configured",
      startedAt: input.startedAt instanceof Date ? input.startedAt.toISOString() : new Date().toISOString()
    });
  }
  if (method === "OPTIONS" && url.pathname.startsWith("/v1/eye/")) return noContent();
  if (!url.pathname.startsWith("/v1/eye/")) return notFound("Route not found");

  const context = await requireEyeContext(input, platformStore);
  const orgId = context.session.orgId;
  const actor = actorOf(context);
  const now = timestamp(input);
  const audit = (entry) => eyeStore.recordAudit(orgId, {
    actorMemberId: context.session.memberId,
    actorLoginId: context.session.loginId,
    ...entry
  });

  if (method === "GET" && matches(parts, ["v1", "eye", "context"])) {
    return ok({ context: contextView(context) });
  }

  if (method === "GET" && matches(parts, ["v1", "eye", "bootstrap"])) {
    const [facilities, drugPresets, orderSets, phrases] = await Promise.all([
      platformStore.listFacilities(orgId),
      eyeStore.listDrugPresets(orgId),
      eyeStore.listOrderSets(orgId),
      eyeStore.listPhrases(orgId)
    ]);
    return ok({ context: contextView(context), facilities, drugPresets, orderSets, phrases, orderCatalog: DEFAULT_ORDER_CATALOG });
  }

  if (method === "GET" && matches(parts, ["v1", "eye", "patients"])) {
    const search = String(url.searchParams.get("q") || "").trim();
    const patients = await platformStore.listPatients(orgId, { search, limit: 50 });
    return ok({ patients: patients.filter((patient) => patient.status !== "merged") });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "patients"])) {
    requireAccess(context, PATIENT_WRITE_ROLES, "Patient registration access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const patient = await platformStore.createPatient(orgId, patientInput(input.body));
    await platformStore.createAuditEvent(orgId, {
      eventType: "eye.patient_created",
      actorMemberId: context.session.memberId,
      actorLoginId: context.session.loginId,
      targetType: "patient",
      targetId: patient.patientId,
      productId: EYE_PRODUCT_ID,
      safePayload: { patientId: patient.patientId }
    });
    return created({ patient });
  }

  if (parts.length === 4 && matches(parts.slice(0, 3), ["v1", "eye", "patients"])) {
    const patientId = parts[3];
    if (method === "GET") {
      return ok({ patient: await requirePatient(platformStore, orgId, patientId) });
    }
    if (method === "PATCH") {
      requireAccess(context, PATIENT_WRITE_ROLES, "Patient registration access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      await requirePatient(platformStore, orgId, patientId);
      const patient = await platformStore.updatePatient(orgId, patientId, patientInput(input.body));
      await platformStore.createAuditEvent(orgId, {
        eventType: "eye.patient_updated",
        actorMemberId: context.session.memberId,
        actorLoginId: context.session.loginId,
        targetType: "patient",
        targetId: patientId,
        productId: EYE_PRODUCT_ID,
        safePayload: { patientId }
      });
      return ok({ patient });
    }
  }

  if (parts.length === 5 && matches(parts.slice(0, 3), ["v1", "eye", "patients"]) && parts[4] === "profile") {
    const patient = await requirePatient(platformStore, orgId, parts[3]);
    if (method === "GET") {
      const encounters = await eyeStore.listPatientEncounters(orgId, patient.patientId);
      return ok({ profile: await loadProfile(eyeStore, orgId, patient.patientId, encounters) });
    }
    if (method === "PUT") {
      requireAccess(context, EYE_PROFILE_ROLES, "Patient profile access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const validated = validatePatientProfileInput(input.body || {});
      const encounters = await eyeStore.listPatientEncounters(orgId, patient.patientId);
      const current = await loadProfile(eyeStore, orgId, patient.patientId, encounters);
      if (diagnosesChanged(current.diagnoses, validated.diagnoses)) {
        requireAccess(context, EYE_FINALIZE_ROLES, "Only a doctor can change diagnoses");
      }
      const profile = applyProfileUpdate({ current: current.derived ? null : current, validated, orgId, patientId: patient.patientId, actor, now });
      await eyeStore.savePatientProfile(orgId, profile, validated.expectedRevision);
      await audit({
        eventType: "eye.profile_updated",
        targetType: "patient",
        targetId: patient.patientId,
        patientId: patient.patientId,
        safePayload: { revision: profile.revision, allergyCount: profile.allergies.length, diagnosisCount: profile.diagnoses.length }
      });
      return ok({ profile });
    }
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "eye", "patients"]) && parts[4] === "chart") {
    const patient = await requirePatient(platformStore, orgId, parts[3]);
    const [encounters, appointments] = await Promise.all([
      eyeStore.listPatientEncounters(orgId, patient.patientId),
      eyeStore.listPatientAppointments(orgId, patient.patientId)
    ]);
    const finalized = encounters.filter((encounter) => encounter.status === "finalized");
    const latest = finalized.at(-1) || null;
    const profile = await loadProfile(eyeStore, orgId, patient.patientId, encounters);
    await audit({ eventType: "eye.chart_viewed", targetType: "patient", targetId: patient.patientId, patientId: patient.patientId });
    return ok({
      patient,
      profile,
      encounters: encounters.map(encounterSummary).reverse(),
      latestFinalized: latest,
      trend: buildTrend(encounters),
      nextVisitSuggestion: suggestNextVisit(encounters, today(input)),
      upcomingAppointments: appointments.filter((item) => item.date >= today(input) && isActiveAppointment(item) && item.status !== "done")
    });
  }

  if (method === "GET" && matches(parts, ["v1", "eye", "encounters"])) {
    const date = String(url.searchParams.get("date") || today(input));
    if (!DATE_PATTERN.test(date)) throw badRequest("date must be YYYY-MM-DD", "date");
    const encounters = await eyeStore.listEncountersByDate(orgId, date);
    return ok({ date, encounters: encounters.map(encounterSummary) });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "encounters"])) {
    requireAccess(context, EYE_WRITE_ROLES, "Eye chart write access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const validated = validateCreateEncounterInput(input.body || {});
    const patient = await requirePatient(platformStore, orgId, validated.patientId);
    const copySource = await resolveCopySource(eyeStore, orgId, patient.patientId, validated);
    const encounter = buildDraftEncounter({
      encounterId: createId("eenc"),
      orgId,
      patientSnapshot: patientSnapshot(patient, new Date(now)),
      input: validated,
      copySource,
      actor,
      now
    });
    await eyeStore.createEncounter(orgId, encounter);
    await audit({
      eventType: "eye.encounter_created",
      targetType: "encounter",
      targetId: encounter.encounterId,
      patientId: encounter.patientId,
      safePayload: { copiedFromEncounterId: encounter.copiedFromEncounterId }
    });
    return created({ encounter });
  }

  if (parts.length >= 4 && matches(parts.slice(0, 3), ["v1", "eye", "encounters"])) {
    const encounterId = parts[3];
    const action = parts[4] || "";

    if (method === "GET" && parts.length === 4) {
      const encounter = await requireEncounter(eyeStore, orgId, encounterId);
      const [history, versions, drugPresets] = await Promise.all([
        eyeStore.listPatientEncounters(orgId, encounter.patientId),
        eyeStore.listVersions(orgId, encounterId),
        eyeStore.listDrugPresets(orgId)
      ]);
      const previous = previousFinalizedEncounter(history, encounter);
      const profile = await loadProfile(eyeStore, orgId, encounter.patientId, history);
      await audit({ eventType: "eye.encounter_viewed", targetType: "encounter", targetId: encounterId, patientId: encounter.patientId });
      return ok({
        encounter,
        profile,
        history: history
          .filter((item) => item.status === "finalized" && item.encounterId !== encounter.encounterId && item.encounterDate <= encounter.encounterDate)
          .reverse()
          .slice(0, 20),
        readiness: evaluateFinalizeReadiness(encounter.content, { examConfirmations: encounter.examConfirmations }),
        previous,
        changes: previous ? diffEncounterContent(previous.content, encounter.content) : [],
        bottleSuggestions: eyeDropBottleSuggestions(encounter, drugPresets),
        nextVisitSuggestion: suggestNextVisit(history, encounter.encounterDate),
        versions: versions.map(versionSummary)
      });
    }

    if (method === "PATCH" && parts.length === 4) {
      requireAccess(context, EYE_WRITE_ROLES, "Eye chart write access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const validated = validateUpdateEncounterInput(input.body || {});
      const current = await requireEncounter(eyeStore, orgId, encounterId);
      const { encounter: updated, changed } = applyEncounterUpdate(current, validated, { actor, now });
      if (!changed) return ok({ encounter: current });
      await eyeStore.replaceEncounter(orgId, updated, current.revision);
      await audit({ eventType: "eye.encounter_updated", targetType: "encounter", targetId: encounterId, patientId: updated.patientId, safePayload: { revision: updated.revision } });
      return ok({ encounter: updated });
    }

    if (method === "POST" && action === "exam-confirm" && parts.length === 5) {
      requireAccess(context, EYE_WRITE_ROLES, "Eye chart write access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const validated = validateExamConfirmInput(input.body || {});
      const current = await requireEncounter(eyeStore, orgId, encounterId);
      const encounter = confirmExam(current, { ...validated, actor, now });
      await eyeStore.replaceEncounter(orgId, encounter, current.revision);
      await audit({ eventType: validated.confirmed ? "eye.exam_confirmed" : "eye.exam_unconfirmed", targetType: "encounter", targetId: encounterId, patientId: encounter.patientId, safePayload: { eye: validated.eye } });
      return ok({ encounter });
    }

    if (method === "POST" && action === "finalize" && parts.length === 5) {
      requireAccess(context, EYE_FINALIZE_ROLES, "Only a doctor can finalize an eye chart");
      requirePlatformCsrf(input.headers || {}, context.session);
      const { expectedRevision } = validateFinalizeEncounterInput(input.body || {});
      const current = await requireEncounter(eyeStore, orgId, encounterId);
      const history = await eyeStore.listPatientEncounters(orgId, current.patientId);
      const profile = await loadProfile(eyeStore, orgId, current.patientId, history);
      const diagnoses = profile.derived && current.content.diagnoses?.length
        ? current.content.diagnoses
        : diagnosesForEncounter(profile, current.encounterDate);
      const { encounter, version } = finalizeEncounter(
        { ...current, content: { ...current.content, diagnoses } },
        { actor, now }
      );
      await eyeStore.replaceEncounter(orgId, encounter, expectedRevision, version);
      await audit({
        eventType: "eye.encounter_finalized",
        targetType: "encounter",
        targetId: encounterId,
        patientId: encounter.patientId,
        safePayload: { version: version.version, contentHash: version.contentHash }
      });
      return ok({ encounter, version: versionSummary(version) });
    }

    if (method === "POST" && action === "amend" && parts.length === 5) {
      requireAccess(context, EYE_FINALIZE_ROLES, "Only a doctor can amend an eye chart");
      requirePlatformCsrf(input.headers || {}, context.session);
      const { reason } = validateAmendEncounterInput(input.body || {});
      const expectedRevision = requiredRevision(input.body);
      const current = await requireEncounter(eyeStore, orgId, encounterId);
      const encounter = amendEncounter(current, { reason, actor, now });
      await eyeStore.replaceEncounter(orgId, encounter, expectedRevision);
      await audit({ eventType: "eye.encounter_amend_started", targetType: "encounter", targetId: encounterId, patientId: encounter.patientId, safePayload: { fromVersion: current.versionCount } });
      return ok({ encounter });
    }

    if (method === "POST" && action === "discard" && parts.length === 5) {
      requireAccess(context, EYE_WRITE_ROLES, "Eye chart write access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const expectedRevision = requiredRevision(input.body);
      const removed = await eyeStore.deleteDraftEncounter(orgId, encounterId, expectedRevision);
      await audit({ eventType: "eye.encounter_discarded", targetType: "encounter", targetId: encounterId, patientId: removed.patientId });
      return ok({ discarded: true });
    }

    if (method === "GET" && action === "versions" && parts.length === 6) {
      const encounter = await requireEncounter(eyeStore, orgId, encounterId);
      const version = await eyeStore.getVersion(orgId, `${encounterId}_v${Number(parts[5])}`);
      if (!version || version.encounterId !== encounterId) throw notFoundError("version not found");
      await audit({ eventType: "eye.version_viewed", targetType: "encounter", targetId: encounterId, patientId: encounter.patientId, safePayload: { version: version.version } });
      return ok({ version });
    }
  }

  if (method === "GET" && matches(parts, ["v1", "eye", "appointments"])) {
    const date = String(url.searchParams.get("date") || today(input));
    if (!DATE_PATTERN.test(date)) throw badRequest("date must be YYYY-MM-DD", "date");
    const [appointments, encounters] = await Promise.all([
      eyeStore.listAppointmentsByDate(orgId, date),
      eyeStore.listEncountersByDate(orgId, date)
    ]);
    const encountersByPatient = Object.fromEntries(encounters.map((encounter) => [encounter.patientId, {
      encounterId: encounter.encounterId,
      status: encounter.status,
      dilationStartedAt: encounter.content?.flags?.dilationStartedAt || "",
      plannedOrders: (encounter.content?.orders || []).filter((order) => order.status === "planned").map((order) => order.name)
    }]));
    return ok({ date, appointments, encountersByPatient });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "appointments"])) {
    requireAccess(context, EYE_RECEPTION_ROLES, "Reception access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const validated = validateCreateAppointmentInput(input.body || {});
    const patient = validated.patientId ? await requirePatient(platformStore, orgId, validated.patientId) : null;
    const appointment = buildAppointment({
      appointmentId: createId("eapt"),
      orgId,
      input: validated,
      patientSnapshot: patient ? patientSnapshot(patient, new Date(now)) : null,
      actor,
      now
    });
    const saved = await eyeStore.createAppointment(orgId, appointment, { assignQueueNumber: appointment.status === "checked_in" });
    await audit({ eventType: "eye.appointment_created", targetType: "appointment", targetId: saved.appointmentId, patientId: saved.patientId, safePayload: { status: saved.status } });
    return created({ appointment: saved });
  }

  if (parts.length >= 4 && matches(parts.slice(0, 3), ["v1", "eye", "appointments"])) {
    const appointmentId = parts[3];
    if (method === "PATCH" && parts.length === 4) {
      requireAccess(context, EYE_RECEPTION_ROLES, "Reception access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const validated = validateUpdateAppointmentInput(input.body || {});
      const current = await requireAppointment(eyeStore, orgId, appointmentId);
      const patient = validated.patientId ? await requirePatient(platformStore, orgId, validated.patientId) : null;
      const updated = applyAppointmentUpdate(current, validated, {
        patientSnapshot: patient ? patientSnapshot(patient, new Date(now)) : null,
        actor,
        now
      });
      const saved = await eyeStore.replaceAppointment(orgId, updated, validated.expectedRevision);
      await audit({ eventType: "eye.appointment_updated", targetType: "appointment", targetId: appointmentId, patientId: saved.patientId });
      return ok({ appointment: saved });
    }
    if (method === "POST" && parts.length === 5 && parts[4] === "status") {
      requireAccess(context, EYE_RECEPTION_ROLES, "Reception access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const { expectedRevision, status } = validateAppointmentStatusInput(input.body || {});
      const current = await requireAppointment(eyeStore, orgId, appointmentId);
      const { appointment, assignQueueNumber } = applyAppointmentStatus(current, status, { actor, now });
      const saved = await eyeStore.replaceAppointment(orgId, appointment, expectedRevision, { assignQueueNumber });
      await audit({ eventType: "eye.appointment_status_changed", targetType: "appointment", targetId: appointmentId, patientId: saved.patientId, safePayload: { from: current.status, to: status } });
      return ok({ appointment: saved });
    }
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "eye", "patients"]) && parts[4] === "documents") {
    const patient = await requirePatient(platformStore, orgId, parts[3]);
    return ok({ documents: (await eyeStore.listPatientDocuments(orgId, patient.patientId)).map(documentSummary) });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "documents"])) {
    requireAccess(context, EYE_DOCUMENT_ROLES, "Document access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const validated = validateCreateDocumentInput(input.body || {});
    const patient = await requirePatient(platformStore, orgId, validated.patientId);
    const history = await eyeStore.listPatientEncounters(orgId, patient.patientId);
    const encounter = validated.encounterId
      ? history.find((item) => item.encounterId === validated.encounterId)
      : history.filter((item) => item.status === "finalized").at(-1) || null;
    if (validated.encounterId && !encounter) throw notFoundError("encounter not found");
    const [profile, facilities] = await Promise.all([
      loadProfile(eyeStore, orgId, patient.patientId, history),
      platformStore.listFacilities(orgId)
    ]);
    const document = buildDocumentDraft({
      documentId: createId("edoc"),
      orgId,
      patientSnapshot: patientSnapshot(patient, new Date(now)),
      encounter,
      profile,
      facility: facilities.find((item) => item.status === "active") || facilities[0] || null,
      type: validated.type,
      actor,
      now
    });
    await eyeStore.createDocument(orgId, document);
    await audit({ eventType: "eye.document_created", targetType: "document", targetId: document.documentId, patientId: document.patientId, safePayload: { type: document.type } });
    return created({ document });
  }

  if (parts.length >= 4 && matches(parts.slice(0, 3), ["v1", "eye", "documents"])) {
    const documentId = parts[3];
    const action = parts[4] || "";
    const current = await eyeStore.getDocument(orgId, documentId);
    if (!current) throw notFoundError("document not found");
    if (method === "GET" && parts.length === 4) {
      await audit({ eventType: "eye.document_viewed", targetType: "document", targetId: documentId, patientId: current.patientId });
      return ok({ document: current });
    }
    if (method === "PATCH" && parts.length === 4) {
      requireAccess(context, EYE_DOCUMENT_ROLES, "Document access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const validated = validateUpdateDocumentInput(input.body || {});
      const document = applyDocumentUpdate(current, validated, { actor, now });
      await eyeStore.replaceDocument(orgId, document, validated.expectedRevision);
      await audit({ eventType: "eye.document_updated", targetType: "document", targetId: documentId, patientId: document.patientId });
      return ok({ document });
    }
    if (method === "POST" && action === "finalize" && parts.length === 5) {
      requireAccess(context, EYE_FINALIZE_ROLES, "Only a doctor can finalize a document");
      requirePlatformCsrf(input.headers || {}, context.session);
      const expectedRevision = requiredRevision(input.body);
      const document = finalizeDocument(current, { actor, now });
      await eyeStore.replaceDocument(orgId, document, expectedRevision);
      await audit({ eventType: "eye.document_finalized", targetType: "document", targetId: documentId, patientId: document.patientId, safePayload: { contentHash: document.contentHash } });
      return ok({ document });
    }
    if (method === "POST" && action === "duplicate" && parts.length === 5) {
      requireAccess(context, EYE_DOCUMENT_ROLES, "Document access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const document = duplicateDocument(current, { documentId: createId("edoc"), actor, now });
      await eyeStore.createDocument(orgId, document);
      await audit({ eventType: "eye.document_created", targetType: "document", targetId: document.documentId, patientId: document.patientId, safePayload: { type: document.type, sourceDocumentId: documentId } });
      return created({ document });
    }
  }

  if (method === "GET" && parts.length === 5 && matches(parts.slice(0, 3), ["v1", "eye", "patients"]) && parts[4] === "files") {
    const patient = await requirePatient(platformStore, orgId, parts[3]);
    const files = (await eyeStore.listPatientFiles(orgId, patient.patientId)).filter((item) => item.status === "stored" && !item.archived);
    return ok({ files });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "files", "uploads"])) {
    requireAccess(context, EYE_DOCUMENT_ROLES, "File upload access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const validated = validateCreateFileInput(input.body || {});
    const patient = await requirePatient(platformStore, orgId, validated.patientId);
    const fileId = createId("efile");
    const file = {
      fileId,
      orgId,
      patientId: patient.patientId,
      encounterId: validated.encounterId,
      kind: validated.kind,
      eye: validated.eye,
      takenOn: validated.takenOn,
      title: validated.title || validated.fileName,
      fileName: validated.fileName,
      contentType: validated.contentType,
      declaredSize: validated.size,
      size: 0,
      md5Hash: "",
      storagePath: `orgs/${orgId}/patients/${patient.patientId}/${fileId}`,
      status: "pending",
      archived: false,
      paper: validated.kind === "paper_chart" ? { summary: "", reviewedBy: null, reviewedAt: "" } : null,
      revision: 1,
      uploadedBy: actor,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    };
    const upload = await blobStore.createUploadUrl({ storagePath: file.storagePath, contentType: file.contentType, fileId });
    await eyeStore.createFile(orgId, file);
    return created({ file, upload });
  }

  if (parts.length >= 4 && matches(parts.slice(0, 3), ["v1", "eye", "files"]) && parts[3] !== "uploads") {
    const fileId = parts[3];
    const action = parts[4] || "";
    const current = await eyeStore.getFile(orgId, fileId);
    if (!current) throw notFoundError("file not found");

    if (action === "blob" && parts.length === 5 && typeof blobStore.acceptUpload === "function") {
      const token = String(url.searchParams.get("token") || "");
      if (method === "PUT") {
        await blobStore.acceptUpload({ fileId, token, contentType: headerValue(input.headers || {}, "content-type") || "", body: input.rawBody || Buffer.alloc(0) });
        return ok({ uploaded: true });
      }
      if (method === "GET") {
        const object = await blobStore.readForDownload({ fileId, token });
        return { statusCode: 200, raw: object.body, headers: { "content-type": object.contentType } };
      }
    }

    if (method === "POST" && action === "complete" && parts.length === 5) {
      requireAccess(context, EYE_DOCUMENT_ROLES, "File upload access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      if (current.status !== "pending") return ok({ file: current });
      const stored = await blobStore.describe(current.storagePath);
      if (!stored) throw badRequest("アップロードが完了していません。", "file");
      const detected = sniffContentType(stored.head);
      if (!detected || detected !== current.contentType) throw badRequest("ファイルの形式が申告と一致しません（PDF・JPEG・PNG・WebP のみ）。", "contentType");
      if (stored.size <= 0 || stored.size > MAX_FILE_BYTES) throw badRequest("ファイルのサイズが不正です。", "size");
      const file = { ...current, status: "stored", size: stored.size, md5Hash: stored.md5Hash || "", revision: current.revision + 1, updatedAt: now };
      await eyeStore.replaceFile(orgId, file, current.revision);
      await audit({ eventType: "eye.file_uploaded", targetType: "file", targetId: fileId, patientId: file.patientId, safePayload: { kind: file.kind, size: file.size } });
      return ok({ file });
    }

    if (current.status !== "stored") throw notFoundError("file not found");

    if (method === "GET" && action === "url" && parts.length === 5) {
      const download = await blobStore.createDownloadUrl({ storagePath: current.storagePath, fileId });
      await audit({ eventType: "eye.file_viewed", targetType: "file", targetId: fileId, patientId: current.patientId });
      return ok({ file: current, download });
    }

    if (method === "PATCH" && parts.length === 4) {
      requireAccess(context, EYE_DOCUMENT_ROLES, "File access is required");
      requirePlatformCsrf(input.headers || {}, context.session);
      const validated = validateUpdateFileInput(input.body || {});
      if (current.archived) throw badRequest("削除済みのファイルは変更できません。", "file");
      const paper = current.paper && validated.summary !== undefined
        ? { ...current.paper, summary: validated.summary, reviewedBy: validated.summary === current.paper.summary ? current.paper.reviewedBy : null, reviewedAt: validated.summary === current.paper.summary ? current.paper.reviewedAt : "" }
        : current.paper;
      const file = {
        ...current,
        kind: validated.kind ?? current.kind,
        eye: validated.eye ?? current.eye,
        takenOn: validated.takenOn ?? current.takenOn,
        title: validated.title ?? current.title,
        paper: (validated.kind ?? current.kind) === "paper_chart" ? (paper || { summary: "", reviewedBy: null, reviewedAt: "" }) : paper,
        revision: current.revision + 1,
        updatedAt: now
      };
      await eyeStore.replaceFile(orgId, file, validated.expectedRevision);
      await audit({ eventType: "eye.file_updated", targetType: "file", targetId: fileId, patientId: file.patientId });
      return ok({ file });
    }

    if (method === "POST" && action === "review" && parts.length === 5) {
      requireAccess(context, EYE_FINALIZE_ROLES, "Only a doctor can review a paper chart summary");
      requirePlatformCsrf(input.headers || {}, context.session);
      const expectedRevision = requiredRevision(input.body);
      if (!current.paper?.summary?.trim()) throw badRequest("要約が空のため確認できません。", "summary");
      const file = { ...current, paper: { ...current.paper, reviewedBy: actor, reviewedAt: now }, revision: current.revision + 1, updatedAt: now };
      await eyeStore.replaceFile(orgId, file, expectedRevision);
      await audit({ eventType: "eye.paper_reviewed", targetType: "file", targetId: fileId, patientId: file.patientId });
      return ok({ file });
    }

    if (method === "POST" && action === "archive" && parts.length === 5) {
      requireAccess(context, EYE_FINALIZE_ROLES, "Only a doctor can remove a file");
      requirePlatformCsrf(input.headers || {}, context.session);
      const expectedRevision = requiredRevision(input.body);
      const reason = String(input.body?.reason || "").trim();
      if (!reason) throw badRequest("削除の理由を入力してください。", "reason");
      const file = { ...current, archived: true, archivedReason: reason, archivedBy: actor, archivedAt: now, revision: current.revision + 1, updatedAt: now };
      await eyeStore.replaceFile(orgId, file, expectedRevision);
      await audit({ eventType: "eye.file_archived", targetType: "file", targetId: fileId, patientId: file.patientId });
      return ok({ file });
    }
  }

  if (method === "GET" && (matches(parts, ["v1", "eye", "billing", "day"]) || matches(parts, ["v1", "eye", "billing", "day.csv"]))) {
    requireAccess(context, EYE_RECEPTION_ROLES, "Billing access is required");
    const date = String(url.searchParams.get("date") || today(input));
    if (!DATE_PATTERN.test(date)) throw badRequest("date must be YYYY-MM-DD", "date");
    const day = await billingDay(eyeStore, platformStore, orgId, date);
    if (parts[3] === "day.csv") {
      await audit({ eventType: "eye.billing_exported", targetType: "billing_day", targetId: date, safePayload: { encounterCount: day.encounters.length } });
      return { statusCode: 200, raw: Buffer.from(billingCsv(day.encounters), "utf8"), headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="eye-billing-${date}.csv"` } };
    }
    return ok(day);
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "billing", "handoffs"])) {
    requireAccess(context, EYE_RECEPTION_ROLES, "Billing access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const date = String(input.body?.date || "");
    if (!DATE_PATTERN.test(date)) throw badRequest("date must be YYYY-MM-DD", "date");
    const requested = new Set(Array.isArray(input.body?.encounterIds) ? input.body.encounterIds.map(String) : []);
    if (requested.size === 0) throw badRequest("連携するカルテを選んでください。", "encounterIds");
    const day = await billingDay(eyeStore, platformStore, orgId, date);
    const selected = day.encounters.filter((item) => requested.has(item.encounterId));
    if (selected.length !== requested.size) throw badRequest("確定済みでないカルテ、または別の日のカルテが含まれています。", "encounterIds");
    const csv = billingCsv(selected);
    const handoff = {
      handoffId: createId("ebh"),
      orgId,
      date,
      encounters: selected.map((item) => ({ encounterId: item.encounterId, version: item.version, fingerprint: item.fingerprint })),
      csvSha256: createHashHex(csv),
      createdBy: actor,
      createdAt: now
    };
    await eyeStore.createBillingHandoff(orgId, handoff);
    await audit({ eventType: "eye.billing_handed_off", targetType: "billing_handoff", targetId: handoff.handoffId, safePayload: { date, encounterCount: selected.length } });
    return created({ handoff, csv });
  }

  if (method === "GET" && matches(parts, ["v1", "eye", "drug-presets"])) {
    return ok({ drugPresets: await eyeStore.listDrugPresets(orgId) });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "drug-presets"])) {
    requireAccess(context, EYE_SETTINGS_ROLES, "Eye settings access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const validated = validateDrugPresetInput(input.body || {});
    const drugPreset = await eyeStore.upsertDrugPreset(orgId, {
      ...validated,
      presetId: validated.presetId || createId("edp")
    });
    await audit({ eventType: "eye.drug_preset_saved", targetType: "drug_preset", targetId: drugPreset.presetId });
    return ok({ drugPreset });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "order-sets"])) {
    requireAccess(context, EYE_SETTINGS_ROLES, "Eye settings access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const validated = validateOrderSetInput(input.body || {});
    const orderSet = await eyeStore.upsertOrderSet(orgId, { ...validated, setId: validated.setId || createId("eset") });
    await audit({ eventType: "eye.order_set_saved", targetType: "order_set", targetId: orderSet.setId });
    return ok({ orderSet });
  }

  if (method === "POST" && matches(parts, ["v1", "eye", "phrases"])) {
    requireAccess(context, EYE_SETTINGS_ROLES, "Eye settings access is required");
    requirePlatformCsrf(input.headers || {}, context.session);
    const validated = validatePhraseInput(input.body || {});
    const phrase = await eyeStore.upsertPhrase(orgId, { ...validated, phraseId: validated.phraseId || createId("ephr") });
    await audit({ eventType: "eye.phrase_saved", targetType: "phrase", targetId: phrase.phraseId });
    return ok({ phrase });
  }

  if (method === "GET" && matches(parts, ["v1", "eye", "audit-logs"])) {
    requireAccess(context, EYE_SETTINGS_ROLES, "Eye settings access is required");
    return ok({ auditLogs: await eyeStore.listAuditLogs(orgId, 200) });
  }

  return notFound("Route not found");
}

async function requireEyeContext(input, platformStore) {
  return requireProductContext(input, {
    platformStore,
    productId: EYE_PRODUCT_ID,
    productLabel: "Eye EMR",
    allowedProductRoles: EYE_READ_ROLES
  });
}

function requireAccess(context, roles, message) {
  if (!hasProductAccess(context.session, EYE_PRODUCT_ID, roles)) {
    throw forbiddenError(message);
  }
}

async function requirePatient(platformStore, orgId, patientId) {
  const patient = await platformStore.getPatient(orgId, patientId);
  if (!patient || patient.status !== "active") throw notFoundError("patient not found");
  return patient;
}

async function requireEncounter(eyeStore, orgId, encounterId) {
  const encounter = await eyeStore.getEncounter(orgId, encounterId);
  if (!encounter) throw notFoundError("encounter not found");
  return encounter;
}

// 日ごとの会計連携の対象。確定済みカルテと、その日に確定した文書を集める。
async function billingDay(eyeStore, platformStore, orgId, date) {
  const [encounters, handoffs] = await Promise.all([
    eyeStore.listEncountersByDate(orgId, date),
    eyeStore.listBillingHandoffsByDate(orgId, date)
  ]);
  const finalized = encounters.filter((item) => item.status === "finalized");
  const documentsByPatient = new Map();
  for (const patientId of new Set(finalized.map((item) => item.patientId))) {
    const documents = (await eyeStore.listPatientDocuments(orgId, patientId))
      .filter((item) => item.status === "finalized" && String(item.finalizedAt).slice(0, 10) <= date && item.issueDate === date);
    documentsByPatient.set(patientId, documents);
  }
  // レセコンとの突き合わせに使う患者番号は、カルテの写しではなく最新の患者情報から取る。
  const patients = new Map();
  for (const patientId of documentsByPatient.keys()) patients.set(patientId, await platformStore.getPatient(orgId, patientId));
  const usedDocuments = new Set();
  const billing = finalized.map((encounter) => {
    const documents = (documentsByPatient.get(encounter.patientId) || []).filter((item) => !usedDocuments.has(item.documentId));
    for (const document of documents) usedDocuments.add(document.documentId);
    const current = patients.get(encounter.patientId);
    const built = buildBillingEncounter({
      ...encounter,
      patientSnapshot: { ...encounter.patientSnapshot, primaryPatientNumber: current?.primaryPatientNumber || "" }
    }, documents);
    return { ...built, handoff: handoffStatus(built, handoffs) };
  });
  return {
    date,
    encounters: billing,
    drafts: encounters.filter((item) => item.status === "draft").map(encounterSummary),
    handoffs: handoffs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  };
}

function createHashHex(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function loadProfile(eyeStore, orgId, patientId, encounters) {
  return await eyeStore.getPatientProfile(orgId, patientId)
    || deriveProfileFromHistory({ orgId, patientId, encounters });
}

async function requireAppointment(eyeStore, orgId, appointmentId) {
  const appointment = await eyeStore.getAppointment(orgId, appointmentId);
  if (!appointment) throw notFoundError("appointment not found");
  return appointment;
}

async function resolveCopySource(eyeStore, orgId, patientId, validated) {
  if (validated.content || validated.visitType === "initial") return null;
  const history = await eyeStore.listPatientEncounters(orgId, patientId);
  if (validated.copyFromEncounterId) {
    const source = history.find((encounter) => encounter.encounterId === validated.copyFromEncounterId);
    if (!source || source.status !== "finalized") throw badRequest("copy source must be a finalized encounter of the same patient", "copyFromEncounterId");
    return source;
  }
  return history.filter((encounter) => encounter.status === "finalized" && encounter.encounterDate <= validated.encounterDate).at(-1) || null;
}

function patientInput(body = {}) {
  const allowed = ["displayName", "displayNameKana", "birthDate", "sex", "primaryPatientNumber", "contact", "notes"];
  return Object.fromEntries(allowed.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

function requiredRevision(body = {}) {
  const expectedRevision = Number(body?.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw badRequest("expectedRevision must be a positive integer", "expectedRevision");
  }
  return expectedRevision;
}

function actorOf(context) {
  return {
    memberId: context.session.memberId,
    loginId: context.session.loginId,
    displayName: context.member?.displayName || context.session.loginId
  };
}

function versionSummary(version) {
  return {
    versionId: version.versionId,
    version: version.version,
    contentHash: version.contentHash,
    amendmentReason: version.amendmentReason,
    finalizedBy: version.finalizedBy,
    finalizedAt: version.finalizedAt
  };
}

function contextView(context) {
  return {
    orgId: context.session.orgId,
    memberId: context.session.memberId,
    organizationCode: context.session.organizationCode,
    loginId: context.session.loginId,
    displayName: context.member?.displayName || context.session.loginId,
    globalRoles: context.session.globalRoles || [],
    productRoles: context.session.productRoles || {},
    eyeRoles: context.session.productRoles?.[EYE_PRODUCT_ID] || [],
    canWrite: hasProductAccess(context.session, EYE_PRODUCT_ID, EYE_WRITE_ROLES),
    canRegisterPatients: hasProductAccess(context.session, EYE_PRODUCT_ID, PATIENT_WRITE_ROLES),
    canFinalize: hasProductAccess(context.session, EYE_PRODUCT_ID, EYE_FINALIZE_ROLES),
    canManageSettings: hasProductAccess(context.session, EYE_PRODUCT_ID, EYE_SETTINGS_ROLES),
    canReceive: hasProductAccess(context.session, EYE_PRODUCT_ID, EYE_RECEPTION_ROLES),
    canEditProfile: hasProductAccess(context.session, EYE_PRODUCT_ID, EYE_PROFILE_ROLES),
    canEditDiagnoses: hasProductAccess(context.session, EYE_PRODUCT_ID, EYE_FINALIZE_ROLES),
    canWriteDocuments: hasProductAccess(context.session, EYE_PRODUCT_ID, EYE_DOCUMENT_ROLES)
  };
}

function timestamp(input) {
  const value = typeof input.now === "function" ? input.now() : input.now;
  return (value instanceof Date ? value : new Date()).toISOString();
}

// 診療日は日本時間で決める。
function today(input) {
  const value = typeof input.now === "function" ? input.now() : input.now;
  const date = value instanceof Date ? value : new Date();
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

async function readJsonBody(req, maxBytes) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large");
      error.name = "PayloadTooLargeError";
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("File is too large");
      error.name = "PayloadTooLargeError";
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendRaw(res, response) {
  res.writeHead(response.statusCode, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    ...response.headers
  });
  res.end(response.raw);
}

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function ok(body, headers = {}) {
  return { statusCode: 200, body, headers };
}

function created(body, headers = {}) {
  return { statusCode: 201, body, headers };
}

function noContent(headers = {}) {
  return { statusCode: 204, body: {}, headers };
}

function notFound(message) {
  return { statusCode: 404, body: { error: "not_found", message } };
}

function notFoundError(message) {
  const error = new Error(message);
  error.name = "NotFoundError";
  error.statusCode = 404;
  return error;
}

function badRequest(message, field) {
  const error = new Error(message);
  error.name = "BadRequestError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  return {
    statusCode,
    body: {
      error: statusCode === 500 ? "internal_error" : (publicAuthErrorCode(error) || toErrorCode(error.name)),
      message: statusCode === 500 ? "Internal server error" : error.message,
      field: error.field,
      details: statusCode === 500 ? undefined : error.details
    }
  };
}

function withCors(input, response) {
  return { ...response, headers: { ...corsHeaders(input), ...response.headers } };
}

function corsHeaders(input) {
  const origin = headerValue(input.headers || {}, "origin");
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-csrf-token",
    "vary": "Origin"
  };
}

function isAllowedOrigin(origin) {
  return [
    "https://eye.halunasu.com",
    "https://eye.stg.halunasu.com",
    "https://halunasu-eye-stg.netlify.app",
    "https://halunasu-eye-prod.netlify.app"
  ].includes(origin)
    || String(process.env.HALUNASU_ALLOWED_WEB_ORIGINS || "").split(",").map((value) => value.trim()).includes(origin)
    || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin);
}

function headerValue(headers, name) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value.join("; ") : value;
}

function matches(parts, expected) {
  return parts.length === expected.length && expected.every((part, index) => part === parts[index]);
}

function toErrorCode(name) {
  return String(name || "Error")
    .replace(/Error$/u, "")
    .replace(/([a-z])([A-Z])/gu, "$1_$2")
    .toLowerCase() || "error";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.EYE_API_PORT || process.env.PORT || 8087);
  createEyeApiServer().listen(port, () => {
    console.log(`eye-api listening on :${port}`);
  });
}
