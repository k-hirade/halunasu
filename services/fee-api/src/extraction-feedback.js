import crypto from "node:crypto";

export const EXTRACTION_FEEDBACK_MODES = Object.freeze(["off", "collect"]);
export const EXTRACTION_REJECT_REASONS = Object.freeze([
  "extraction_wrong",
  "duplicate",
  "facility_standard_missing",
  "frequency_limit",
  "clinical_judgment",
  "other"
]);
export const EXTRACTION_FEEDBACK_EVENT_TYPES = Object.freeze([
  "review_decision",
  "shadow_disagreement",
  "context_disagreement",
  "empty_extraction_guard",
  "line_review_retry"
]);
export const EXTRACTION_FEEDBACK_FEATURE_TAGS = Object.freeze([
  "span_miss",
  "wrong_code",
  "linker_low_margin",
  "category_mismatch",
  "body_site_expression",
  "quantity_area_expression",
  "empty_extraction",
  "line_review_retry",
  "encoder_only",
  "llm_only",
  "wrong_context_axis:action_status",
  "wrong_context_axis:temporal_relation",
  "wrong_context_axis:source_origin",
  "wrong_context_axis:provider_ownership",
  "wrong_context_axis:standing_status"
]);

const FEATURE_TAG_SET = new Set(EXTRACTION_FEEDBACK_FEATURE_TAGS);
const REJECT_REASON_SET = new Set(EXTRACTION_REJECT_REASONS);
const EVENT_TYPE_SET = new Set(EXTRACTION_FEEDBACK_EVENT_TYPES);
const FEEDBACK_ROUTES = new Set(["encoder", "llm"]);
const FEEDBACK_OUTCOMES = new Set(["approved", "rejected", "corrected", "observed"]);
const FORBIDDEN_FIELD_NAMES = new Set([
  "patientid",
  "canonicalpatientid",
  "feesessionid",
  "sourcerecordid",
  "sourcepatientid",
  "reviewitemid",
  "clinicaltext",
  "text",
  "span",
  "spantext",
  "evidence",
  "note",
  "replacementtext"
]);
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export function extractionFeedbackMode(env = process.env) {
  const normalized = String(env.FEE_EXTRACTION_FEEDBACK_MODE || "off").trim().toLowerCase();
  return EXTRACTION_FEEDBACK_MODES.includes(normalized) ? normalized : "off";
}

export function extractionFeedbackReadiness(env = process.env) {
  const mode = extractionFeedbackMode(env);
  const secretConfigured = Boolean(String(env.FEE_EXTRACTION_FEEDBACK_HMAC_SECRET || "").trim());
  return {
    mode,
    ready: mode === "off" || secretConfigured,
    secretConfigured,
    hmacKeyVersion: String(env.FEE_EXTRACTION_FEEDBACK_HMAC_KEY_VERSION || "v1").trim() || "v1",
    reason: mode === "collect" && !secretConfigured
      ? "FEE_EXTRACTION_FEEDBACK_HMAC_SECRET is not configured"
      : null
  };
}

export function normalizeExtractionRejectReason(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }
  if (!REJECT_REASON_SET.has(normalized)) {
    const error = new Error(`rejectReason must be one of: ${EXTRACTION_REJECT_REASONS.join(", ")}`);
    error.name = "ValidationError";
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export function buildReviewDecisionFeedbackEvents({
  orgId,
  feeSessionId,
  feeSession = {},
  reviewItems = [],
  decisions = [],
  env = process.env,
  now = new Date()
} = {}) {
  const context = feedbackContext({ orgId, feeSessionId, feeSession, env, now });
  const reviewItemById = new Map((Array.isArray(reviewItems) ? reviewItems : [])
    .map((item) => [String(item?.reviewItemId || ""), item]));
  const events = [];
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const reviewItemId = String(decision?.reviewItemId || "").trim();
    const item = reviewItemById.get(reviewItemId);
    const descriptor = reviewItemDescriptor(item);
    if (!reviewItemId || !descriptor) {
      continue;
    }
    const status = String(decision?.status || "approved").trim();
    const outcome = status === "approved"
      ? "approved"
      : status === "rejected"
        ? "rejected"
        : "corrected";
    const rejectReason = outcome === "rejected"
      ? normalizeExtractionRejectReason(decision?.rejectReason)
      : null;
    events.push(buildFeedbackEvent({
      ...context,
      eventType: "review_decision",
      code: descriptor.code,
      kind: descriptor.kind,
      category: descriptor.category,
      confidence: descriptor.confidence,
      route: descriptor.route,
      outcome,
      rejectReason,
      failureFeatureTags: descriptor.failureFeatureTags,
      eventIdentity: `review:${reviewItemId}:${outcome}:${rejectReason || "none"}`
    }));
  }
  return events;
}

export function buildCalculationFeedbackEvents({
  orgId,
  feeSessionId,
  feeSession = {},
  clinicalMetrics = {},
  calculationKey = "",
  env = process.env,
  now = new Date()
} = {}) {
  const context = feedbackContext({ orgId, feeSessionId, feeSession, env, now });
  const runIdentity = crypto.createHmac("sha256", context.orgKey)
    .update(`calculation:${String(calculationKey || context.occurredAt)}`)
    .digest("hex")
    .slice(0, 24);
  const whitebox = clinicalMetrics?.whiteboxExtraction || {};
  const comparison = whitebox?.shadowComparison || {};
  const events = [];
  for (const code of normalizedCodes(comparison.encoderOnlyCodes)) {
    events.push(buildFeedbackEvent({
      ...context,
      eventType: "shadow_disagreement",
      code,
      kind: "unknown",
      category: "unknown",
      confidence: null,
      route: "encoder",
      outcome: "observed",
      rejectReason: null,
      failureFeatureTags: ["encoder_only"],
      eventIdentity: `${runIdentity}:shadow:encoder:${code}`
    }));
  }
  for (const code of normalizedCodes(comparison.llmOnlyCodes)) {
    events.push(buildFeedbackEvent({
      ...context,
      eventType: "shadow_disagreement",
      code,
      kind: "unknown",
      category: "unknown",
      confidence: null,
      route: "llm",
      outcome: "observed",
      rejectReason: null,
      failureFeatureTags: ["span_miss", "llm_only"],
      eventIdentity: `${runIdentity}:shadow:llm:${code}`
    }));
  }
  const contextDisagreementCount = boundedCount(whitebox?.contextDisagreementCount);
  const disagreementTags = normalizedContextDisagreementTags(
    whitebox?.contextDisagreementAxes
  );
  for (let index = 0; index < contextDisagreementCount; index += 1) {
    events.push(buildFeedbackEvent({
      ...context,
      eventType: "context_disagreement",
      code: "unresolved",
      kind: "unknown",
      category: "unknown",
      confidence: null,
      route: "encoder",
      outcome: "observed",
      rejectReason: null,
      failureFeatureTags: disagreementTags,
      eventIdentity: `${runIdentity}:context:${index}`
    }));
  }
  const emptyExtractionGuard = clinicalMetrics?.emptyExtractionGuard || {};
  if (emptyExtractionGuard?.triggered === true || emptyExtractionGuard?.retryAttempted === true) {
    events.push(buildFeedbackEvent({
      ...context,
      eventType: "empty_extraction_guard",
      code: "unresolved",
      kind: "unknown",
      category: "unknown",
      confidence: null,
      route: "llm",
      outcome: "observed",
      rejectReason: null,
      failureFeatureTags: ["empty_extraction"],
      eventIdentity: `${runIdentity}:empty_extraction_guard`
    }));
  }
  const lineReviewRetryCount = boundedCount(clinicalMetrics?.lineReviewRetryCount);
  if (lineReviewRetryCount > 0) {
    events.push(buildFeedbackEvent({
      ...context,
      eventType: "line_review_retry",
      code: "unresolved",
      kind: "unknown",
      category: "unknown",
      confidence: null,
      route: "llm",
      outcome: "observed",
      rejectReason: null,
      failureFeatureTags: ["line_review_retry"],
      eventIdentity: `${runIdentity}:line_review_retry:${lineReviewRetryCount}`
    }));
  }
  return events;
}

export async function captureExtractionFeedback({
  feeStore,
  events = [],
  env = process.env
} = {}) {
  const readiness = extractionFeedbackReadiness(env);
  if (readiness.mode !== "collect") {
    return { status: "disabled", storedCount: 0, readiness };
  }
  if (!readiness.ready) {
    return { status: "degraded", storedCount: 0, readiness };
  }
  if (typeof feeStore?.createExtractionFeedbackEvents !== "function") {
    return {
      status: "degraded",
      storedCount: 0,
      readiness: { ...readiness, ready: false, reason: "fee store does not support feedback events" }
    };
  }
  const validated = (Array.isArray(events) ? events : []).map(validateExtractionFeedbackEvent);
  if (!validated.length) {
    return { status: "complete", storedCount: 0, readiness };
  }
  const stored = await feeStore.createExtractionFeedbackEvents(validated[0].orgId, validated);
  return {
    status: "complete",
    storedCount: Array.isArray(stored) ? stored.length : validated.length,
    readiness
  };
}

export function validateExtractionFeedbackEvent(value) {
  assertNoForbiddenExtractionFeedbackFields(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw feedbackValidationError("feedback event must be an object");
  }
  const event = {
    schemaVersion: 1,
    eventId: requiredString(value.eventId, "eventId", 128),
    eventType: requiredEnum(value.eventType, EVENT_TYPE_SET, "eventType"),
    code: requiredString(value.code, "code", 64),
    kind: requiredString(value.kind, "kind", 64),
    category: requiredString(value.category, "category", 64),
    confidence: nullableProbability(value.confidence),
    route: requiredEnum(value.route, FEEDBACK_ROUTES, "route"),
    outcome: requiredEnum(value.outcome, FEEDBACK_OUTCOMES, "outcome"),
    rejectReason: value.rejectReason == null
      ? null
      : requiredEnum(value.rejectReason, REJECT_REASON_SET, "rejectReason"),
    specialty: requiredString(value.specialty, "specialty", 80),
    encounterSetting: requiredString(value.encounterSetting, "encounterSetting", 40),
    failureFeatureTags: normalizeFeatureTags(value.failureFeatureTags),
    sessionKeyHmac: hexDigest(value.sessionKeyHmac, "sessionKeyHmac"),
    hmacKeyVersion: requiredString(value.hmacKeyVersion, "hmacKeyVersion", 40),
    orgId: requiredString(value.orgId, "orgId", 128),
    occurredAt: isoTimestamp(value.occurredAt, "occurredAt"),
    purgeAt: isoTimestamp(value.purgeAt, "purgeAt"),
    learningEligible: value.learningEligible === true
  };
  if (event.outcome !== "rejected" && event.rejectReason !== null) {
    throw feedbackValidationError("rejectReason is only valid for rejected outcomes");
  }
  return event;
}

export function assertNoForbiddenExtractionFeedbackFields(value, path = "event") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenExtractionFeedbackFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key).replace(/[_-]/g, "").toLowerCase();
    if (FORBIDDEN_FIELD_NAMES.has(normalizedKey)) {
      throw feedbackValidationError(`forbidden feedback field: ${path}.${key}`);
    }
    assertNoForbiddenExtractionFeedbackFields(item, `${path}.${key}`);
  }
}

function feedbackContext({ orgId, feeSessionId, feeSession, env, now }) {
  const readiness = extractionFeedbackReadiness(env);
  if (!readiness.ready || readiness.mode !== "collect") {
    const error = new Error(readiness.reason || "extraction feedback collection is disabled");
    error.name = "ConfigurationError";
    throw error;
  }
  const normalizedOrgId = requiredString(orgId, "orgId", 128);
  const normalizedFeeSessionId = requiredString(feeSessionId, "feeSessionId", 256);
  const rootSecret = String(env.FEE_EXTRACTION_FEEDBACK_HMAC_SECRET || "");
  const orgKey = crypto.createHmac("sha256", rootSecret)
    .update(`halunasu:fee-feedback:org:${normalizedOrgId}`)
    .digest();
  const sessionKeyHmac = crypto.createHmac("sha256", orgKey)
    .update(`fee-session:${normalizedFeeSessionId}`)
    .digest("hex");
  const occurredAt = timestamp(now);
  return {
    orgId: normalizedOrgId,
    orgKey,
    sessionKeyHmac,
    hmacKeyVersion: readiness.hmacKeyVersion,
    specialty: feedbackSpecialty(feeSession),
    encounterSetting: feedbackEncounterSetting(feeSession),
    occurredAt,
    purgeAt: new Date(Date.parse(occurredAt) + TWO_YEARS_MS).toISOString()
  };
}

function buildFeedbackEvent({
  orgKey,
  eventIdentity,
  ...input
}) {
  const eventId = `fee_fb_${crypto.createHmac("sha256", orgKey)
    .update(`${input.sessionKeyHmac}:${eventIdentity}`)
    .digest("hex")
    .slice(0, 40)}`;
  const learningEligible = input.outcome === "approved"
    || (input.outcome === "rejected" && input.rejectReason === "extraction_wrong");
  return validateExtractionFeedbackEvent({
    schemaVersion: 1,
    eventId,
    eventType: input.eventType,
    code: input.code,
    kind: input.kind,
    category: input.category,
    confidence: input.confidence,
    route: input.route,
    outcome: input.outcome,
    rejectReason: input.rejectReason,
    specialty: input.specialty,
    encounterSetting: input.encounterSetting,
    failureFeatureTags: input.failureFeatureTags,
    sessionKeyHmac: input.sessionKeyHmac,
    hmacKeyVersion: input.hmacKeyVersion,
    orgId: input.orgId,
    occurredAt: input.occurredAt,
    purgeAt: input.purgeAt,
    learningEligible
  });
}

function reviewItemDescriptor(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const line = item.lineItem || item.candidateProposal?.candidateLine || null;
  const proposal = item.candidateProposal || null;
  const issue = item.reviewIssue || null;
  const source = [
    line?.extractionSource,
    line?.source,
    proposal?.route,
    proposal?.source,
    proposal?.basis,
    issue?.route,
    issue?.source
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  const route = source.includes("encoder") || source.includes("whitebox")
    ? "encoder"
    : source.includes("llm") || source.includes("openai") || source.includes("clinical")
      ? "llm"
      : null;
  if (!route) {
    return null;
  }
  const codeCandidates = Array.isArray(issue?.codeCandidates) ? issue.codeCandidates : [];
  const code = String(line?.code || proposal?.code || codeCandidates[0] || "unresolved").trim();
  const orderType = String(line?.orderType || proposal?.orderType || issue?.category || "unknown").trim();
  const tags = [];
  if (issue?.issueCode === "ambiguous_master") {
    tags.push("linker_low_margin");
  }
  if (issue?.categoryMismatch === true) {
    tags.push("category_mismatch");
  }
  return {
    code: code || "unresolved",
    kind: normalizeKind(orderType),
    category: normalizeCategory(orderType),
    confidence: nullableProbability(
      proposal?.confidence
      ?? line?.confidence
      ?? issue?.confidence
      ?? null
    ),
    route,
    failureFeatureTags: tags
  };
}

function feedbackSpecialty(session = {}) {
  return String(
    session.departmentSnapshot?.specialty
    || session.departmentSnapshot?.name
    || session.facilitySnapshot?.specialty
    || "unknown"
  ).trim().slice(0, 80) || "unknown";
}

function feedbackEncounterSetting(session = {}) {
  return String(session.setting || session.encounterDetails?.visitKind || "unknown")
    .trim()
    .slice(0, 40) || "unknown";
}

function normalizeKind(value) {
  const normalized = String(value || "unknown").toLowerCase();
  if (normalized.includes("drug") || normalized.includes("medication")) return "drug";
  if (normalized.includes("diagnos") || normalized.includes("disease")) return "disease";
  if (normalized === "unknown") return "unknown";
  return "procedure";
}

function normalizeCategory(value) {
  const normalized = String(value || "unknown").trim().toLowerCase();
  return normalized.slice(0, 64) || "unknown";
}

function normalizeFeatureTags(value) {
  const tags = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
  const unsupported = tags.filter((tag) => !FEATURE_TAG_SET.has(tag));
  if (unsupported.length) {
    throw feedbackValidationError(`unsupported failureFeatureTags: ${unsupported.join(", ")}`);
  }
  return tags.sort();
}

function normalizedCodes(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((code) => String(code || "").trim())
    .filter(Boolean))]
    .sort();
}

function normalizedContextDisagreementTags(value) {
  const mapping = {
    action_status: "wrong_context_axis:action_status",
    temporal_relation: "wrong_context_axis:temporal_relation",
    source_origin: "wrong_context_axis:source_origin",
    provider_ownership: "wrong_context_axis:provider_ownership",
    standing_status: "wrong_context_axis:standing_status"
  };
  const tags = [...new Set((Array.isArray(value) ? value : [])
    .map((axis) => mapping[String(axis || "").trim()])
    .filter(Boolean))];
  return tags.length ? tags : ["wrong_context_axis:temporal_relation"];
}

function boundedCount(value) {
  return Math.min(100, Math.max(0, Number.parseInt(value, 10) || 0));
}

function nullableProbability(value) {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    throw feedbackValidationError("confidence must be null or a number from 0 to 1");
  }
  return numeric;
}

function requiredString(value, field, maximumLength) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw feedbackValidationError(`${field} is required`);
  }
  if (normalized.length > maximumLength) {
    throw feedbackValidationError(`${field} exceeds ${maximumLength} characters`);
  }
  return normalized;
}

function requiredEnum(value, allowed, field) {
  const normalized = String(value || "").trim();
  if (!allowed.has(normalized)) {
    throw feedbackValidationError(`${field} has an unsupported value`);
  }
  return normalized;
}

function hexDigest(value, field) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw feedbackValidationError(`${field} must be a SHA-256 HMAC digest`);
  }
  return normalized;
}

function isoTimestamp(value, field) {
  const normalized = String(value || "").trim();
  const epoch = Date.parse(normalized);
  if (!normalized || !Number.isFinite(epoch)) {
    throw feedbackValidationError(`${field} must be an ISO timestamp`);
  }
  return new Date(epoch).toISOString();
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw feedbackValidationError("now must be a valid date");
  }
  return date.toISOString();
}

function feedbackValidationError(message) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  return error;
}
