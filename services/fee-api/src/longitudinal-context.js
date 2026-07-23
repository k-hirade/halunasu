import crypto from "node:crypto";

export const EXTRACTION_SNAPSHOT_SCHEMA_VERSION = 3;

const CLINICAL_LINE_ROLES = new Set([
  "performed",
  "management_continuation",
  "plan",
  "none"
]);

const VISIT_FACTS_SENSITIVE_PRESCRIPTION_PATTERN = /(?:処方箋|(?:院外|院内)(?:での?)?処方|処方(?:は|を)?(?:院外|院内)|一般名(?:処方|で処方|記載)|リフィル)/u;

export async function resolveCanonicalSidecarPatientIdentity({
  platformStore,
  orgId,
  facilityId,
  sourceSystem,
  externalPatientId,
  sidecarPatientKey
} = {}) {
  const fallbackId = requiredString(sidecarPatientKey, "sidecarPatientKey");
  const sourceIdentity = {
    sourceSystem: requiredString(sourceSystem, "sourceSystem"),
    facilityId: requiredString(facilityId, "facilityId"),
    externalPatientId: requiredString(externalPatientId, "externalPatientId")
  };
  if (!platformStore || !orgId) {
    return unresolvedCanonicalIdentity(fallbackId, sourceIdentity, "unavailable");
  }

  let patients;
  try {
    patients = typeof platformStore.findPatientsByIdentifier === "function"
      ? await platformStore.findPatientsByIdentifier(orgId, {
        sourceSystem: sourceIdentity.sourceSystem,
        facilityId: sourceIdentity.facilityId,
        patientNumber: sourceIdentity.externalPatientId
      })
      : typeof platformStore.listPatients === "function"
        ? await platformStore.listPatients(orgId, {
          search: sourceIdentity.externalPatientId,
          limit: 100
        })
        : null;
  } catch {
    return unresolvedCanonicalIdentity(fallbackId, sourceIdentity, "unavailable");
  }

  if (!Array.isArray(patients)) {
    return unresolvedCanonicalIdentity(fallbackId, sourceIdentity, "unavailable");
  }

  const exactMatches = patients
    .filter((patient) => patientMatchesSourceIdentity(patient, sourceIdentity));
  if (exactMatches.length !== 1) {
    return unresolvedCanonicalIdentity(
      fallbackId,
      sourceIdentity,
      exactMatches.length > 1 ? "ambiguous" : "not_linked"
    );
  }

  const canonicalPatientId = requiredString(exactMatches[0].patientId, "patientId");
  return {
    canonicalPatientId,
    canonicalPatientIdSource: "patient_identifier",
    patientIdentityAliases: uniqueStrings([canonicalPatientId, fallbackId]),
    matchedPatient: exactMatches[0],
    resolutionStatus: "resolved",
    lookupCompleteness: "complete",
    sourceIdentity
  };
}

export function patientMatchesSourceIdentity(patient = {}, sourceIdentity = {}) {
  return (Array.isArray(patient.patientIdentifiers) ? patient.patientIdentifiers : []).some((identifier) => (
    normalizedIdentityPart(identifier?.sourceSystem) === normalizedIdentityPart(sourceIdentity.sourceSystem)
    && normalizedIdentityPart(identifier?.facilityId) === normalizedIdentityPart(sourceIdentity.facilityId)
    && normalizedIdentityPart(identifier?.patientNumber || identifier?.value)
      === normalizedIdentityPart(sourceIdentity.externalPatientId)
    && String(identifier?.status || "active").trim() === "active"
  ));
}

export function canonicalPatientIds(session = {}) {
  return uniqueStrings([
    session.canonicalPatientId,
    session.patientId,
    ...(Array.isArray(session.patientIdentityAliases) ? session.patientIdentityAliases : [])
  ]);
}

export function extractionSnapshotId(sourceType, sourceSessionId) {
  const digest = crypto.createHash("sha256")
    .update(`${String(sourceType || "fee_session")}\u001f${requiredString(sourceSessionId, "sourceSessionId")}`)
    .digest("hex");
  return `extract_${digest.slice(0, 32)}`;
}

export function buildExtractionSnapshotCore({
  promptVersion,
  preprocessing,
  facts,
  extractedAt
} = {}) {
  const currentLines = clinicalLineKeyEntries(preprocessing?.lines || []);
  const lineById = new Map(currentLines.map((line) => [line.lineId, line]));
  const lineReview = new Map((Array.isArray(facts?.line_review) ? facts.line_review : [])
    .map((entry) => [String(entry?.line_id || entry?.lineId || "").trim(), clinicalLineRole(entry)])
    .filter(([lineId]) => lineId));
  const standingMentionsByLineId = new Map();
  for (const mention of Array.isArray(facts?.standing_mentions) ? facts.standing_mentions : []) {
    const lineId = String(mention?.line_id || mention?.lineId || "").trim();
    const normalized = sanitizeStandingMention(mention);
    if (!lineId || !normalized || !lineById.has(lineId)) {
      continue;
    }
    const current = standingMentionsByLineId.get(lineId) || [];
    current.push(normalized);
    standingMentionsByLineId.set(lineId, dedupeStandingMentions(current));
  }
  const eventsByLineId = new Map();
  const requiresReextractLineIds = new Set();

  for (const event of Array.isArray(facts?.clinical_events) ? facts.clinical_events : []) {
    const evidenceLineIds = uniqueStrings(event?.evidence_line_ids || []).filter((lineId) => lineById.has(lineId));
    if (evidenceLineIds.length !== 1) {
      for (const lineId of evidenceLineIds) {
        requiresReextractLineIds.add(lineId);
      }
      continue;
    }
    const lineId = evidenceLineIds[0];
    const current = eventsByLineId.get(lineId) || [];
    current.push(sanitizeMemoEvent(event));
    eventsByLineId.set(lineId, current);
  }

  return {
    schemaVersion: EXTRACTION_SNAPSHOT_SCHEMA_VERSION,
    promptVersion: requiredString(promptVersion, "promptVersion"),
    extractedAt: timestamp(extractedAt),
    visitType: sanitizeVisitType(facts?.visit_type),
    visitFacts: sanitizeVisitFacts(facts?.visit_facts),
    diagnoses: sanitizeDiagnoses(facts?.diagnoses),
    lines: currentLines.map((line) => {
      const events = eventsByLineId.get(line.lineId) || [];
      const lineRole = lineReview.get(line.lineId) || "none";
      return {
        lineKey: line.lineKey,
        lineRole,
        events,
        standingMentions: standingMentionsByLineId.get(line.lineId) || [],
        visitFactsSensitive: visitFactsSensitivePrescriptionLine(line.normalizedText),
        requiresReextract: requiresReextractLineIds.has(line.lineId)
          || (lineRole === "performed" && !events.length)
      };
    })
  };
}

export function planExtractionMemo({
  preprocessing,
  snapshot,
  promptVersion,
  historyCompleteness = "complete"
} = {}) {
  const currentLines = clinicalLineKeyEntries(preprocessing?.lines || []);
  const unavailable = historyCompleteness === "unavailable";
  const compatible = !unavailable
    && snapshot?.schemaVersion === EXTRACTION_SNAPSHOT_SCHEMA_VERSION
    && String(snapshot?.promptVersion || "") === String(promptVersion || "")
    && Array.isArray(snapshot?.lines);
  if (!compatible) {
    return {
      compatible: false,
      reason: unavailable
        ? "history_unavailable"
        : snapshot
          ? "snapshot_version_mismatch"
          : "snapshot_missing",
      continued: [],
      newLines: currentLines,
      removed: [],
      memoHitLineRatio: 0
    };
  }

  const previousByKey = new Map(snapshot.lines
    .filter((line) => String(line?.lineKey || "").trim())
    .map((line) => [String(line.lineKey), line]));
  const currentKeys = new Set(currentLines.map((line) => line.lineKey));
  const continued = [];
  const newLines = [];
  for (const line of currentLines) {
    const previous = previousByKey.get(line.lineKey);
    if (!previous || previous.requiresReextract === true) {
      newLines.push(line);
    } else {
      continued.push({ current: line, previous });
    }
  }
  const removed = snapshot.lines.filter((line) => !currentKeys.has(String(line?.lineKey || "")));
  const visitFactsSensitiveChange = newLines.some((line) => (
    visitFactsSensitivePrescriptionLine(line?.normalizedText)
  )) || removed.some((line) => line?.visitFactsSensitive === true);
  if (visitFactsSensitiveChange) {
    return {
      compatible: false,
      reason: "visit_facts_sensitive_change",
      continued: [],
      newLines: currentLines,
      removed,
      memoHitLineRatio: 0
    };
  }
  const denominator = continued.length + newLines.length;
  return {
    compatible: true,
    reason: "compatible",
    continued,
    newLines,
    removed,
    memoHitLineRatio: denominator ? continued.length / denominator : 0
  };
}

export function clinicalFactsFromMemo(snapshot = {}, memoPlan = {}, options = {}) {
  const lineReview = [];
  const clinicalEvents = [];
  const standingMentions = [];
  for (const match of Array.isArray(memoPlan.continued) ? memoPlan.continued : []) {
    const lineId = String(match?.current?.lineId || "").trim();
    if (!lineId) {
      continue;
    }
    lineReview.push({
      line_id: lineId,
      line_role: clinicalLineRole(match?.previous)
    });
    for (const mention of Array.isArray(match?.previous?.standingMentions)
      ? match.previous.standingMentions
      : []) {
      const normalized = sanitizeStandingMention(mention);
      if (normalized) {
        standingMentions.push({
          line_id: lineId,
          ...normalized
        });
      }
    }
    for (const event of Array.isArray(match?.previous?.events) ? match.previous.events : []) {
      clinicalEvents.push({
        ...event,
        evidence_line_ids: [lineId]
      });
    }
  }
  const reuseSourceScopedFacts = options.reuseSourceScopedFacts === true
    && memoPlan.newLines?.length === 0
    && memoPlan.removed?.length === 0;
  return {
    ...(reuseSourceScopedFacts && snapshot.visitType
      ? { visit_type: sanitizeVisitType(snapshot.visitType) }
      : {}),
    visit_facts: sanitizeVisitFacts(snapshot.visitFacts),
    diagnoses: sanitizeDiagnoses(snapshot.diagnoses),
    line_review: lineReview,
    standing_mentions: dedupeStandingMentions(standingMentions, { includeLineId: true }),
    clinical_events: clinicalEvents,
    checklist_findings: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  };
}

function clinicalLineRole(entry = {}) {
  const role = String(entry?.line_role || entry?.lineRole || "").trim();
  if (CLINICAL_LINE_ROLES.has(role)) {
    return role;
  }
  return "none";
}

function sanitizeStandingMention(value = {}) {
  const target = String(value?.target || "").trim().slice(0, 70);
  const status = enumValue(value?.status, ["continued", "changed", "stopped"], "");
  if (!target || !status) {
    return null;
  }
  return { target, status };
}

function dedupeStandingMentions(values = [], { includeLineId = false } = {}) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = sanitizeStandingMention(value);
    const lineId = includeLineId ? String(value?.line_id || value?.lineId || "").trim() : "";
    if (!normalized || (includeLineId && !lineId)) {
      continue;
    }
    const key = `${lineId}\u001f${normalized.target}\u001f${normalized.status}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(includeLineId ? { line_id: lineId, ...normalized } : normalized);
  }
  return result;
}

function sanitizeVisitType(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    kind: enumValue(value.kind, ["initial", "revisit", "unknown"], "unknown"),
    evidence: String(value.evidence || "").slice(0, 90),
    confidence: enumValue(value.confidence, ["high", "medium", "low"], "low")
  };
}

export function clinicalLineKeyEntries(lines = []) {
  const occurrences = new Map();
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => String(line?.text || "").trim())
    .slice(0, 80)
    .map((line) => {
      const section = String(line?.section || "unknown").trim().toLowerCase() || "unknown";
      const normalizedText = normalizeLineText(line?.normalizedText || line?.text || "");
      const occurrenceKey = `${section}\u001f${normalizedText}`;
      const occurrence = Number(occurrences.get(occurrenceKey) || 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const lineKey = crypto.createHash("sha256")
        .update(`${section}\u001f${normalizedText}\u001f${occurrence}`)
        .digest("hex");
      return {
        ...line,
        lineId: String(line?.lineId || line?.line_id || "").trim(),
        lineKey,
        section,
        normalizedText,
        occurrence
      };
    })
    .filter((line) => line.lineId && line.normalizedText);
}

function unresolvedCanonicalIdentity(fallbackId, sourceIdentity, resolutionStatus) {
  return {
    canonicalPatientId: fallbackId,
    canonicalPatientIdSource: "sidecar_patient_key",
    patientIdentityAliases: [fallbackId],
    matchedPatient: null,
    resolutionStatus,
    lookupCompleteness: ["unavailable", "ambiguous"].includes(resolutionStatus)
      ? "unavailable"
      : "complete",
    sourceIdentity
  };
}

function sanitizeMemoEvent(event = {}) {
  const {
    evidence,
    evidence_line_ids: evidenceLineIds,
    evidenceLineIds: camelEvidenceLineIds,
    char_start: charStart,
    char_end: charEnd,
    charStart: camelCharStart,
    charEnd: camelCharEnd,
    ...safe
  } = event || {};
  void evidence;
  void evidenceLineIds;
  void camelEvidenceLineIds;
  void charStart;
  void charEnd;
  void camelCharStart;
  void camelCharEnd;
  return structuredClone(safe);
}

function sanitizeVisitFacts(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    outside_prescription_issued: enumValue(value.outside_prescription_issued, ["yes", "no", "unknown"], "unknown"),
    generic_name_prescription: enumValue(value.generic_name_prescription, ["yes", "no", "unknown"], "unknown"),
    prescription_evidence: String(value.prescription_evidence || "").slice(0, 90)
  };
}

function visitFactsSensitivePrescriptionLine(value = "") {
  return VISIT_FACTS_SENSITIVE_PRESCRIPTION_PATTERN.test(normalizeLineText(value));
}

function sanitizeDiagnoses(values = []) {
  return (Array.isArray(values) ? values : []).map((diagnosis) => ({
    name: String(diagnosis?.name || diagnosis?.displayName || diagnosis || "").trim().slice(0, 80),
    status: String(diagnosis?.status || "").trim().slice(0, 24)
  })).filter((diagnosis) => diagnosis.name).slice(0, 20);
}

function normalizeLineText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedIdentityPart(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .trim();
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || "").trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new TypeError(`${field} is required`);
  }
  return normalized;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("extractedAt must be a valid timestamp");
  }
  return date.toISOString();
}
