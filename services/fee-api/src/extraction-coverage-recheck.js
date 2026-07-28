import crypto from "node:crypto";

export const CLINICAL_EXTRACTION_STRATEGIES = Object.freeze([
  "openai_primary",
  "whitebox_experiment"
]);

export const EXTRACTION_COVERAGE_MODES = Object.freeze([
  "off",
  "observe",
  "verify"
]);

const AUXILIARY_COVERAGE_CATEGORIES = new Set([
  "counseling",
  "exam",
  "imaging",
  "injection",
  "lab",
  "management",
  "material",
  "medication",
  "other",
  "outpatient_basic",
  "pathology",
  "procedure",
  "treatment"
]);

const GENERIC_SPAN_TERMS = new Set([
  "検査",
  "処置",
  "処方",
  "治療",
  "管理",
  "指導",
  "材料",
  "薬剤",
  "診察",
  "行為",
  "実施"
]);

export function normalizeClinicalExtractionStrategy(value = "") {
  const normalized = String(value || "openai_primary").trim().toLowerCase();
  return CLINICAL_EXTRACTION_STRATEGIES.includes(normalized)
    ? normalized
    : "openai_primary";
}

export function normalizeExtractionCoverageMode(value = "") {
  const normalized = String(value || "off").trim().toLowerCase();
  return EXTRACTION_COVERAGE_MODES.includes(normalized) ? normalized : "off";
}

export function normalizeExtractionCoverageOptions(value = {}) {
  const mode = normalizeExtractionCoverageMode(value?.mode);
  const facilityAllowed = value?.facilityAllowed !== false;
  return {
    mode: facilityAllowed ? mode : "off",
    configuredMode: mode,
    facilityAllowed,
    disabledReason: facilityAllowed
      ? (mode === "off" ? "mode_off" : null)
      : String(value?.disabledReason || "facility_not_allowlisted"),
    maxLines: boundedInteger(value?.maxLines, 1, 16, 8),
    maxSpans: boundedInteger(value?.maxSpans, 1, 32, 16),
    timeoutMs: boundedInteger(value?.timeoutMs, 100, 30000, 2000)
  };
}

export function buildClinicalFactCoverageIndex(facts = {}) {
  const byLineId = new Map();
  const append = (lineId, values = [], source = "") => {
    const normalizedLineId = String(lineId || "").trim();
    if (!normalizedLineId) {
      return;
    }
    const current = byLineId.get(normalizedLineId) || {
      lineId: normalizedLineId,
      terms: new Set(),
      sources: new Set(),
      lineRoles: new Set()
    };
    for (const value of values) {
      const term = normalizeCoverageText(value);
      if (term) {
        current.terms.add(term);
      }
    }
    if (source) {
      current.sources.add(source);
    }
    byLineId.set(normalizedLineId, current);
  };

  for (const event of [
    ...asArray(facts?.clinical_events),
    ...asArray(facts?.excluded_events)
  ]) {
    const source = asArray(facts?.clinical_events).includes(event)
      ? "clinical_event"
      : "excluded_event";
    const values = [
      event?.name,
      event?.clinical_name,
      event?.evidence,
      event?.evidence_quote,
      event?.evidenceQuote,
      ...asArray(event?.search_queries)
    ];
    for (const lineId of evidenceLineIds(event)) {
      append(lineId, values, source);
    }
  }

  for (const mention of asArray(facts?.standing_mentions)) {
    append(
      mention?.line_id || mention?.lineId,
      [mention?.target, mention?.name],
      "standing_mention"
    );
  }

  for (const review of asArray(facts?.line_review)) {
    const lineId = String(review?.line_id || review?.lineId || "").trim();
    if (!lineId) {
      continue;
    }
    append(lineId, [], "line_review");
    byLineId.get(lineId)?.lineRoles.add(
      String(review?.line_role || review?.lineRole || "none").trim()
    );
  }

  return byLineId;
}

export function findUncoveredAuxiliarySpans({
  signals = [],
  facts = {},
  lines = []
} = {}) {
  const lineById = new Map(asArray(lines).map((line) => [
    String(line?.lineId || line?.line_id || "").trim(),
    line
  ]));
  const coverageIndex = buildClinicalFactCoverageIndex(facts);
  const coveredSignals = [];
  const gapSignals = [];
  const ignoredSignals = [];

  for (const signal of dedupeSignals(signals)) {
    const lineId = String(signal?.lineId || "").trim();
    const line = lineById.get(lineId);
    const phrase = spanTextFromSignal(signal, line);
    if (!line || !isReviewableAuxiliarySpan(signal, phrase, line)) {
      ignoredSignals.push(signal);
      continue;
    }
    const coverage = coverageIndex.get(lineId);
    const covered = [...(coverage?.terms || [])].some((term) => (
      coverageTermsOverlap(term, phrase)
    ));
    const enriched = {
      ...signal,
      detectedPhrase: phrase
    };
    if (covered) {
      coveredSignals.push(enriched);
    } else {
      gapSignals.push(enriched);
    }
  }

  return {
    detectedSignals: [...coveredSignals, ...gapSignals],
    coveredSignals,
    gapSignals,
    ignoredSignals
  };
}

export function planExtractionRecovery({
  lines = [],
  missingLineIds = [],
  emptyExtractionTriggered = false,
  gapSignals = [],
  maxLines = 8,
  maxSpans = 16
} = {}) {
  const normalizedLines = asArray(lines);
  const lineById = new Map(normalizedLines.map((line) => [
    String(line?.lineId || line?.line_id || "").trim(),
    line
  ]));
  const orderedLineIds = [];
  const reasonsByLineId = new Map();
  const appendLine = (lineId, reason) => {
    const normalized = String(lineId || "").trim();
    if (!normalized || !lineById.has(normalized)) {
      return;
    }
    if (!reasonsByLineId.has(normalized)) {
      orderedLineIds.push(normalized);
      reasonsByLineId.set(normalized, new Set());
    }
    reasonsByLineId.get(normalized).add(reason);
  };

  for (const lineId of missingLineIds) {
    appendLine(lineId, "line_review_missing");
  }

  const orderedGapSignals = [...asArray(gapSignals)]
    .sort((left, right) => (
      Number(right?.confidence || 0) - Number(left?.confidence || 0)
      || String(left?.lineId || "").localeCompare(String(right?.lineId || ""))
      || Number(left?.charStart || 0) - Number(right?.charStart || 0)
    ))
    .slice(0, Math.max(1, Number(maxSpans || 16)));
  for (const signal of orderedGapSignals) {
    appendLine(signal?.lineId, "auxiliary_span_gap");
  }

  if (emptyExtractionTriggered && !orderedLineIds.length) {
    for (const line of normalizedLines) {
      appendLine(line?.lineId || line?.line_id, "empty_extraction");
    }
  } else if (emptyExtractionTriggered) {
    for (const lineId of orderedLineIds) {
      reasonsByLineId.get(lineId)?.add("empty_extraction");
    }
  }

  const selectedLineIds = orderedLineIds.slice(0, Math.max(1, Number(maxLines || 8)));
  const selectedLineIdSet = new Set(selectedLineIds);
  const selectedSignals = orderedGapSignals.filter((signal) => (
    selectedLineIdSet.has(String(signal?.lineId || ""))
  ));
  const coverageReviewTargets = selectedSignals.map((signal) => ({
    line_id: String(signal.lineId || ""),
    category: String(signal.category || ""),
    detected_phrase: String(signal.detectedPhrase || "").slice(0, 80)
  }));

  return {
    needed: selectedLineIds.length > 0,
    lineIds: selectedLineIds,
    lines: selectedLineIds.map((lineId) => lineById.get(lineId)).filter(Boolean),
    coverageReviewTargets,
    selectedSignals,
    reasonCodes: uniqueStrings(selectedLineIds.flatMap((lineId) => (
      [...(reasonsByLineId.get(lineId) || [])]
    ))),
    omittedLineCount: Math.max(0, orderedLineIds.length - selectedLineIds.length),
    omittedSpanCount: Math.max(0, asArray(gapSignals).length - selectedSignals.length)
  };
}

export function stampAuxiliaryRecheckProvenance(facts = {}, {
  recheckTag = "openai-auxiliary-span-recheck-v1"
} = {}) {
  const stampEvent = (event) => ({
    ...event,
    extraction_source: "openai_auxiliary_recheck",
    extraction: {
      ...(isPlainObject(event?.extraction) ? event.extraction : {}),
      source: "openai_auxiliary_recheck",
      recheckTag
    }
  });
  return {
    ...facts,
    clinical_events: asArray(facts?.clinical_events).map(stampEvent),
    excluded_events: asArray(facts?.excluded_events).map(stampEvent),
    standing_mentions: asArray(facts?.standing_mentions).map((mention) => ({
      ...mention,
      extraction_source: "openai_auxiliary_recheck"
    }))
  };
}

export function mergeAuxiliaryRecheckFacts(initialFacts = {}, recheckFacts = {}) {
  const initial = isPlainObject(initialFacts) ? initialFacts : {};
  const recheck = stampAuxiliaryRecheckProvenance(
    isPlainObject(recheckFacts) ? recheckFacts : {}
  );
  const merged = {
    ...initial,
    visit_type: initial.visit_type,
    visit_facts: initial.visit_facts
  };
  const initialEvents = asArray(initial.clinical_events);
  const initialExcludedEvents = asArray(initial.excluded_events);
  const recheckEvents = asArray(recheck.clinical_events);
  const recheckExcludedEvents = asArray(recheck.excluded_events);
  const mergedEvents = [...initialEvents];
  const eventByIdentity = new Map(initialEvents.map((event) => [
    clinicalEventIdentity(event),
    event
  ]));
  const initialCurrentSubjects = new Set(
    initialEvents.map(clinicalEventSubjectIdentity)
  );
  const initialExcludedSubjects = new Set(
    initialExcludedEvents.map(clinicalEventSubjectIdentity)
  );
  const recheckCurrentSubjects = new Set(
    recheckEvents.map(clinicalEventSubjectIdentity)
  );
  const recheckExcludedSubjects = new Set(
    recheckExcludedEvents.map(clinicalEventSubjectIdentity)
  );
  const mergedCurrentSubjects = new Set(initialCurrentSubjects);
  const conflicts = detectAuxiliaryExtractionConflicts(
    initialEvents,
    recheckEvents,
    {
      initialExcludedEvents,
      recheckExcludedEvents
    }
  );
  let recoveredClinicalEventCount = 0;

  for (const event of recheckEvents) {
    const subjectIdentity = clinicalEventSubjectIdentity(event);
    if (
      mergedCurrentSubjects.has(subjectIdentity)
      || initialExcludedSubjects.has(subjectIdentity)
      || recheckExcludedSubjects.has(subjectIdentity)
    ) {
      continue;
    }
    const identity = clinicalEventIdentity(event);
    const existing = eventByIdentity.get(identity);
    if (!existing) {
      eventByIdentity.set(identity, event);
      mergedCurrentSubjects.add(subjectIdentity);
      mergedEvents.push(event);
      recoveredClinicalEventCount += 1;
      continue;
    }
  }
  merged.clinical_events = mergedEvents;
  merged.excluded_events = dedupeObjects([
    ...initialExcludedEvents,
    ...recheckExcludedEvents.filter((event) => {
      const subjectIdentity = clinicalEventSubjectIdentity(event);
      return !initialCurrentSubjects.has(subjectIdentity)
        && !recheckCurrentSubjects.has(subjectIdentity);
    })
  ], excludedEventIdentity);
  // The auxiliary sensor detects acts, not diagnoses or monthly standing facts.
  // Keeping the initial OpenAI values prevents an auxiliary response from
  // entering disease- or standing-driven candidate lanes without provenance.
  merged.diagnoses = asArray(initial.diagnoses);
  merged.standing_mentions = asArray(initial.standing_mentions);
  merged.missing_information = dedupeObjects([
    ...asArray(initial.missing_information),
    ...asArray(recheck.missing_information)
  ], (entry) => JSON.stringify(entry));
  merged.review_flags = uniqueStrings([
    ...asArray(initial.review_flags),
    ...asArray(recheck.review_flags)
  ]);

  merged.line_review = mergeLineReview(
    asArray(initial.line_review),
    asArray(recheck.line_review)
  );

  return {
    facts: merged,
    recoveredClinicalEventCount,
    conflicts
  };
}

export function detectAuxiliaryExtractionConflicts(
  initialEvents = [],
  recheckEvents = [],
  {
    initialExcludedEvents = [],
    recheckExcludedEvents = []
  } = {}
) {
  const initialBySubject = new Map(asArray(initialEvents).map((event) => [
    clinicalEventSubjectIdentity(event),
    event
  ]));
  const initialExcludedBySubject = new Map(
    asArray(initialExcludedEvents).map((event) => [
      clinicalEventSubjectIdentity(event),
      event
    ])
  );
  const recheckExcludedBySubject = new Map(
    asArray(recheckExcludedEvents).map((event) => [
      clinicalEventSubjectIdentity(event),
      event
    ])
  );
  const conflicts = [];
  const appendConflict = (initial, recheck, reason) => {
    const subjectIdentity = clinicalEventSubjectIdentity(recheck);
    conflicts.push({
      identityHash: stableHash(subjectIdentity),
      lineIds: evidenceLineIds(recheck),
      initialDisposition: clinicalEventDisposition(initial),
      recheckDisposition: clinicalEventDisposition(recheck),
      reason
    });
  };
  for (const event of asArray(recheckEvents)) {
    const subjectIdentity = clinicalEventSubjectIdentity(event);
    const existing = initialBySubject.get(subjectIdentity);
    const excluded = initialExcludedBySubject.get(subjectIdentity);
    const recheckExcluded = recheckExcludedBySubject.get(subjectIdentity);
    if (excluded) {
      appendConflict(excluded, event, "initial_excluded_recheck_current");
    } else if (recheckExcluded) {
      appendConflict(recheckExcluded, event, "recheck_internal_conflict");
    } else if (
      existing
      && clinicalEventDisposition(existing) !== clinicalEventDisposition(event)
    ) {
      appendConflict(existing, event, "initial_recheck_disposition_mismatch");
    }
  }
  for (const event of asArray(recheckExcludedEvents)) {
    const subjectIdentity = clinicalEventSubjectIdentity(event);
    const existing = initialBySubject.get(subjectIdentity);
    if (existing) {
      appendConflict(existing, event, "initial_current_recheck_excluded");
    }
  }
  return dedupeObjects(conflicts, (conflict) => [
    conflict.identityHash,
    conflict.initialDisposition,
    conflict.recheckDisposition,
    conflict.reason
  ].join("|"));
}

function mergeLineReview(initialEntries = [], recheckEntries = []) {
  const rolePriority = {
    none: 0,
    plan: 1,
    management_continuation: 2,
    performed: 3
  };
  const byLineId = new Map();
  const order = [];
  for (const entry of [...asArray(initialEntries), ...asArray(recheckEntries)]) {
    const lineId = String(entry?.line_id || entry?.lineId || "").trim();
    if (!lineId) {
      continue;
    }
    if (!byLineId.has(lineId)) {
      byLineId.set(lineId, entry);
      order.push(lineId);
      continue;
    }
    const current = byLineId.get(lineId);
    const currentRole = String(current?.line_role || current?.lineRole || "none").trim();
    const nextRole = String(entry?.line_role || entry?.lineRole || "none").trim();
    if ((rolePriority[nextRole] ?? 0) > (rolePriority[currentRole] ?? 0)) {
      byLineId.set(lineId, entry);
    }
  }
  return order.map((lineId) => byLineId.get(lineId));
}

export function auxiliaryRecheckEvent(event = {}) {
  return String(
    event?.extraction_source
    || event?.extractionSource
    || event?.extraction?.source
    || ""
  ).trim().toLowerCase() === "openai_auxiliary_recheck";
}

function isReviewableAuxiliarySpan(signal = {}, phrase = "", line = {}) {
  const category = String(signal?.category || "").trim().toLowerCase();
  const confidence = Number(signal?.confidence);
  const threshold = Number(signal?.artifactThreshold);
  const normalizedPhrase = normalizeCoverageText(phrase);
  const normalizedLine = normalizeCoverageText(line?.text);
  return AUXILIARY_COVERAGE_CATEGORIES.has(category)
    && Number.isFinite(confidence)
    && Number.isFinite(threshold)
    && confidence >= threshold
    && normalizedPhrase.length >= 2
    && normalizedLine.length >= 2
    && !GENERIC_SPAN_TERMS.has(normalizedPhrase);
}

function coverageTermsOverlap(term = "", phrase = "") {
  const normalizedTerm = normalizeCoverageText(term);
  const normalizedPhrase = normalizeCoverageText(phrase);
  if (!normalizedTerm || !normalizedPhrase) {
    return false;
  }
  if (normalizedTerm === normalizedPhrase) {
    return true;
  }
  const shorter = normalizedTerm.length <= normalizedPhrase.length
    ? normalizedTerm
    : normalizedPhrase;
  const longer = shorter === normalizedTerm ? normalizedPhrase : normalizedTerm;
  return shorter.length >= 3 && longer.includes(shorter);
}

function normalizeCoverageText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[（）()\[\]【】「」『』、，,。．.・･:：;；/／\s]/gu, "")
    .replace(/(?:診療料|管理料|指導料|検査料|判断料|撮影料|処置料|加算|を実施|実施した|施行した|を施行|を処方|処方した)$/gu, "")
    .trim();
}

function spanTextFromSignal(signal = {}, line = {}) {
  const codePoints = [...String(line?.text || "")];
  const start = Number(signal?.charStart);
  const end = Number(signal?.charEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    return "";
  }
  return codePoints.slice(start, end).join("").trim();
}

function evidenceLineIds(event = {}) {
  return uniqueStrings([
    ...asArray(event?.evidence_line_ids),
    ...asArray(event?.evidenceLineIds),
    event?.line_id,
    event?.lineId
  ]);
}

function clinicalEventIdentity(event = {}) {
  return [
    String(event?.type || event?.event_type || "").trim().toLowerCase(),
    clinicalEventSubjectIdentity(event)
  ].join("|");
}

function clinicalEventSubjectIdentity(event = {}) {
  return [
    normalizeCoverageText(event?.name),
    ...evidenceLineIds(event).sort()
  ].join("|");
}

function excludedEventIdentity(event = {}) {
  return [
    clinicalEventIdentity(event),
    String(event?.status || event?.action_status || "").trim(),
    String(event?.reason || "").trim()
  ].join("|");
}

function clinicalEventDisposition(event = {}) {
  return [
    event?.action_status || event?.actionStatus || event?.status || "",
    event?.temporal_relation || event?.temporalRelation || "",
    event?.source_origin || event?.sourceOrigin || "",
    event?.provider_ownership || event?.providerOwnership || ""
  ].map((value) => String(value || "").trim().toLowerCase()).join("|");
}

function dedupeSignals(signals = []) {
  return dedupeObjects(asArray(signals), (signal) => [
    signal?.lineId,
    signal?.clauseId,
    signal?.category,
    signal?.charStart,
    signal?.charEnd,
    signal?.normalizedTextHash
  ].join("|"));
}

function dedupeObjects(values = [], keyBuilder = (value) => JSON.stringify(value)) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values).filter(Boolean)) {
    const key = String(keyBuilder(value) || "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uniqueStrings(values = []) {
  return [...new Set(asArray(values)
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function stableHash(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
