const CANONICAL_FACT_AUTOMATIC_BILLING_STATUSES = Object.freeze([
  "eligible_for_master_search",
  "eligible_for_billing"
]);

export function billingIntentsFromCanonicalClinicalFacts(facts = []) {
  return normalizeBillingIntents(asArray(facts)
    .filter((fact) => canonicalFactCanProceedToAutomaticBillingFact(fact))
    .map((fact) => {
      const sourceFactId = String(fact?.factId || fact?.fact_id || "").trim();
      const intentType = billingIntentTypeFromFact(fact);
      return {
        billingIntentId: `intent_${candidateIdPart([sourceFactId, intentType].join("_"))}`,
        sourceFactId,
        intentType,
        conceptId: String(fact?.conceptId || fact?.concept_id || "").trim(),
        eventType: String(fact?.eventType || fact?.event_type || "").trim(),
        billingDomain: String(fact?.billingDomain || fact?.billing_domain || "").trim(),
        clinicalName: String(fact?.clinicalName || fact?.clinical_name || "").trim(),
        evidenceRefs: asArray(fact?.evidenceRefs || fact?.evidence_refs),
        status: "ready_for_master_linking",
        source: "canonical_clinical_fact"
      };
    }));
}

export function normalizeBillingIntents(values = []) {
  const seen = new Set();
  const result = [];
  for (const intent of asArray(values)) {
    if (!intent || typeof intent !== "object") {
      continue;
    }
    const key = [
      intent.billingIntentId,
      intent.sourceFactId,
      intent.intentType
    ].join("|");
    if (!intent.sourceFactId || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(intent);
  }
  return result.slice(0, 120);
}

export function calculationEventsFromCanonicalFacts({
  facts = [],
  billingIntents = []
} = {}) {
  const intentByFactId = new Map(normalizeBillingIntents(billingIntents)
    .map((intent) => [String(intent.sourceFactId || "").trim(), intent])
    .filter(([factId]) => factId));
  return asArray(facts)
    .map((fact, index) => {
      const intent = intentByFactId.get(canonicalFactId(fact)) || null;
      return calculationEventFromCanonicalFact(fact, intent, index);
    })
    .filter(Boolean);
}

export function billingIntentTypeFromFact(fact = {}) {
  const type = String(fact?.eventType || fact?.event_type || "").trim();
  if (type === "lab" || type === "exam") return "lab_test";
  if (type === "imaging") return "imaging_order";
  if (type === "medication") return "medication_order";
  if (type === "material") return "material_input";
  if (type === "procedure" || type === "treatment") return "procedure_code";
  if (type === "management" || type === "counseling") return "management_review";
  return "clinical_event";
}

export function canonicalFactCanProceedToAutomaticBillingFact(fact = {}) {
  const status = String(fact?.status || "").trim();
  const verificationStatus = String(fact?.verification?.status || fact?.verificationStatus || fact?.verification_status || "").trim();
  return CANONICAL_FACT_AUTOMATIC_BILLING_STATUSES.includes(status)
    && verificationStatus === "verified";
}

export { CANONICAL_FACT_AUTOMATIC_BILLING_STATUSES };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values)) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalFactId(fact = {}) {
  return String(fact?.factId || fact?.fact_id || "").trim();
}

function calculationEventFromCanonicalFact(fact = {}, intent = null, index = 0) {
  const factId = canonicalFactId(fact);
  if (!factId) {
    return null;
  }
  const evidenceRefs = asArray(fact.evidenceRefs || fact.evidence_refs);
  const evidenceRef = evidenceRefs[0] || {};
  const normalization = isPlainObject(fact?.normalization) ? fact.normalization : {};
  const clinicalEventId = String(fact?.clinicalEventId || fact?.clinical_event_id || `canonical_fact_${index + 1}`).trim();
  const searchQueries = uniqueStrings([
    ...asArray(fact?.searchQueries),
    ...asArray(fact?.search_queries),
    ...asArray(fact?.extraction?.searchQueries),
    ...asArray(fact?.extraction?.search_queries),
    ...asArray(intent?.searchQueries),
    ...asArray(intent?.search_queries),
    fact?.clinicalName,
    fact?.clinical_name,
    intent?.clinicalName
  ]);
  const evidenceLineIds = uniqueStrings(evidenceRefs
    .map((ref) => ref?.lineId || ref?.line_id)
    .filter(Boolean));
  return {
    clinicalEventId,
    clinical_event_id: clinicalEventId,
    type: String(fact?.eventType || fact?.event_type || intent?.eventType || "other").trim() || "other",
    billing_domain: String(fact?.billingDomain || fact?.billing_domain || intent?.billingDomain || "unknown").trim() || "unknown",
    billingDomain: String(fact?.billingDomain || fact?.billing_domain || intent?.billingDomain || "unknown").trim() || "unknown",
    name: String(fact?.clinicalName || fact?.clinical_name || intent?.clinicalName || "").trim(),
    action_status: String(fact?.actionStatus || fact?.action_status || "unknown").trim() || "unknown",
    actionStatus: String(fact?.actionStatus || fact?.action_status || "unknown").trim() || "unknown",
    temporal_relation: String(fact?.temporalRelation || fact?.temporal_relation || "unknown").trim() || "unknown",
    temporalRelation: String(fact?.temporalRelation || fact?.temporal_relation || "unknown").trim() || "unknown",
    source_origin: String(fact?.sourceOrigin || fact?.source_origin || "unknown").trim() || "unknown",
    sourceOrigin: String(fact?.sourceOrigin || fact?.source_origin || "unknown").trim() || "unknown",
    provider_ownership: String(fact?.providerOwnership || fact?.provider_ownership || "unknown").trim() || "unknown",
    providerOwnership: String(fact?.providerOwnership || fact?.provider_ownership || "unknown").trim() || "unknown",
    result_assertion: String(fact?.resultAssertion || fact?.result_assertion || "unknown").trim() || "unknown",
    resultAssertion: String(fact?.resultAssertion || fact?.result_assertion || "unknown").trim() || "unknown",
    certainty: String(fact?.certainty || "ambiguous").trim() || "ambiguous",
    section: evidenceRef.section || "unknown",
    evidence: evidenceRef.quote || "",
    evidence_line_ids: evidenceLineIds,
    evidenceLineIds,
    search_queries: searchQueries,
    searchQueries,
    modality: normalization.modality || "none",
    body_site: normalization.bodySite || normalization.body_site || "",
    specimen: normalization.specimen || "",
    collection_method: normalization.collectionMethod || normalization.collection_method || "",
    area_size_cm2: normalization.areaSizeCm2 || normalization.area_size_cm2 || "",
    quantity_per_day: normalization.quantityPerDay || normalization.quantity_per_day || "",
    days: normalization.days || "",
    total_quantity: normalization.totalQuantity || normalization.total_quantity || "",
    review_reason: String(fact?.reviewReason || fact?.review_reason || fact?.extraction?.reviewReason || fact?.extraction?.review_reason || "").trim(),
    reviewReason: String(fact?.reviewReason || fact?.review_reason || fact?.extraction?.reviewReason || fact?.extraction?.review_reason || "").trim(),
    source: fact?.extraction?.source || "canonical_clinical_fact",
    extractionSource: fact?.extraction?.source || "canonical_clinical_fact",
    canonicalFactId: factId,
    sourceFactId: factId,
    source_fact_id: factId,
    canonicalFactStatus: fact.status || "unknown",
    canonical_fact_status: fact.status || "unknown",
    conceptId: fact.conceptId || fact.concept_id || intent?.conceptId || null,
    concept_id: fact.conceptId || fact.concept_id || intent?.conceptId || null,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    evidenceVerificationStatus: fact?.verification?.status || fact?.verificationStatus || fact?.verification_status || "unknown",
    evidence_verification_status: fact?.verification?.status || fact?.verificationStatus || fact?.verification_status || "unknown",
    evidenceVerificationReasons: asArray(fact?.verification?.reasons),
    evidence_verification_reasons: asArray(fact?.verification?.reasons),
    ...(intent ? {
      billingIntentId: intent.billingIntentId,
      sourceBillingIntentId: intent.billingIntentId,
      source_billing_intent_id: intent.billingIntentId,
      billingIntentType: intent.intentType
    } : {})
  };
}

function candidateIdPart(value) {
  const normalized = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || "item";
}
