import crypto from "node:crypto";
import {
  clinicalServiceContextCues,
  splitClinicalEvidenceClauses
} from "../../../packages/fee-contracts/src/index.js";

export const CARE_FEE_EVIDENCE_CONTRACT_VERSION = "care-fee-evidence-v1";
export const CARE_EMERGENCY_CSV_SCHEMA_VERSION = "care-emergency-csv-v1";
export const CARE_FEE_EVIDENCE_ADAPTER_VERSION = "fee-care-evidence-adapter-v1";

const EXACT_CARE_TERMS = /(?:緊急時治療管理|緊急時施設療養費|緊急時施設診療費)/u;
const EMERGENCY_TERMS = /(?:急変|救命救急|緊急(?:治療|対応|管理)|重篤|ショック|意識障害|呼吸不全|急性心不全|酸素化低下|SpO2.{0,12}(?:低下|不良))/iu;
const TREATMENT_TERMS = /(?:投薬|薬剤投与|抗菌薬|注射|点滴|輸液|検査|採血|処置|酸素(?:投与|療法)|吸引|人工呼吸|カニューレ(?:交換|入れ替え)|気管切開)/u;
const SEVERE_FIELDS = Object.freeze([
  "severe_consciousness_disorder",
  "severe_respiratory_failure",
  "severe_heart_failure",
  "severe_shock",
  "severe_metabolic_disorder",
  "severe_other_poisoning"
]);
const CONFLICT_FIELDS = Object.freeze([
  "concurrent_specific_treatment",
  "concurrent_specific_disease_facility_treatment",
  "concurrent_comprehensive_medical_management"
]);
const TREATMENT_FIELDS = Object.freeze([
  ["medication_performed", "medication_detail"],
  ["test_performed", "test_detail"],
  ["injection_performed", "injection_detail"],
  ["procedure_performed", "procedure_detail"]
]);

export function detectCareFeeEvidenceSignal(session = {}, feeSettings = {}) {
  const explicit = explicitCareEmergencyContext(session);
  if (explicit) {
    return {
      detected: true,
      sourceScope: "explicit_structured_fact",
      excerpt: boundedText(explicit.sourceExcerpt ?? explicit.source_excerpt, 1200),
      explicit
    };
  }
  if (feeSettings?.careFeeIntegration?.signalPolicy === "explicit_only") {
    return { detected: false, sourceScope: "none", excerpt: "", explicit: null };
  }

  const text = String(session.clinicalText || "").trim();
  if (!text) return { detected: false, sourceScope: "none", excerpt: "", explicit: null };
  const clauses = splitClinicalEvidenceClauses(text, { lineId: "care-fee" })
    .filter((clause) => isCurrentClinicalClause(clause.text));
  const exact = clauses.find((clause) => EXACT_CARE_TERMS.test(clause.text));
  if (exact) {
    return {
      detected: true,
      sourceScope: "explicit_care_term",
      excerpt: boundedText(exact.text, 1200),
      explicit: null
    };
  }

  const emergencyClauses = clauses.filter((clause) => EMERGENCY_TERMS.test(clause.text));
  const treatmentClauses = clauses.filter((clause) => TREATMENT_TERMS.test(clause.text));
  const pair = emergencyClauses.flatMap((emergency) => treatmentClauses.map((treatment) => ({ emergency, treatment })))
    .find(({ emergency, treatment }) => Math.abs(emergency.sentenceIndex - treatment.sentenceIndex) <= 1);
  if (!pair) return { detected: false, sourceScope: "none", excerpt: "", explicit: null };
  return {
    detected: true,
    sourceScope: "conservative_clinical_signal",
    excerpt: boundedText(uniqueStrings([pair.emergency.text, pair.treatment.text]).join(" "), 1200),
    explicit: null
  };
}

export function buildCareFeeEvidenceOutboxEvent(input = {}) {
  const orgId = requiredText(input.orgId, "orgId");
  const session = input.session || {};
  const feeSettings = input.feeSettings || {};
  const integration = feeSettings.careFeeIntegration || {};
  if (integration.enabled !== true) return null;
  const facilityId = requiredText(session.facilityId, "session.facilityId");
  const facilityCode = requiredText(integration.facilityCode, "careFeeIntegration.facilityCode");
  const careServiceType = requiredText(integration.careServiceType, "careFeeIntegration.careServiceType");
  const patientKey = requiredText(session.canonicalPatientId || session.patientId, "session.patientId");
  const treatmentDate = isoDate(valueFrom(explicitCareEmergencyContext(session), "treatment_date"))
    || isoDate(session.serviceDate);
  if (!treatmentDate) throw new TypeError("session.serviceDate must be YYYY-MM-DD");

  const signal = detectCareFeeEvidenceSignal(session, feeSettings);
  if (!signal.detected) return null;
  const explicit = signal.explicit || {};
  const sourceRecordId = requiredText(session.sourceRecordId || session.feeSessionId, "session.sourceRecordId");
  const generatedAt = timestamp(input.now);
  const claimMonth = treatmentDate.slice(0, 7);
  const sourceExcerpt = signal.excerpt || boundedText(session.clinicalText, 1200);
  const row = {
    schema_version: CARE_EMERGENCY_CSV_SCHEMA_VERSION,
    batch_id: `fee-${claimMonth}`,
    facility_code: facilityCode,
    care_office_number: String(integration.careOfficeNumber || "").trim(),
    care_service_type: careServiceType,
    claim_month: claimMonth,
    patient_key: patientKey,
    patient_display_name: "",
    episode_key: stringValue(explicit, "episode_key") || `fee-${sourceRecordId}`,
    onset_at: stringValue(explicit, "onset_at"),
    treatment_date: treatmentDate,
    acute_diagnosis: stringValue(explicit, "acute_diagnosis") || diagnosisText(session.diagnoses),
    emergency_care_required: booleanValue(explicit, "emergency_care_required"),
    emergency_care_rationale: stringValue(explicit, "emergency_care_rationale"),
    facility_treatment_rationale: stringValue(explicit, "facility_treatment_rationale"),
    physician_confirmed: booleanValue(explicit, "physician_confirmed"),
    physician_confirmed_by: stringValue(explicit, "physician_confirmed_by"),
    physician_confirmed_at: stringValue(explicit, "physician_confirmed_at"),
    existing_emergency_claim_count_month: integerValue(explicit, "existing_emergency_claim_count_month"),
    existing_emergency_claim_start_date: stringValue(explicit, "existing_emergency_claim_start_date"),
    existing_claim_service_code: stringValue(explicit, "existing_claim_service_code"),
    transfer_requested: booleanValue(explicit, "transfer_requested"),
    transfer_outcome: stringValue(explicit, "transfer_outcome"),
    source_record_id: sourceRecordId,
    source_excerpt: sourceExcerpt,
    input_origin: "fee_app"
  };
  for (const field of SEVERE_FIELDS) row[field] = booleanValue(explicit, field);
  for (const field of CONFLICT_FIELDS) row[field] = booleanValue(explicit, field);
  for (const [performed, detail] of TREATMENT_FIELDS) {
    row[performed] = booleanValue(explicit, performed);
    row[detail] = stringValue(explicit, detail);
  }

  const sourceRevisionHash = sha256(stableJson({
    adapterVersion: CARE_FEE_EVIDENCE_ADAPTER_VERSION,
    orgId,
    facilityId,
    patientKey,
    sourceRecordId,
    clinicalTextHash: sha256(String(session.clinicalText || "")),
    diagnoses: normalizedDiagnoses(session.diagnoses),
    explicit,
    integration: {
      facilityCode,
      careOfficeNumber: row.care_office_number,
      careServiceType,
      signalPolicy: integration.signalPolicy || "conservative"
    },
    row
  }));
  const eventId = `fce_${sha256([orgId, sourceRecordId, sourceRevisionHash].join("|"))}`;
  const payload = {
    contractVersion: CARE_FEE_EVIDENCE_CONTRACT_VERSION,
    orgId,
    sourceProduct: "fee",
    sourceRecordId,
    sourceRevisionHash,
    organizationCode: String(input.organizationCode || "").trim(),
    facilityId,
    facilityCode,
    patientKey,
    observedAt: generatedAt,
    evidenceMetadata: {
      extractorVersion: CARE_FEE_EVIDENCE_ADAPTER_VERSION,
      confidence: confidenceValue(explicit),
      sourceScope: signal.sourceScope,
      generatedAt
    },
    rows: [row]
  };
  return {
    eventId,
    sourceProduct: "fee",
    sourceRecordId,
    sourceRevisionHash,
    facilityId,
    patientKey,
    claimMonth,
    sourceScope: signal.sourceScope,
    payload,
    purgeAt: addDays(generatedAt, positiveInteger(input.retentionDays, 30))
  };
}

export async function enqueueCareFeeEvidenceForSession(input = {}) {
  if (!input.feeStore || typeof input.feeStore.putCareFeeEvidenceOutboxEvent !== "function") {
    throw new TypeError("feeStore with outbox support is required");
  }
  const event = buildCareFeeEvidenceOutboxEvent(input);
  if (!event) return { status: "skipped", reason: "signal_not_detected", event: null };
  const stored = await input.feeStore.putCareFeeEvidenceOutboxEvent(input.orgId, event);
  return {
    status: stored.created ? "queued" : "duplicate",
    reason: null,
    event: stored.event
  };
}

export async function dispatchPendingCareFeeEvidence(input = {}) {
  const feeStore = input.feeStore;
  if (!feeStore || typeof feeStore.listPendingCareFeeEvidenceOutboxEvents !== "function") {
    throw new TypeError("feeStore with outbox support is required");
  }
  const orgId = requiredText(input.orgId, "orgId");
  const endpoint = validEndpoint(input.endpoint);
  const token = requiredText(input.token, "token");
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const now = timestamp(input.now);
  const events = await feeStore.listPendingCareFeeEvidenceOutboxEvents(orgId, {
    now,
    limit: input.limit
  });
  const results = [];
  for (const event of events) {
    if (typeof input.shouldDeliver === "function" && !await input.shouldDeliver(event)) {
      results.push({
        eventId: event.eventId,
        delivered: false,
        skipped: true,
        terminal: false,
        httpStatus: null,
        errorCode: "integration_disabled",
        receiptId: null
      });
      continue;
    }
    const result = await deliverOutboxEvent({
      event,
      endpoint,
      token,
      fetchImpl,
      timeoutMs: positiveInteger(input.timeoutMs, 10_000)
    });
    if (result.delivered) {
      await feeStore.markCareFeeEvidenceOutboxDelivered(orgId, event.eventId, {
        now,
        receiptId: result.receiptId,
        purgeAt: addDays(now, positiveInteger(input.deliveredRetentionDays, 7))
      });
    } else {
      const terminal = isTerminalDeliveryStatus(result.httpStatus);
      await feeStore.markCareFeeEvidenceOutboxFailed(orgId, event.eventId, {
        now,
        errorCode: result.errorCode,
        terminal,
        nextAttemptAt: terminal ? null : retryAt(now, Number(event.attemptCount || 0) + 1)
      });
    }
    results.push({
      eventId: event.eventId,
      delivered: result.delivered,
      terminal: !result.delivered && isTerminalDeliveryStatus(result.httpStatus),
      httpStatus: result.httpStatus,
      errorCode: result.errorCode,
      receiptId: result.receiptId
    });
  }
  return {
    orgId,
    selectedCount: results.length,
    attemptedCount: results.filter((result) => !result.skipped).length,
    skippedCount: results.filter((result) => result.skipped).length,
    deliveredCount: results.filter((result) => result.delivered).length,
    failedCount: results.filter((result) => !result.delivered && !result.terminal && !result.skipped).length,
    deadLetterCount: results.filter((result) => result.terminal).length,
    results
  };
}

async function deliverOutboxEvent({ event, endpoint, token, fetchImpl, timeoutMs }) {
  if (!event.payload) {
    return { delivered: false, httpStatus: null, errorCode: "payload_missing", receiptId: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(event.payload),
      signal: controller.signal
    });
    const body = await safeResponseJson(response);
    if (response.ok) {
      return {
        delivered: true,
        httpStatus: response.status,
        errorCode: null,
        receiptId: String(body?.receipt?.receiptId || "").trim() || null
      };
    }
    return {
      delivered: false,
      httpStatus: response.status,
      errorCode: `care_fee_http_${response.status}`,
      receiptId: null
    };
  } catch (error) {
    return {
      delivered: false,
      httpStatus: null,
      errorCode: error?.name === "AbortError" ? "care_fee_timeout" : "care_fee_network_error",
      receiptId: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function safeResponseJson(response) {
  const text = await response.text();
  if (!text || text.length > 65_536) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function explicitCareEmergencyContext(session) {
  const claimContext = plainObject(session?.claimContext) ? session.claimContext : null;
  if (!claimContext) return null;
  const value = claimContext.careEmergencyTreatment ?? claimContext.care_emergency_treatment;
  return plainObject(value) ? value : null;
}

function isCurrentClinicalClause(text) {
  const cues = clinicalServiceContextCues(text);
  return !cues.negatedService && !cues.futureOrOrderOnly && !cues.pastOrExternal;
}

function valueFrom(input, snakeName) {
  if (!plainObject(input)) return undefined;
  const camelName = snakeName.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase());
  return input[snakeName] ?? input[camelName];
}

function stringValue(input, field) {
  return String(valueFrom(input, field) ?? "").trim();
}

function booleanValue(input, field) {
  const value = valueFrom(input, field);
  return value === true || value === false ? value : "";
}

function integerValue(input, field) {
  const value = valueFrom(input, field);
  if (value === undefined || value === null || value === "") return "";
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : "";
}

function confidenceValue(input) {
  const value = Number(input?.confidence);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function diagnosisText(diagnoses) {
  return uniqueStrings(normalizedDiagnoses(diagnoses).map((item) => item.name)).slice(0, 3).join("、");
}

function normalizedDiagnoses(diagnoses) {
  return (Array.isArray(diagnoses) ? diagnoses : []).map((item) => ({
    name: String(item?.name || item?.displayName || (typeof item === "string" ? item : "")).trim(),
    icd10Code: String(item?.icd10Code || item?.icd10_code || "").trim()
  })).filter((item) => item.name || item.icd10Code);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function retryAt(now, attemptCount) {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(10, Math.max(0, attemptCount - 1))));
  return new Date(Date.parse(now) + delayMs).toISOString();
}

function addDays(value, days) {
  return new Date(Date.parse(value) + days * 86_400_000).toISOString();
}

function validEndpoint(value) {
  const text = requiredText(value, "endpoint");
  const url = new URL(text);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new TypeError("endpoint must use HTTPS");
  }
  return url.toString();
}

function isTerminalDeliveryStatus(status) {
  return Number.isInteger(status) && status >= 400 && status < 500 && ![401, 403, 408, 409, 429].includes(status);
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
}

function isoDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : "";
}

function boundedText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}
