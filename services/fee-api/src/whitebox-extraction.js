import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { clinicalServiceContextCues } from "../../../packages/fee-contracts/src/index.js";

export const WHITEBOX_LINKER_MODES = Object.freeze(["off", "shadow", "propose"]);
export const WHITEBOX_CONTEXT_MODES = Object.freeze(["off", "shadow", "assist"]);
export const WHITEBOX_SPAN_MODES = Object.freeze(["off", "shadow", "route"]);

export const DEFAULT_WHITEBOX_THRESHOLDS = Object.freeze({
  schemaVersion: 1,
  // Promotion routing remains intentionally strict.
  spanConfidence: 0.9,
  // Shadow diagnostics trust spans that already passed the artifact's
  // category-specific decoder threshold.
  spanShadowConfidence: 0,
  // WX3 applies calibrated per-axis thresholds in the ONNX runtime.
  // This optional router threshold may only make that decision stricter.
  contextConfidence: 0,
  linkerHighScore: 0.92,
  linkerReviewScore: 0.8,
  linkerMargin: 0.05,
  // These values never activate encoder routing. They only make shadow
  // measurements useful enough to calibrate the promotion thresholds.
  linkerShadowScore: 0.8,
  linkerShadowMargin: 0.02,
  relevanceConfidence: 0.95
});

const WHITEBOX_THRESHOLD_FIELDS = Object.freeze([
  "spanConfidence",
  "spanShadowConfidence",
  "contextConfidence",
  "linkerHighScore",
  "linkerReviewScore",
  "linkerMargin",
  "linkerShadowScore",
  "linkerShadowMargin",
  "relevanceConfidence"
]);

const WHITEBOX_SUPPORTED_SETTINGS = new Set([
  "outpatient",
  "home_visit",
  "house_call",
  "telephone"
]);

const EXTERNAL_SOURCE_ORIGINS = new Set([
  "patient_reported",
  "external_document",
  "carried_in_result",
  "other_provider_record"
]);

const EXTERNAL_PROVIDER_OWNERSHIPS = new Set([
  "same_institution_other_department",
  "other_provider"
]);

const CURRENT_ACTION_STATUSES = new Set([
  "performed",
  "prescribed",
  "administered",
  "instruction_only"
]);

const PLAN_ACTION_STATUSES = new Set([
  "ordered",
  "planned",
  "considered"
]);

const TRIVIAL_LINE_PATTERNS = Object.freeze([
  /^\s*$/u,
  /^(?:S|O|A|P)[（(:：]?\s*$/iu,
  /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?\s*$/u,
  /^(?:BP|血圧|P|脈拍|SpO2|体温)\s*[:：]?\s*[\d./%\s℃]+$/iu
]);

const VISIT_FACTS_SENSITIVE_PATTERN = /(?:処方箋|(?:院外|院内)(?:での?)?処方|処方(?:は|を)?(?:院外|院内)|一般名(?:処方|で処方|記載)|リフィル)/u;
const OUTSIDE_PRESCRIPTION_POSITIVE_PATTERN = /(?:院外処方(?:箋)?|処方(?:箋|せん)).{0,16}(?:交付|発行|出した|処方した|あり|有り)|(?:交付|発行).{0,10}(?:院外処方(?:箋)?|処方(?:箋|せん))/u;
const OUTSIDE_PRESCRIPTION_NEGATIVE_PATTERN = /(?:院外処方(?:箋)?|処方(?:箋|せん)).{0,16}(?:交付していない|交付せず|交付なし|発行していない|発行せず|発行なし|出していない|出さず|なし|無し|ない|無い)/u;
const IN_HOUSE_PRESCRIPTION_PATTERN = /(?:院内(?:での?)?(?:処方|投薬)|院内処方|院内で外用薬として処方)/u;
const GENERIC_NAME_PRESCRIPTION_PATTERN = /(?:一般名(?:で)?処方|一般名処方(?:箋)?|一般名記載)/u;
const MEDICATION_BILLING_ACT_PATTERN = /(?:処方箋|処方料|調剤料|一般名処方|リフィル|薬剤情報提供|投薬|院内処方|院外処方)/u;
const DRUG_PRODUCT_PATTERN = /(?:錠|カプセル|散|顆粒|細粒|シロップ|液|軟膏|クリーム|ゲル|テープ|パッチ|坐剤|注射液|点眼|点鼻|吸入|mg|μg|mcg|mL|％|%)/iu;
const MAX_REVIEWABLE_LINKER_FAMILY_SIZE = 25;
const NON_BLOCKING_LINKER_REASON_CODES = new Set(["linker_family_identified"]);
const WHITEBOX_CLAUSE_BOUNDARY_PATTERN = /(?:[。！？!?；;]+|[、,](?=\s*(?:本日|今回|当日|前回|先月|以前|過去|次回|後日|今後|他院|前医|当院|院内|自院)))/gu;

export const WHITEBOX_CONTEXT_REASON_DISPOSITIONS = Object.freeze({
  classifier_only: "diagnostic",
  classifier_predicate_agree: "diagnostic",
  classifier_predicate_disagreement: "blocker",
  classifier_predicate_disagreement_safe_downgrade: "safe_downgrade",
  classifier_requests_llm: "blocker",
  context_abstain_or_low_confidence: "blocker",
  context_missing: "blocker",
  context_unresolved: "blocker",
  current_own_performed: "diagnostic",
  current_own_standing: "diagnostic",
  current_visit_predicate_compatible_with_standing: "diagnostic",
  future_or_plan: "safe_exclusion",
  not_performed: "safe_exclusion",
  past_or_external_context: "safe_exclusion",
  predicate_safe_exclusion: "safe_downgrade",
  same_day_but_unknown: "blocker"
});

export function splitWhiteboxEvidenceClauses(line = {}) {
  const text = String(line?.text || "");
  const clauses = [];
  let start = 0;
  const append = (rawStart, rawEnd) => {
    const raw = text.slice(rawStart, rawEnd);
    const leading = raw.search(/\S/u);
    if (leading < 0) {
      return;
    }
    const trimmedRight = raw.trimEnd();
    const clauseStart = rawStart + leading;
    const clauseEnd = rawStart + trimmedRight.length;
    const clauseText = text.slice(clauseStart, clauseEnd);
    const localCues = clinicalServiceContextCues(clauseText);
    const inheritCurrentVisit = line?.cues?.currentVisit === true
      && !localCues.pastOrExternal
      && !localCues.futureOrOrderOnly;
    clauses.push({
      clauseId: `${String(line?.lineId || "L")}:C${String(clauses.length + 1).padStart(3, "0")}`,
      lineId: String(line?.lineId || ""),
      text: clauseText,
      charStart: clauseStart,
      charEnd: clauseEnd,
      cues: {
        ...localCues,
        currentVisit: localCues.currentVisit || inheritCurrentVisit,
        syntheticMeta: line?.cues?.syntheticMeta === true
      }
    });
  };
  for (const match of text.matchAll(WHITEBOX_CLAUSE_BOUNDARY_PATTERN)) {
    const end = Number(match.index || 0) + match[0].length;
    append(start, end);
    start = end;
  }
  append(start, text.length);
  if (!clauses.length && text.length) {
    append(0, text.length);
  }
  return clauses;
}

function whiteboxClauseForSpan(clauses = [], span = {}) {
  const start = Number(span?.charStart);
  const end = Number(span?.charEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return clauses[0] || null;
  }
  return clauses.find((clause) => start < clause.charEnd && end > clause.charStart)
    || clauses.find((clause) => start >= clause.charStart && start <= clause.charEnd)
    || clauses[0]
    || null;
}

export function whiteboxRuntimeModes(env = process.env) {
  return {
    linker: enumMode(env.FEE_LINKER_MODE, WHITEBOX_LINKER_MODES, "off"),
    context: enumMode(env.FEE_CONTEXT_CLASSIFIER_MODE, WHITEBOX_CONTEXT_MODES, "off"),
    span: enumMode(env.FEE_SPAN_DETECTOR_MODE, WHITEBOX_SPAN_MODES, "off")
  };
}

export function whiteboxThresholds(env = process.env, selector = {}) {
  const configuredPath = String(env.FEE_WHITEBOX_THRESHOLDS_PATH || "").trim();
  if (!configuredPath) {
    return {
      ...DEFAULT_WHITEBOX_THRESHOLDS,
      version: `defaults:${thresholdDigest(DEFAULT_WHITEBOX_THRESHOLDS)}`,
      thresholdCells: ["defaults"]
    };
  }
  const parsed = JSON.parse(readFileSync(configuredPath, "utf8"));
  const selected = selectThresholds(parsed, selector);
  const configuredVersion = String(
    parsed.version || `file:${thresholdDigest(parsed)}`
  );
  return {
    ...selected.thresholds,
    version: [
      configuredVersion,
      `cells=${selected.thresholdCells.join(",")}`,
      thresholdDigest(selected.thresholds)
    ].join(":"),
    thresholdCells: selected.thresholdCells
  };
}

export function isWhiteboxSupportedSetting(setting = "") {
  return WHITEBOX_SUPPORTED_SETTINGS.has(String(setting || "outpatient").trim() || "outpatient");
}

export function whiteboxEncounterSetting(session = {}) {
  if (String(session?.encounterDetails?.visitKind || "").trim() === "telephone_revisit") {
    return "telephone";
  }
  return String(session?.setting || "outpatient").trim() || "outpatient";
}

export function contextRoleFromAxes(axes = {}, threshold = DEFAULT_WHITEBOX_THRESHOLDS.contextConfidence) {
  const normalized = normalizeContextAxes(axes);
  const unknownAxes = Object.entries(normalized)
    .filter(([, axisResult]) => axisResult.value === "unknown")
    .map(([axis]) => axis);
  const result = (value) => ({
    ...value,
    normalizedAxes: normalized,
    unknownAxes
  });
  const uncertainAxes = Object.entries(normalized)
    .filter(([, result]) => result.abstained || result.confidence < threshold)
    .map(([axis]) => axis);
  if (uncertainAxes.length) {
    return result({ role: "llm", reasonCodes: ["context_abstain_or_low_confidence"], uncertainAxes });
  }

  const action = normalized.actionStatus.value;
  const temporal = normalized.temporalRelation.value;
  const source = normalized.sourceOrigin.value;
  const ownership = normalized.providerOwnership.value;
  const standing = normalized.standingStatus.value;

  if (temporal === "same_day_but_unknown") {
    return result({ role: "llm", reasonCodes: ["same_day_but_unknown"], uncertainAxes: [] });
  }
  if (action === "not_performed") {
    return result({ role: "excluded", reasonCodes: ["not_performed"], uncertainAxes: [] });
  }
  if (
    temporal === "past"
    || EXTERNAL_SOURCE_ORIGINS.has(source)
    || EXTERNAL_PROVIDER_OWNERSHIPS.has(ownership)
  ) {
    return result({ role: "excluded", reasonCodes: ["past_or_external_context"], uncertainAxes: [] });
  }
  if (
    temporal === "current_visit"
    && source === "own_clinic_record"
    && ownership === "own_clinic"
    && CURRENT_ACTION_STATUSES.has(action)
  ) {
    return result({
      role: "performed",
      standingStatus: standing,
      reasonCodes: ["current_own_performed"],
      uncertainAxes: []
    });
  }
  if (
    temporal === "current_visit"
    && source === "own_clinic_record"
    && ownership === "own_clinic"
    && ["continued", "changed", "stopped"].includes(standing)
    && !PLAN_ACTION_STATUSES.has(action)
  ) {
    return result({
      role: "standing",
      standingStatus: standing,
      reasonCodes: ["current_own_standing"],
      uncertainAxes: []
    });
  }
  if (temporal === "future" || PLAN_ACTION_STATUSES.has(action)) {
    return result({ role: "plan", reasonCodes: ["future_or_plan"], uncertainAxes: [] });
  }
  return result({ role: "llm", reasonCodes: ["context_unresolved"], uncertainAxes: [] });
}

export function determineWhiteboxVisitFacts({
  lines = [],
  session = {}
} = {}) {
  const structured = structuredPrescriptionFacts(session);
  const observations = [];
  const ambiguousClauseIds = [];
  const ignoredClauseIds = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    for (const clause of splitWhiteboxEvidenceClauses(line)) {
      const text = String(clause.text || "");
      if (!VISIT_FACTS_SENSITIVE_PATTERN.test(text)) {
        continue;
      }
      const cues = clause.cues || {};
      if (cues.pastOrExternal === true || cues.futureOrOrderOnly === true) {
        ignoredClauseIds.push(clause.clauseId);
        continue;
      }
      const outsidePositive = OUTSIDE_PRESCRIPTION_POSITIVE_PATTERN.test(text)
        && !OUTSIDE_PRESCRIPTION_NEGATIVE_PATTERN.test(text);
      const outsideNegative = OUTSIDE_PRESCRIPTION_NEGATIVE_PATTERN.test(text);
      const inHouse = IN_HOUSE_PRESCRIPTION_PATTERN.test(text);
      const genericName = GENERIC_NAME_PRESCRIPTION_PATTERN.test(text);
      if ((outsidePositive && inHouse) || (outsidePositive && outsideNegative)) {
        ambiguousClauseIds.push(clause.clauseId);
        continue;
      }
      if (!outsidePositive && !outsideNegative && !inHouse && !genericName) {
        ambiguousClauseIds.push(clause.clauseId);
        continue;
      }
      observations.push({
        clauseId: clause.clauseId,
        lineId: clause.lineId,
        outside: outsidePositive ? "yes" : (outsideNegative || inHouse ? "no" : "unknown"),
        genericName: genericName ? "yes" : "unknown",
        evidence: text.trim().slice(0, 90)
      });
    }
  }

  const outsideValues = new Set(observations
    .map((entry) => entry.outside)
    .filter((value) => value !== "unknown"));
  const genericValues = new Set(observations
    .map((entry) => entry.genericName)
    .filter((value) => value !== "unknown"));
  if (outsideValues.size > 1 || genericValues.size > 1) {
    ambiguousClauseIds.push(...observations.map((entry) => entry.clauseId));
  }
  const textOutside = outsideValues.size === 1 ? [...outsideValues][0] : "unknown";
  const textGeneric = genericValues.size === 1 ? [...genericValues][0] : "unknown";
  if (
    structured.outside !== "unknown"
    && textOutside !== "unknown"
    && structured.outside !== textOutside
  ) {
    ambiguousClauseIds.push(...observations.map((entry) => entry.clauseId));
  }
  if (
    structured.genericName !== "unknown"
    && textGeneric !== "unknown"
    && structured.genericName !== textGeneric
  ) {
    ambiguousClauseIds.push(...observations.map((entry) => entry.clauseId));
  }
  const uniqueAmbiguousClauses = [...new Set(ambiguousClauseIds.filter(Boolean))];
  const lineIdByClauseId = new Map(
    (Array.isArray(lines) ? lines : []).flatMap((line) => (
      splitWhiteboxEvidenceClauses(line).map((clause) => [clause.clauseId, clause.lineId])
    ))
  );
  const uniqueAmbiguousLines = [...new Set(uniqueAmbiguousClauses
    .map((clauseId) => lineIdByClauseId.get(clauseId))
    .filter(Boolean))];
  const evidence = observations.find((entry) => entry.outside !== "unknown")?.evidence
    || observations.find((entry) => entry.genericName !== "unknown")?.evidence
    || structured.evidence
    || "";
  const facts = {
    outside_prescription_issued: textOutside !== "unknown"
      ? textOutside
      : structured.outside,
    generic_name_prescription: textGeneric !== "unknown"
      ? textGeneric
      : structured.genericName,
    prescription_evidence: evidence
  };
  return {
    status: uniqueAmbiguousClauses.length ? "ambiguous" : "complete",
    facts,
    source: observations.length
      ? (structured.configured ? "structured_and_text" : "deterministic_text")
      : (structured.configured ? "structured_session" : "unknown"),
    evidenceLineIds: observations.map((entry) => entry.lineId).filter(Boolean),
    evidenceClauseIds: observations.map((entry) => entry.clauseId).filter(Boolean),
    ambiguousLineIds: uniqueAmbiguousLines,
    ambiguousClauseIds: uniqueAmbiguousClauses,
    ignoredClauseIds: [...new Set(ignoredClauseIds.filter(Boolean))],
    reasonCodes: uniqueAmbiguousClauses.length
      ? ["visit_facts_sensitive_change"]
      : []
  };
}

function structuredVisitFactResolution({
  span = {},
  clause = null,
  visitFactsPlan = {}
} = {}) {
  if (!clause || whiteboxMentionType(span, { text: clause.text }) !== "medication_act") {
    return null;
  }
  if (
    (visitFactsPlan.ambiguousClauseIds || []).includes(clause.clauseId)
    || (visitFactsPlan.ignoredClauseIds || []).includes(clause.clauseId)
  ) {
    return null;
  }
  const normalized = String(`${span?.text || ""} ${clause.text || ""}`)
    .normalize("NFKC")
    .replace(/\s+/gu, "");
  const factKeys = [];
  const outside = String(visitFactsPlan?.facts?.outside_prescription_issued || "unknown");
  const generic = String(visitFactsPlan?.facts?.generic_name_prescription || "unknown");
  if (
    outside !== "unknown"
    && /(?:院外処方|処方箋|処方せん|院内処方|院内投薬)/u.test(normalized)
  ) {
    factKeys.push("outside_prescription_issued");
  }
  if (generic !== "unknown" && /一般名/u.test(normalized)) {
    factKeys.push("generic_name_prescription");
  }
  if (!factKeys.length) {
    return null;
  }
  return {
    resolution: "structured_visit_fact",
    role: "fact",
    factKeys,
    reasonCodes: ["structured_visit_fact_resolved"]
  };
}

export function contextConsensus({
  classifierRole,
  predicateRole = "unknown"
} = {}) {
  const classifier = String(classifierRole || "llm");
  const predicate = String(predicateRole || "unknown");
  if (predicate === "unknown" || predicate === classifier) {
    return {
      role: classifier,
      disagreement: false,
      reasonCodes: predicate === classifier ? ["classifier_predicate_agree"] : ["classifier_only"]
    };
  }
  if (classifier === "standing" && predicate === "performed") {
    return {
      role: "standing",
      disagreement: false,
      reasonCodes: ["current_visit_predicate_compatible_with_standing"]
    };
  }
  if (classifier === "llm" && predicate === "excluded") {
    return {
      role: "excluded",
      disagreement: true,
      reasonCodes: ["predicate_safe_exclusion"]
    };
  }
  if (classifier === "llm") {
    return { role: "llm", disagreement: false, reasonCodes: ["classifier_requests_llm"] };
  }
  if (["excluded", "plan"].includes(predicate) || classifier === "excluded") {
    return {
      role: "excluded",
      disagreement: true,
      reasonCodes: ["classifier_predicate_disagreement_safe_downgrade"]
    };
  }
  return {
    role: "llm",
    disagreement: true,
    reasonCodes: ["classifier_predicate_disagreement"]
  };
}

export function aggregateLineContext(spanRoles = []) {
  const roles = Array.isArray(spanRoles) ? spanRoles : [];
  if (roles.some((entry) => entry?.role === "llm")) {
    return { role: "llm", reasonCodes: ["llm_owns_whole_line"] };
  }
  if (roles.some((entry) => entry?.role === "performed")) {
    return { role: "performed", reasonCodes: ["performed_span"] };
  }
  if (roles.some((entry) => entry?.role === "standing")) {
    return { role: "standing", reasonCodes: ["standing_span"] };
  }
  if (roles.some((entry) => entry?.role === "plan")) {
    return { role: "plan", reasonCodes: ["plan_span"] };
  }
  if (roles.some((entry) => entry?.role === "fact")) {
    return { role: "fact", reasonCodes: ["structured_visit_fact"] };
  }
  return { role: "none", reasonCodes: ["no_billable_span"] };
}

export async function prepareWhiteboxExtraction({
  feeCalculator,
  preprocessing,
  session = {},
  env = process.env
} = {}) {
  const modes = whiteboxRuntimeModes(env);
  const lines = Array.isArray(preprocessing?.lines) ? preprocessing.lines : [];
  const setting = whiteboxEncounterSetting(session);
  const specialty = whiteboxSpecialty(session);
  const thresholds = safeWhiteboxThresholds(env, {
    specialty,
    encounterSetting: setting
  });
  const thresholdConfigValid = !thresholds.degradedReason;
  const base = {
    modes,
    thresholds,
    status: "off",
    degraded: false,
    extractorVersion: null,
    lineRoutes: [],
    llmLines: lines,
    encoderFacts: emptyEncoderFacts(lines),
    encoderShadowFacts: emptyEncoderFacts(lines),
    metrics: {
      enabled: modes.span !== "off" || modes.context !== "off" || modes.linker !== "off",
      eligible: isWhiteboxSupportedSetting(setting),
      lineCount: lines.length,
      encoderLineCount: 0,
      llmLineCount: lines.length,
      thresholdVersion: thresholds.version,
      thresholdCells: thresholds.thresholdCells,
      specialty,
      encounterSetting: setting,
      degraded: false
    },
    trace: []
  };
  if (!base.metrics.enabled) {
    return base;
  }
  if (!base.metrics.eligible) {
    return {
      ...base,
      status: "ineligible",
      trace: [{ stage: "whitebox_router", outcome: "ineligible_setting", setting }]
    };
  }
  if (modes.span === "off" || typeof feeCalculator?.detectSpans !== "function") {
    return degradedPlan(base, "span_detector_disabled_or_unsupported");
  }

  const spanStartedAt = Date.now();
  const spanEnvelope = await feeCalculator.detectSpans({
    lines: lines.map(({ lineId, text, section }) => ({ lineId, text, section }))
  }).catch((error) => unavailableEnvelope(error));
  const spanDurationMs = Date.now() - spanStartedAt;
  if (spanEnvelope?.status !== "complete") {
    return degradedPlan(base, "span_detector_unavailable", spanEnvelope);
  }
  const spanRows = Array.isArray(spanEnvelope.results) ? spanEnvelope.results : [];
  const spans = spanRows.flatMap((row) => Array.isArray(row?.spans) ? row.spans : []);
  const lineById = new Map(lines.map((line) => [String(line?.lineId || ""), line]));
  const clausesByLineId = new Map(lines.map((line) => [
    String(line?.lineId || ""),
    splitWhiteboxEvidenceClauses(line)
  ]));
  const visitFactsPlan = determineWhiteboxVisitFacts({ lines, session });
  const spanRuntime = spans.map((span) => {
    const line = lineById.get(String(span?.lineId || "")) || {};
    const clause = whiteboxClauseForSpan(
      clausesByLineId.get(String(span?.lineId || "")) || [],
      span
    );
    return {
      sourceSpan: span,
      line,
      clause,
      structuredFact: structuredVisitFactResolution({
        span,
        clause,
        visitFactsPlan
      })
    };
  });
  const linkableRuntime = spanRuntime.filter((entry) => !entry.structuredFact);
  const linkableSpans = linkableRuntime.map((entry) => entry.sourceSpan);

  let linkerEnvelope = {
    status: modes.linker === "off"
      ? "disabled"
      : (linkableSpans.length ? "index_unavailable" : "complete"),
    results: []
  };
  let linkerDurationMs = 0;
  if (
    modes.linker !== "off"
    && linkableSpans.length
    && typeof feeCalculator?.linkSpans === "function"
  ) {
    const linkerStartedAt = Date.now();
    linkerEnvelope = await feeCalculator.linkSpans({
      spans: linkableSpans.map((span) => ({
        lineId: span?.lineId,
        lineText: lineById.get(String(span?.lineId || ""))?.text || "",
        charStart: span?.charStart,
        charEnd: span?.charEnd,
        text: span?.text,
        category: span?.category,
        mentionType: whiteboxMentionType(
          span,
          lineById.get(String(span?.lineId || ""))
        )
      })),
      kinds: ["procedure", "drug", "disease"],
      top_k: 5,
      service_date: session?.serviceDate || ""
    }).catch((error) => unavailableEnvelope(error, "index_unavailable"));
    linkerDurationMs = Date.now() - linkerStartedAt;
  }
  const linkedByIndex = Array.isArray(linkerEnvelope?.results) ? linkerEnvelope.results : [];
  const linkBySourceSpan = new Map(linkableRuntime.map((entry, index) => [
    entry.sourceSpan,
    linkedByIndex[index] || { candidates: [], margin: 0 }
  ]));
  for (const entry of spanRuntime) {
    const link = linkBySourceSpan.get(entry.sourceSpan);
    entry.link = link || { candidates: [], margin: 0 };
    entry.effectiveSpan = entry.structuredFact
      ? entry.sourceSpan
      : resolvedSpanFromLink(entry.sourceSpan, link, entry.line, entry.clause);
    entry.clause = whiteboxClauseForSpan(
      clausesByLineId.get(String(entry.effectiveSpan?.lineId || "")) || [],
      entry.effectiveSpan
    );
  }
  const contextRuntime = spanRuntime.filter((entry) => !entry.structuredFact);

  let contextEnvelope = {
    status: modes.context === "off"
      ? "disabled"
      : (contextRuntime.length ? "model_unavailable" : "complete"),
    results: []
  };
  let contextDurationMs = 0;
  if (
    modes.context !== "off"
    && contextRuntime.length
    && typeof feeCalculator?.classifyContext === "function"
  ) {
    const lineIndex = new Map(lines.map((line, index) => [line.lineId, index]));
    const contextStartedAt = Date.now();
    contextEnvelope = await feeCalculator.classifyContext({
      items: contextRuntime.map((entry) => {
        const span = entry.effectiveSpan;
        const index = lineIndex.get(span.lineId) ?? -1;
        const clause = entry.clause || {
          text: index >= 0 ? lines[index].text : span.text,
          charStart: 0
        };
        return {
          lineId: span.lineId,
          spanId: span.spanId,
          text: clause.text,
          spanText: span.text,
          charStart: Math.max(0, Number(span.charStart || 0) - Number(clause.charStart || 0)),
          charEnd: Math.max(0, Number(span.charEnd || 0) - Number(clause.charStart || 0)),
          previousLine: index > 0 ? lines[index - 1].text : "",
          nextLine: index >= 0 && index + 1 < lines.length ? lines[index + 1].text : "",
          section: index >= 0 ? lines[index].section || "" : "",
          encounterSetting: setting,
          specialty,
          sourceType: "clinical_note"
        };
      })
    }).catch((error) => unavailableEnvelope(error));
    contextDurationMs = Date.now() - contextStartedAt;
  }

  const shadowStackAvailable = thresholdConfigValid
    && modes.linker !== "off"
    && modes.context !== "off"
    && linkerEnvelope?.status === "complete"
    && contextEnvelope?.status === "complete";
  const canRoute = shadowStackAvailable
    && modes.span === "route"
    && modes.linker === "propose"
    && modes.context === "assist";
  const diagnosticShadowMode = shadowStackAvailable
    && modes.span === "shadow"
    && modes.linker === "shadow"
    && modes.context === "shadow";
  const fullLlmRequired = visitFactsPlan.status !== "complete";
  const visitFactsBlockedClauseIds = new Set(visitFactsPlan.ambiguousClauseIds || []);
  const visitFactsEvidenceClauseIds = new Set(visitFactsPlan.evidenceClauseIds || []);
  const visitFactsIgnoredClauseIds = new Set(visitFactsPlan.ignoredClauseIds || []);
  const extractorVersion = whiteboxExtractorVersion({
    spanEnvelope,
    linkerEnvelope,
    contextEnvelope,
    thresholds,
    env
  });
  const contextBySpanId = new Map((Array.isArray(contextEnvelope?.results) ? contextEnvelope.results : [])
    .map((entry) => [String(entry?.spanId || ""), entry]));
  const runtimeBySourceSpan = new Map(spanRuntime.map((entry) => [
    entry.sourceSpan,
    entry
  ]));
  const lineRoutes = [];
  let contextDisagreementCount = 0;
  let contextOverrideCount = 0;
  const contextDisagreementAxes = new Set();
  let contextAbstainSpanCount = 0;
  const contextUncertainAxisCounts = {};
  const gateDiagnostics = [];

  for (const line of lines) {
    const spanRow = spanRows.find((row) => String(row?.lineId || "") === String(line.lineId)) || {
      relevance: "abstain",
      spans: []
    };
    const lineSpans = Array.isArray(spanRow.spans) ? spanRow.spans : [];
    const evaluatedSpans = [];
    for (const detectedSpan of lineSpans) {
      const runtime = runtimeBySourceSpan.get(detectedSpan) || {
        sourceSpan: detectedSpan,
        effectiveSpan: detectedSpan,
        link: { candidates: [], margin: 0 },
        clause: whiteboxClauseForSpan(
          clausesByLineId.get(String(line.lineId || "")) || [],
          detectedSpan
        ),
        structuredFact: null
      };
      const link = runtime.link || { candidates: [], margin: 0 };
      const span = runtime.effectiveSpan || detectedSpan;
      const clause = runtime.clause || whiteboxClauseForSpan(
        clausesByLineId.get(String(line.lineId || "")) || [],
        span
      );
      const structuredFact = runtime.structuredFact;
      const context = contextBySpanId.get(String(span.spanId || "")) || null;
      const topCandidate = Array.isArray(link.candidates) ? link.candidates[0] : null;
      const contextRole = structuredFact
        ? {
            role: "fact",
            reasonCodes: structuredFact.reasonCodes,
            uncertainAxes: [],
            unknownAxes: [],
            normalizedAxes: {}
          }
        : (
            context
              ? contextRoleFromAxes(context.axes, thresholds.contextConfidence)
              : { role: "llm", reasonCodes: ["context_missing"] }
          );
      if (contextRole.uncertainAxes?.length) {
        contextAbstainSpanCount += 1;
        for (const axis of contextRole.uncertainAxes) {
          contextUncertainAxisCounts[axis] = Number(
            contextUncertainAxisCounts[axis] || 0
          ) + 1;
        }
      }
      const predicateContext = structuredFact
        ? { role: "fact", axes: [] }
        : predicateContextForLine(clause || line);
      const consensus = structuredFact
        ? {
            role: "fact",
            disagreement: false,
            reasonCodes: structuredFact.reasonCodes
          }
        : contextConsensus({
            classifierRole: contextRole.role,
            predicateRole: predicateContext.role
          });
      if (consensus.disagreement) {
        contextDisagreementCount += 1;
        predicateContext.axes.forEach((axis) => contextDisagreementAxes.add(axis));
      }
      if (
        consensus.reasonCodes.includes("classifier_only")
        && contextRole.role !== "llm"
      ) {
        contextOverrideCount += 1;
      }
      const shadowLink = rankLinkForShadow(span, link);
      const shadowTopCandidate = shadowLink.candidates[0] || null;
      const strictLinkerGates = structuredFact
        ? structuredVisitFactLinkerGates()
        : linkerGateEvaluation({
            candidate: topCandidate,
            margin: link.margin,
            familyMargin: link.familyMargin,
            familyMemberCount: link.topFamilyMemberCount,
            familyReviewable: link.topFamilyReviewable,
            scoreThreshold: thresholds.linkerHighScore,
            marginThreshold: thresholds.linkerMargin
          });
      const shadowLinkerGates = structuredFact
        ? structuredVisitFactLinkerGates()
        : linkerGateEvaluation({
            candidate: shadowTopCandidate,
            margin: shadowLink.margin,
            familyMargin: shadowLink.familyMargin,
            familyMemberCount: shadowLink.topFamilyMemberCount,
            familyReviewable: shadowLink.topFamilyReviewable,
            scoreThreshold: thresholds.linkerShadowScore,
            marginThreshold: thresholds.linkerShadowMargin,
            allowExactMargin: true
          });
      const spanConfidence = Number(span.confidence);
      const artifactDetectionThreshold = finiteProbabilityOrNull(
        span.detectionThreshold
      );
      const shadowSpanThreshold = Math.max(
        artifactDetectionThreshold ?? 0,
        thresholds.spanShadowConfidence
      );
      const strictSpanPass = structuredFact
        || spanConfidence >= thresholds.spanConfidence;
      const shadowSpanPass = structuredFact
        || spanConfidence >= shadowSpanThreshold;
      const strictRole = structuredFact
        ? "fact"
        : (
            strictSpanPass && strictLinkerGates.passed
              ? consensus.role
              : "llm"
          );
      const shadowRole = structuredFact
        ? "fact"
        : (
            shadowSpanPass && shadowLinkerGates.passed
              ? consensus.role
              : "llm"
          );
      const useDiagnosticShadow = diagnosticShadowMode;
      const selectedLink = useDiagnosticShadow
        ? shadowLink
        : { ...link, candidates: Array.isArray(link.candidates) ? link.candidates : [] };
      const selectedTopCandidate = useDiagnosticShadow
        ? shadowTopCandidate
        : topCandidate;
      const role = useDiagnosticShadow ? shadowRole : strictRole;
      const strictReasonCodes = structuredFact
        ? structuredFact.reasonCodes
        : spanGateReasonCodes({
            spanPass: strictSpanPass,
            linkerGates: strictLinkerGates,
            contextRole,
            consensus
          });
      const shadowReasonCodes = structuredFact
        ? structuredFact.reasonCodes
        : spanGateReasonCodes({
            spanPass: shadowSpanPass,
            linkerGates: shadowLinkerGates,
            contextRole,
            consensus
          });
      const evaluated = {
        ...span,
        clauseId: String(clause?.clauseId || ""),
        clause,
        structuredFact,
        role,
        strictRole,
        shadowRole,
        contextRole,
        consensus,
        link: { ...selectedLink, indexVersion: linkerEnvelope.indexVersion || null },
        strictLink: { ...link, indexVersion: linkerEnvelope.indexVersion || null },
        shadowLink: { ...shadowLink, indexVersion: linkerEnvelope.indexVersion || null },
        topCandidate: selectedTopCandidate,
        strictTopCandidate: topCandidate,
        shadowTopCandidate,
        strictReasonCodes,
        shadowReasonCodes,
        reasonCodes: useDiagnosticShadow ? shadowReasonCodes : strictReasonCodes
      };
      evaluatedSpans.push(evaluated);
      gateDiagnostics.push(spanGateDiagnostic({
        line,
        span,
        clause,
        structuredFact,
        contextRole,
        predicateContext,
        consensus,
        artifactDetectionThreshold,
        strictSpanThreshold: thresholds.spanConfidence,
        shadowSpanThreshold,
        strictSpanPass,
        shadowSpanPass,
        strictLink: link,
        shadowLink,
        strictLinkerGates,
        shadowLinkerGates,
        strictLinkerScoreThreshold: thresholds.linkerHighScore,
        strictLinkerMarginThreshold: thresholds.linkerMargin,
        shadowLinkerScoreThreshold: thresholds.linkerShadowScore,
        shadowLinkerMarginThreshold: thresholds.linkerShadowMargin,
        strictRole,
        shadowRole,
        strictReasonCodes,
        shadowReasonCodes
      }));
    }
    const clauses = clausesByLineId.get(String(line.lineId || "")) || [];
    const strictPlan = planWhiteboxLineClauses({
      line,
      clauses,
      evaluatedSpans,
      spanRow,
      roleField: "strictRole",
      thresholds,
      visitFactsBlockedClauseIds,
      visitFactsEvidenceClauseIds,
      visitFactsIgnoredClauseIds
    });
    const diagnosticPlan = planWhiteboxLineClauses({
      line,
      clauses,
      evaluatedSpans,
      spanRow,
      roleField: "shadowRole",
      thresholds,
      visitFactsBlockedClauseIds,
      visitFactsEvidenceClauseIds,
      visitFactsIgnoredClauseIds
    });
    const shadowPlan = diagnosticShadowMode ? diagnosticPlan : strictPlan;
    const route = canRoute ? strictPlan.route : "llm";
    const shadowRoute = shadowPlan.route;
    const selectedPlan = diagnosticShadowMode ? shadowPlan : strictPlan;
    lineRoutes.push({
      lineId: line.lineId,
      route,
      shadowRoute,
      lineRole: selectedPlan.lineRole,
      strictLineRole: strictPlan.lineRole,
      shadowLineRole: shadowPlan.lineRole,
      reasonCodes: selectedPlan.reasonCodes,
      strictReasonCodes: strictPlan.reasonCodes,
      shadowReasonCodes: shadowPlan.reasonCodes,
      shadowVisitFactsBlocked: shadowPlan.blockedClauseIds.length > 0,
      strictPlan,
      shadowPlan,
      spans: evaluatedSpans
    });
  }

  const strictEncoderFacts = encoderFactsFromLineRoutes({
    lines,
    lineRoutes,
    lane: "strict"
  });
  const shadowEncoderFacts = encoderFactsFromLineRoutes({
    lines,
    lineRoutes,
    lane: "shadow"
  });
  strictEncoderFacts.visit_facts = visitFactsPlan.facts;
  shadowEncoderFacts.visit_facts = visitFactsPlan.facts;
  const llmLines = residualLlmLines(lines, lineRoutes, "strictPlan");
  const shadowLlmLines = residualLlmLines(lines, lineRoutes, "shadowPlan");
  const shadowEncoderLineCount = lineRoutes.filter(
    (line) => line.shadowRoute === "encoder"
  ).length;
  const shadowPartialEncoderLineCount = lineRoutes.filter(
    (line) => line.shadowRoute === "mixed"
  ).length;
  const spanBearingLineCount = lineRoutes.filter(
    (line) => Array.isArray(line.spans) && line.spans.length > 0
  ).length;
  const shadowEncoderSpanBearingLineCount = lineRoutes.filter(
    (line) => (
      ["encoder", "mixed"].includes(line.shadowRoute)
      && Array.isArray(line.spans)
      && line.spans.length > 0
    )
  ).length;
  const contextConfidenceByAxis = {};
  for (const result of Array.isArray(contextEnvelope?.results) ? contextEnvelope.results : []) {
    for (const [axis, value] of Object.entries(result?.axes || {})) {
      if (!contextConfidenceByAxis[axis]) {
        contextConfidenceByAxis[axis] = [];
      }
      contextConfidenceByAxis[axis].push(Number(value?.confidence));
    }
  }
  const confidenceSummary = {
    span: summarizeMetricValues(spans.map((span) => Number(span?.confidence))),
    linkerTopScore: summarizeMetricValues(linkedByIndex.map(
      (link) => Number(link?.candidates?.[0]?.score)
    )),
    linkerMargin: summarizeMetricValues(linkedByIndex.map(
      (link) => Number(link?.margin)
    )),
    contextAxes: Object.fromEntries(
      Object.entries(contextConfidenceByAxis)
        .sort(([left], [right]) => left.localeCompare(right))
      .map(([axis, values]) => [axis, summarizeMetricValues(values)])
    )
  };
  const strictGateFunnel = summarizeSpanGateDiagnostics(
    gateDiagnostics,
    "strict"
  );
  const shadowGateFunnel = summarizeSpanGateDiagnostics(
    gateDiagnostics,
    "shadow"
  );
  const degraded = !shadowStackAvailable;
  const routeReady = canRoute;
  const strictClauseCounts = summarizeClauseRoutes(lineRoutes, "strictPlan");
  const shadowClauseCounts = summarizeClauseRoutes(lineRoutes, "shadowPlan");
  const shadowEncoderOwnedSpanCount = countEncoderOwnedSpans(
    lineRoutes,
    "shadowPlan"
  );
  const strictEncoderOwnedSpanCount = countEncoderOwnedSpans(
    lineRoutes,
    "strictPlan"
  );
  const shadowVisitFactsBlockedLineIds = new Set(lineRoutes
    .filter((line) => line.shadowPlan.blockedClauseIds.length > 0)
    .map((line) => String(line.lineId || "")));
  return {
    ...base,
    status: routeReady ? "route_ready" : "shadow",
    degraded,
    extractorVersion,
    lineRoutes,
    llmLines: routeReady ? llmLines : lines,
    encoderFacts: routeReady ? strictEncoderFacts : emptyEncoderFacts(lines),
    encoderShadowFacts: shadowEncoderFacts,
    metrics: {
      ...base.metrics,
      mode: routeReady ? "route" : "shadow",
      degraded,
      degradedReasons: [
        ...(thresholdConfigValid ? [] : ["threshold_config_invalid"]),
        ...(linkerEnvelope?.status !== "complete" ? ["linker_unavailable"] : []),
        ...(contextEnvelope?.status !== "complete" ? ["context_classifier_unavailable"] : [])
      ],
      safetyFallbackReasons: fullLlmRequired
        ? ["visit_facts_sensitive_change"]
        : [],
      shadowEvaluationPolicy: diagnosticShadowMode
        ? "artifact_calibrated_diagnostic"
        : "promotion_strict",
      spanCount: spans.length,
      spanDetectorDurationMs: spanDurationMs,
      linkerDurationMs,
      contextClassifierDurationMs: contextDurationMs,
      confidenceSummary,
      contextDisagreementCount,
      contextDisagreementAxes: [...contextDisagreementAxes].sort(),
      contextClassifier: {
        calls: contextEnvelope?.status === "complete" && spans.length ? 1 : 0,
        evaluatedSpans: Array.isArray(contextEnvelope?.results)
          ? contextEnvelope.results.length
          : 0,
        overrides: contextOverrideCount,
        disagreements: contextDisagreementCount,
        disagreementAxes: [...contextDisagreementAxes].sort(),
        abstainedSpans: contextAbstainSpanCount,
        uncertainAxisCounts: Object.fromEntries(
          Object.entries(contextUncertainAxisCounts)
            .sort(([left], [right]) => left.localeCompare(right))
        ),
        modelVersion: contextEnvelope.modelVersion || null,
        status: contextEnvelope.status
      },
      visitFacts: {
        status: visitFactsPlan.status,
        source: visitFactsPlan.source,
        evidenceLineCount: visitFactsPlan.evidenceLineIds.length,
        evidenceClauseCount: visitFactsPlan.evidenceClauseIds.length,
        ambiguousLineCount: visitFactsPlan.ambiguousLineIds.length,
        ambiguousClauseCount: visitFactsPlan.ambiguousClauseIds.length,
        fullLlmRequired,
        scopedFallback: true,
        shadowScopedFallback: diagnosticShadowMode && fullLlmRequired,
        shadowBlockedLineCount: shadowVisitFactsBlockedLineIds.size,
        shadowBlockedClauseCount: shadowClauseCounts.blocked
      },
      gateFunnel: {
        strict: strictGateFunnel,
        shadow: shadowGateFunnel
      },
      shadowEncoderLineCount,
      shadowPartialEncoderLineCount,
      shadowRoutableLineRatio: lines.length
        ? (shadowEncoderLineCount + shadowPartialEncoderLineCount) / lines.length
        : 0,
      spanBearingLineCount,
      shadowEncoderSpanBearingLineCount,
      spanBearingRoutableLineRatio: spanBearingLineCount
        ? shadowEncoderSpanBearingLineCount / spanBearingLineCount
        : 0,
      routeReasonCounts: countRouteReasons(lineRoutes),
      strictRouteReasonCounts: countRouteReasons(lineRoutes, "strictReasonCodes"),
      shadowRouteReasonCounts: countRouteReasons(lineRoutes, "shadowReasonCodes"),
      encoderLineCount: routeReady
        ? lineRoutes.filter((line) => line.route === "encoder").length
        : 0,
      partialEncoderLineCount: routeReady
        ? lineRoutes.filter((line) => line.route === "mixed").length
        : 0,
      encoderOwnedSpanCount: routeReady ? strictEncoderOwnedSpanCount : 0,
      shadowEncoderOwnedSpanCount,
      clauseRoutes: {
        strict: strictClauseCounts,
        shadow: shadowClauseCounts
      },
      llmLineCount: routeReady ? llmLines.length : lines.length,
      expectedLlmLineRatio: lines.length
        ? (routeReady ? llmLines.length : lines.length) / lines.length
        : 0,
      expectedLlmClauseRatio: routeReady && strictClauseCounts.total
        ? strictClauseCounts.llm / strictClauseCounts.total
        : (
            shadowClauseCounts.total
              ? shadowClauseCounts.llm / shadowClauseCounts.total
              : 0
          ),
      shadowExpectedLlmClauseRatio: shadowClauseCounts.total
        ? shadowClauseCounts.llm / shadowClauseCounts.total
        : 0,
      spanDetectorVersion: spanEnvelope.extractorVersion || spanEnvelope.modelVersion || null,
      spanDetectorArtifactVersion: spanEnvelope.artifactVersion || null,
      linkerIndexVersion: linkerEnvelope.indexVersion || null,
      linkerArtifactVersion: linkerEnvelope.artifactVersion || null,
      contextClassifierVersion: contextEnvelope.modelVersion || null,
      contextClassifierArtifactVersion: contextEnvelope.artifactVersion || null,
      extractorVersion
    },
    trace: [{
      stage: "whitebox_router",
      outcome: routeReady ? "routed" : "shadow_only",
      spanDetectorStatus: spanEnvelope.status,
      linkerStatus: linkerEnvelope.status,
      contextClassifierStatus: contextEnvelope.status,
      contextClassifierCalls: contextEnvelope?.status === "complete" && spans.length ? 1 : 0,
      contextClassifierOverrides: contextOverrideCount,
      contextClassifierDisagreements: contextDisagreementCount,
      encoderLineIds: lineRoutes
        .filter((line) => ["encoder", "mixed"].includes(line.route))
        .map((line) => line.lineId),
      shadowEncoderLineIds: lineRoutes
        .filter((line) => ["encoder", "mixed"].includes(line.shadowRoute))
        .map((line) => line.lineId),
      llmLineIds: (routeReady ? llmLines : lines).map((line) => line.lineId),
      llmClauseIds: routeReady
        ? lineRoutes.flatMap((line) => line.strictPlan.llmClauseIds)
        : lineRoutes.flatMap((line) => line.strictPlan.clauses.map((clause) => clause.clauseId)),
      shadowLlmClauseIds: lineRoutes.flatMap((line) => line.shadowPlan.llmClauseIds),
      shadowResidualLlmLineIds: shadowLlmLines.map((line) => line.lineId),
      extractorVersion,
      visitFactsStatus: visitFactsPlan.status,
      visitFactsSource: visitFactsPlan.source,
      visitFactsAmbiguousLineIds: visitFactsPlan.ambiguousLineIds,
      visitFactsAmbiguousClauseIds: visitFactsPlan.ambiguousClauseIds,
      shadowVisitFactsBlockedLineIds: [...shadowVisitFactsBlockedLineIds].sort(),
      shadowEvaluationPolicy: diagnosticShadowMode
        ? "artifact_calibrated_diagnostic"
        : "promotion_strict",
      gateDiagnostics
    }]
  };
}

export function whiteboxMentionType(span = {}) {
  const category = String(span?.category || "").normalize("NFKC").trim().toLowerCase();
  if (["diagnosis", "disease"].includes(category)) {
    return "diagnosis";
  }
  if (!["medication", "drug"].includes(category)) {
    return "procedure_act";
  }
  const spanText = String(span?.text || "").normalize("NFKC");
  if (MEDICATION_BILLING_ACT_PATTERN.test(spanText)) {
    return "medication_act";
  }
  if (DRUG_PRODUCT_PATTERN.test(spanText)) {
    return "drug_product";
  }
  return "unspecified";
}

function planWhiteboxLineClauses({
  line = {},
  clauses = [],
  evaluatedSpans = [],
  spanRow = {},
  roleField = "strictRole",
  thresholds = DEFAULT_WHITEBOX_THRESHOLDS,
  visitFactsBlockedClauseIds = new Set(),
  visitFactsEvidenceClauseIds = new Set(),
  visitFactsIgnoredClauseIds = new Set()
} = {}) {
  const normalizedClauses = clauses.length
    ? clauses
    : [{
        clauseId: `${String(line?.lineId || "L")}:C001`,
        lineId: String(line?.lineId || ""),
        text: String(line?.text || ""),
        charStart: 0,
        charEnd: String(line?.text || "").length,
        cues: clinicalServiceContextCues(line?.text)
      }];
  const confidentlyIrrelevant = spanRow?.relevance === "irrelevant"
    && Number(spanRow?.relevanceConfidence) >= thresholds.relevanceConfidence;
  const clausePlans = normalizedClauses.map((clause) => {
    const clauseSpans = evaluatedSpans.filter(
      (span) => String(span?.clauseId || "") === String(clause.clauseId || "")
    );
    let aggregate;
    let blocked = false;
    if (visitFactsBlockedClauseIds.has(clause.clauseId)) {
      aggregate = {
        role: "llm",
        reasonCodes: ["visit_facts_sensitive_change"]
      };
      blocked = true;
    } else if (clauseSpans.length) {
      aggregate = aggregateLineContext(clauseSpans.map((span) => ({
        ...span,
        role: span?.[roleField] || "llm"
      })));
    } else if (visitFactsEvidenceClauseIds.has(clause.clauseId)) {
      aggregate = {
        role: "fact",
        reasonCodes: ["structured_visit_fact"]
      };
    } else if (visitFactsIgnoredClauseIds.has(clause.clauseId)) {
      aggregate = {
        role: "none",
        reasonCodes: ["ignored_noncurrent_visit_fact_clause"]
      };
    } else {
      const trivial = isTrivialClinicalLine(clause.text);
      aggregate = trivial || confidentlyIrrelevant
        ? {
            role: "none",
            reasonCodes: [trivial ? "trivial_line" : "relevance_irrelevant"]
          }
        : {
            role: "llm",
            reasonCodes: ["span_missing_nontrivial_line"]
          };
    }
    return {
      ...clause,
      route: aggregate.role === "llm" ? "llm" : "encoder",
      role: aggregate.role,
      reasonCodes: [...new Set(aggregate.reasonCodes || [])],
      blocked,
      spanIds: clauseSpans.map((span) => String(span?.spanId || "")).filter(Boolean)
    };
  });
  const llmClauses = clausePlans.filter((clause) => clause.route === "llm");
  const encoderClauses = clausePlans.filter((clause) => clause.route === "encoder");
  const route = llmClauses.length === 0
    ? "encoder"
    : (encoderClauses.length === 0 ? "llm" : "mixed");
  return {
    route,
    lineRole: strongestWhiteboxClauseRole(encoderClauses.map((clause) => clause.role)),
    reasonCodes: [...new Set(clausePlans.flatMap((clause) => clause.reasonCodes))],
    clauses: clausePlans,
    encoderClauseIds: encoderClauses.map((clause) => clause.clauseId),
    llmClauseIds: llmClauses.map((clause) => clause.clauseId),
    blockedClauseIds: clausePlans
      .filter((clause) => clause.blocked)
      .map((clause) => clause.clauseId)
  };
}

function strongestWhiteboxClauseRole(roles = []) {
  const priority = {
    llm: 0,
    none: 1,
    excluded: 2,
    fact: 3,
    plan: 4,
    standing: 5,
    performed: 6
  };
  return (Array.isArray(roles) ? roles : []).reduce((selected, role) => (
    Number(priority[role] || 0) > Number(priority[selected] || 0)
      ? role
      : selected
  ), roles.length ? "none" : "llm");
}

function encoderFactsFromLineRoutes({
  lines = [],
  lineRoutes = [],
  lane = "strict"
} = {}) {
  const planField = lane === "shadow" ? "shadowPlan" : "strictPlan";
  const roleField = lane === "shadow" ? "shadowRole" : "strictRole";
  const topCandidateField = lane === "shadow"
    ? "shadowTopCandidate"
    : "strictTopCandidate";
  const linkField = lane === "shadow" ? "shadowLink" : "strictLink";
  const lineById = new Map((Array.isArray(lines) ? lines : []).map((line) => [
    String(line?.lineId || ""),
    line
  ]));
  const facts = emptyEncoderFacts([]);
  facts.line_review = [];
  for (const route of Array.isArray(lineRoutes) ? lineRoutes : []) {
    const plan = route?.[planField];
    if (!plan || !["encoder", "mixed"].includes(plan.route)) {
      continue;
    }
    const line = lineById.get(String(route?.lineId || "")) || {};
    const clauseById = new Map(plan.clauses.map((clause) => [
      String(clause.clauseId || ""),
      clause
    ]));
    facts.line_review.push({
      line_id: route.lineId,
      line_role: lineRoleForContract(plan.lineRole)
    });
    for (const span of Array.isArray(route?.spans) ? route.spans : []) {
      const clausePlan = clauseById.get(String(span?.clauseId || ""));
      if (clausePlan?.route !== "encoder") {
        continue;
      }
      const role = span?.[roleField] || "llm";
      const evaluated = {
        ...span,
        role,
        topCandidate: span?.[topCandidateField] || null,
        link: span?.[linkField] || {}
      };
      if (role === "performed" && evaluated.topCandidate) {
        facts.clinical_events.push(encoderEventFromSpan(evaluated, line));
      }
      if (role === "excluded" && evaluated.topCandidate) {
        facts.excluded_events.push(encoderExcludedEventFromSpan(evaluated, line));
      }
      const standingStatus = evaluated.contextRole?.standingStatus;
      if (
        clausePlan.role === "standing"
        && role === "standing"
        && ["continued", "changed", "stopped"].includes(standingStatus)
      ) {
        facts.standing_mentions.push({
          line_id: line.lineId,
          target: evaluated.topCandidate?.name || evaluated.text,
          status: standingStatus,
          source: "encoder"
        });
      }
    }
  }
  return facts;
}

function residualLlmLines(lines = [], lineRoutes = [], planField = "strictPlan") {
  const routeByLineId = new Map((Array.isArray(lineRoutes) ? lineRoutes : []).map(
    (route) => [String(route?.lineId || ""), route]
  ));
  return (Array.isArray(lines) ? lines : []).flatMap((line) => {
    const route = routeByLineId.get(String(line?.lineId || ""));
    const plan = route?.[planField];
    if (!plan?.llmClauseIds?.length) {
      return [];
    }
    const llmClauseIds = new Set(plan.llmClauseIds);
    const text = plan.clauses
      .filter((clause) => llmClauseIds.has(clause.clauseId))
      .map((clause) => String(clause.text || ""))
      .join(" ")
      .trim();
    return [{
      ...line,
      text,
      normalizedText: text.normalize("NFKC"),
      cues: {
        ...clinicalServiceContextCues(text),
        syntheticMeta: line?.cues?.syntheticMeta === true
      }
    }];
  });
}

function summarizeClauseRoutes(lineRoutes = [], planField = "strictPlan") {
  const clauses = (Array.isArray(lineRoutes) ? lineRoutes : [])
    .flatMap((route) => route?.[planField]?.clauses || []);
  return {
    total: clauses.length,
    encoder: clauses.filter((clause) => clause.route === "encoder").length,
    llm: clauses.filter((clause) => clause.route === "llm").length,
    blocked: clauses.filter((clause) => clause.blocked === true).length,
    structuredFact: clauses.filter((clause) => clause.role === "fact").length
  };
}

function countEncoderOwnedSpans(lineRoutes = [], planField = "strictPlan") {
  return (Array.isArray(lineRoutes) ? lineRoutes : []).reduce((total, route) => {
    const plan = route?.[planField];
    if (!plan) {
      return total;
    }
    const encoderClauseIds = new Set(plan.encoderClauseIds || []);
    return total + (Array.isArray(route?.spans) ? route.spans : [])
      .filter((span) => encoderClauseIds.has(String(span?.clauseId || "")))
      .length;
  }, 0);
}

function countRouteReasons(lineRoutes = [], field = "reasonCodes") {
  const counts = {};
  for (const line of Array.isArray(lineRoutes) ? lineRoutes : []) {
    for (const rawReason of Array.isArray(line?.[field]) ? line[field] : []) {
      const reason = String(rawReason || "").trim();
      if (!reason) {
        continue;
      }
      counts[reason] = Number(counts[reason] || 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function rankLinkForShadow(span = {}, link = {}) {
  const candidates = (Array.isArray(link?.candidates) ? link.candidates : [])
    .map((candidate, index) => ({
      ...candidate,
      semanticRank: index + 1,
      shadowLexicalMatch: linkerLexicalMatch(span?.text, candidate)
    }))
    .sort((left, right) => {
      const leftExact = left.shadowLexicalMatch === "exact" ? 0 : 1;
      const rightExact = right.shadowLexicalMatch === "exact" ? 0 : 1;
      return leftExact - rightExact
        || Number(left.semanticRank || 0) - Number(right.semanticRank || 0);
    })
    .map((candidate, index) => ({
      ...candidate,
      shadowRank: index + 1
    }));
  const margin = candidates.length >= 2
    ? Math.max(0, Number(candidates[0]?.score || 0) - Number(candidates[1]?.score || 0))
    : Number(candidates[0]?.score || 0);
  const family = linkerFamilyView(link, candidates[0], candidates);
  return {
    ...link,
    candidates,
    margin: Number(margin.toFixed(6)),
    ...family
  };
}

function linkerFamilyView(link = {}, candidate = null, candidates = []) {
  const familyKey = String(candidate?.familyKey || "");
  if (!familyKey) {
    return {
      familyMargin: 0,
      topFamilyKey: null,
      topFamilyMemberCount: 0,
      topFamilyReviewable: false,
      topFamilyMembers: []
    };
  }
  const summary = (Array.isArray(link?.families) ? link.families : [])
    .find((entry) => String(entry?.familyKey || "") === familyKey);
  const outsideFamily = (Array.isArray(candidates) ? candidates : [])
    .find((entry) => String(entry?.familyKey || "") !== familyKey);
  const familyMargin = outsideFamily
    ? Math.max(0, Number(candidate?.score || 0) - Number(outsideFamily?.score || 0))
    : Number(candidate?.score || 0);
  const memberCount = Number(
    summary?.memberCount
    ?? candidate?.familyMemberCount
    ?? (familyKey === String(link?.topFamilyKey || "")
      ? link?.topFamilyMemberCount
      : 0)
  );
  const reviewable = summary?.reviewable === true
    || (
      Number.isInteger(memberCount)
      && memberCount > 1
      && memberCount <= MAX_REVIEWABLE_LINKER_FAMILY_SIZE
    );
  const members = Array.isArray(summary?.members)
    ? summary.members
    : (
      familyKey === String(link?.topFamilyKey || "")
        ? link?.topFamilyMembers
        : []
    );
  return {
    familyMargin: Number(familyMargin.toFixed(6)),
    topFamilyKey: familyKey,
    topFamilyMemberCount: Number.isFinite(memberCount) ? memberCount : 0,
    topFamilyReviewable: reviewable,
    topFamilyMembers: reviewable && Array.isArray(members) ? members : []
  };
}

function linkerLexicalMatch(spanText = "", candidate = {}) {
  const query = normalizedLinkerLexeme(spanText);
  if (!query) {
    return "none";
  }
  const values = [
    candidate?.name,
    ...String(candidate?.matchedDoc || "").split("/")
  ].map(normalizedLinkerLexeme).filter(Boolean);
  if (values.includes(query)) {
    return "exact";
  }
  if (
    query.length >= 3
    && values.some((value) => value.startsWith(query) || query.startsWith(value))
  ) {
    return "prefix";
  }
  return "none";
}

function normalizedLinkerLexeme(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000・,，.。/／()（）「」『』【】［］\[\]'"’‘“”:：;；_-]+/gu, "");
}

function linkerGateEvaluation({
  candidate = null,
  margin = 0,
  familyMargin = 0,
  familyMemberCount = 0,
  familyReviewable = false,
  scoreThreshold = 0,
  marginThreshold = 0,
  allowExactMargin = false
} = {}) {
  const candidatePresent = Boolean(candidate);
  const scorePass = candidatePresent
    && Number(candidate.score) >= Number(scoreThreshold);
  const categoryPass = candidatePresent && candidate.categoryMatched === true;
  const mentionTypePass = candidatePresent
    && candidate.mentionTypeMatched !== false;
  const marginPass = Number(margin) >= Number(marginThreshold);
  const exactMarginBypass = allowExactMargin
    && candidate?.shadowLexicalMatch === "exact"
    && Number(familyMemberCount || 0) <= 1;
  const familyMarginPass = Number(familyMargin) >= Number(marginThreshold);
  const basePass = candidatePresent
    && scorePass
    && categoryPass
    && mentionTypePass;
  const exactCodeResolved = basePass && (marginPass || exactMarginBypass);
  const familyTooBroad = Number(familyMemberCount) > MAX_REVIEWABLE_LINKER_FAMILY_SIZE;
  const familyIdentified = basePass
    && !exactCodeResolved
    && familyMarginPass
    && familyReviewable === true
    && Number(familyMemberCount) > 1
    && !familyTooBroad;
  return {
    candidatePresent,
    scorePass,
    categoryPass,
    mentionTypePass,
    marginPass,
    exactMarginBypass,
    familyMarginPass,
    familyMemberCount: Number(familyMemberCount || 0),
    familyReviewable: familyReviewable === true,
    familyTooBroad,
    familyIdentified,
    resolution: exactCodeResolved
      ? "exact_code"
      : (familyIdentified ? "family_only" : "unresolved"),
    passed: exactCodeResolved
  };
}

function structuredVisitFactLinkerGates() {
  return {
    candidatePresent: false,
    scorePass: false,
    categoryPass: true,
    mentionTypePass: true,
    marginPass: false,
    exactMarginBypass: false,
    familyMarginPass: false,
    familyMemberCount: 0,
    familyReviewable: false,
    familyTooBroad: false,
    familyIdentified: false,
    linkerBypassed: true,
    resolution: "structured_visit_fact",
    passed: true
  };
}

function spanGateReasonCodes({
  spanPass = false,
  linkerGates = {},
  contextRole = {},
  consensus = {}
} = {}) {
  return [
    ...(spanPass ? [] : ["span_low_confidence"]),
    ...(linkerGates.candidatePresent ? [] : ["linker_candidate_missing"]),
    ...(linkerGates.candidatePresent && !linkerGates.scorePass
      ? ["linker_low_score"]
      : []),
    ...(linkerGates.candidatePresent
      && !linkerGates.marginPass
      && !linkerGates.exactMarginBypass
      && !linkerGates.familyIdentified
      ? ["linker_low_margin"]
      : []),
    ...(linkerGates.familyIdentified ? ["linker_family_identified"] : []),
    ...(linkerGates.familyTooBroad && !linkerGates.passed
      ? ["linker_family_too_broad"]
      : []),
    ...(linkerGates.candidatePresent
      && !linkerGates.marginPass
      && !linkerGates.exactMarginBypass
      && !linkerGates.familyMarginPass
      && Number(linkerGates.familyMemberCount || 0) > 1
      ? ["linker_family_low_margin"]
      : []),
    ...(linkerGates.candidatePresent && !linkerGates.categoryPass
      ? ["linker_category_mismatch"]
      : []),
    ...(linkerGates.candidatePresent && !linkerGates.mentionTypePass
      ? ["linker_mention_type_mismatch"]
      : []),
    ...(consensus.role === "llm" ? ["context_unresolved"] : []),
    ...new Set(Array.isArray(contextRole.reasonCodes) ? contextRole.reasonCodes : []),
    ...new Set(Array.isArray(consensus.reasonCodes) ? consensus.reasonCodes : [])
  ];
}

function spanGateDiagnostic({
  line = {},
  span = {},
  clause = null,
  structuredFact = null,
  contextRole = {},
  predicateContext = {},
  consensus = {},
  artifactDetectionThreshold = null,
  strictSpanThreshold = 0,
  shadowSpanThreshold = 0,
  strictSpanPass = false,
  shadowSpanPass = false,
  strictLink = {},
  shadowLink = {},
  strictLinkerGates = {},
  shadowLinkerGates = {},
  strictLinkerScoreThreshold = 0,
  strictLinkerMarginThreshold = 0,
  shadowLinkerScoreThreshold = 0,
  shadowLinkerMarginThreshold = 0,
  strictRole = "llm",
  shadowRole = "llm",
  strictReasonCodes = [],
  shadowReasonCodes = []
} = {}) {
  const candidateView = (candidates = [], rankField = "") => (
    (Array.isArray(candidates) ? candidates : []).slice(0, 5).map((candidate, index) => ({
      code: String(candidate?.code || ""),
      name: String(candidate?.name || ""),
      kind: String(candidate?.kind || ""),
      familyKey: String(candidate?.familyKey || ""),
      familyMemberCount: Number(candidate?.familyMemberCount || 0),
      score: finiteNumberOrNull(candidate?.score),
      rawScore: finiteNumberOrNull(candidate?.rawScore),
      categoryMatched: candidate?.categoryMatched === true,
      mentionTypeMatched: typeof candidate?.mentionTypeMatched === "boolean"
        ? candidate.mentionTypeMatched
        : null,
      rank: Number(candidate?.[rankField] || index + 1),
      lexicalMatch: String(
        candidate?.shadowLexicalMatch
        || candidate?.lexicalMatch
        || "none"
      )
    }))
  );
  const contextResolved = consensus.role !== "llm";
  const laneOutcome = (spanPass, linkerGates, role) => {
    if (structuredFact) {
      return {
        jointEligible: false,
        billableInclusionEligible: false,
        standingEligible: false,
        safeExclusionEligible: false,
        structuredFactEligible: true,
        familyIdentified: false,
        abstained: false
      };
    }
    const gatePassed = spanPass && linkerGates.passed;
    return {
      jointEligible: gatePassed && role !== "llm",
      billableInclusionEligible: gatePassed && role === "performed",
      standingEligible: gatePassed && role === "standing",
      safeExclusionEligible: gatePassed && ["excluded", "plan"].includes(role),
      structuredFactEligible: false,
      familyIdentified: spanPass && linkerGates.familyIdentified === true,
      abstained: role === "llm"
    };
  };
  const strictOutcome = laneOutcome(
    strictSpanPass,
    strictLinkerGates,
    strictRole
  );
  const shadowOutcome = laneOutcome(
    shadowSpanPass,
    shadowLinkerGates,
    shadowRole
  );
  return {
    lineId: String(line?.lineId || ""),
    lineIndex: Number(line?.index || 0),
    lineTextSha256: sha256Text(line?.text),
    clauseId: String(clause?.clauseId || ""),
    clauseTextSha256: sha256Text(clause?.text),
    clauseCharStart: finiteNumberOrNull(clause?.charStart),
    clauseCharEnd: finiteNumberOrNull(clause?.charEnd),
    spanId: String(span?.spanId || ""),
    spanTextSha256: sha256Text(span?.text),
    charStart: Number(span?.charStart || 0),
    charEnd: Number(span?.charEnd || 0),
    boundary: {
      snapped: span?.boundarySnapped === true,
      originalCharStart: Number(span?.originalCharStart ?? span?.charStart ?? 0),
      originalCharEnd: Number(span?.originalCharEnd ?? span?.charEnd ?? 0),
      originalSpanTextSha256: sha256Text(span?.originalText ?? span?.text),
      snapReason: String(span?.snapReason || "unchanged")
    },
    category: String(span?.category || ""),
    confidence: finiteNumberOrNull(span?.confidence),
    artifactDetectionThreshold,
    resolutionSource: structuredFact?.resolution || "model_gate",
    context: {
      classifierRole: String(contextRole?.role || "llm"),
      consensusRole: String(consensus?.role || "llm"),
      classifierReasonCodes: uniqueSortedStrings(contextRole?.reasonCodes),
      consensusReasonCodes: uniqueSortedStrings(consensus?.reasonCodes),
      predicateRole: String(predicateContext?.role || "unknown"),
      predicateAxes: uniqueSortedStrings(predicateContext?.axes),
      uncertainAxes: [...new Set(
        Array.isArray(contextRole?.uncertainAxes)
          ? contextRole.uncertainAxes.map(String)
          : []
      )].sort(),
      unknownAxes: uniqueSortedStrings(contextRole?.unknownAxes),
      axes: diagnosticContextAxes(contextRole?.normalizedAxes),
      resolved: contextResolved,
      disagreement: consensus?.disagreement === true
    },
    strict: {
      spanThreshold: Number(strictSpanThreshold),
      spanPass: strictSpanPass,
      linkerScoreThreshold: Number(strictLinkerScoreThreshold),
      linkerMarginThreshold: Number(strictLinkerMarginThreshold),
      linkerMargin: finiteNumberOrNull(strictLink?.margin),
      linkerFamilyMargin: finiteNumberOrNull(strictLink?.familyMargin),
      linkerFamilyKey: String(strictLink?.topFamilyKey || ""),
      linkerFamilyMembers: familyMemberView(strictLink),
      ...strictLinkerGates,
      role: strictRole,
      ...strictOutcome,
      blockerReasonCodes: gateBlockerReasonCodes(strictReasonCodes)
    },
    shadow: {
      spanThreshold: Number(shadowSpanThreshold),
      spanPass: shadowSpanPass,
      linkerScoreThreshold: Number(shadowLinkerScoreThreshold),
      linkerMarginThreshold: Number(shadowLinkerMarginThreshold),
      linkerMargin: finiteNumberOrNull(shadowLink?.margin),
      linkerFamilyMargin: finiteNumberOrNull(shadowLink?.familyMargin),
      linkerFamilyKey: String(shadowLink?.topFamilyKey || ""),
      linkerFamilyMembers: familyMemberView(shadowLink),
      ...shadowLinkerGates,
      role: shadowRole,
      ...shadowOutcome,
      blockerReasonCodes: gateBlockerReasonCodes(shadowReasonCodes)
    },
    semanticCandidates: candidateView(strictLink?.candidates, "semanticRank"),
    shadowCandidates: candidateView(shadowLink?.candidates, "shadowRank")
  };
}

function gateBlockerReasonCodes(reasonCodes = []) {
  return [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
    .map(String)
    .filter((reason) => (
      reason === "span_low_confidence"
      || (reason.startsWith("linker_") && !NON_BLOCKING_LINKER_REASON_CODES.has(reason))
      || WHITEBOX_CONTEXT_REASON_DISPOSITIONS[reason] === "blocker"
    )))].sort();
}

function familyMemberView(link = {}) {
  if (link?.topFamilyReviewable !== true) {
    return [];
  }
  return (Array.isArray(link?.topFamilyMembers) ? link.topFamilyMembers : [])
    .slice(0, MAX_REVIEWABLE_LINKER_FAMILY_SIZE)
    .map((member) => ({
      code: String(member?.code || ""),
      name: String(member?.name || ""),
      kind: String(member?.kind || ""),
      points: finiteNumberOrNull(member?.points)
    }));
}

function diagnosticContextAxes(axes = {}) {
  return Object.fromEntries(Object.entries(axes || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([axis, result]) => [axis, {
      value: String(result?.value || "unknown"),
      confidence: finiteNumberOrNull(result?.confidence),
      abstained: result?.abstained === true
    }]));
}

function uniqueSortedStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
}

function summarizeSpanGateDiagnostics(diagnostics = [], lane = "strict") {
  const rows = (Array.isArray(diagnostics) ? diagnostics : [])
    .map((entry) => ({
      gate: entry?.[lane],
      contextResolved: entry?.context?.resolved === true
    }))
    .filter((entry) => entry.gate && typeof entry.gate === "object");
  const rejectionCounts = {};
  for (const row of rows) {
    for (const reason of Array.isArray(row.gate.blockerReasonCodes)
      ? row.gate.blockerReasonCodes
      : []) {
      rejectionCounts[reason] = Number(rejectionCounts[reason] || 0) + 1;
    }
  }
  return {
    spanCount: rows.length,
    spanPassCount: rows.filter((row) => row.gate.spanPass === true).length,
    linkerEvaluatedCount: rows.filter((row) => row.gate.linkerBypassed !== true).length,
    linkerBypassedCount: rows.filter((row) => row.gate.linkerBypassed === true).length,
    linkerCandidateCount: rows.filter((row) => (
      row.gate.linkerBypassed !== true && row.gate.candidatePresent === true
    )).length,
    linkerScorePassCount: rows.filter((row) => (
      row.gate.linkerBypassed !== true && row.gate.scorePass === true
    )).length,
    linkerMarginPassCount: rows.filter((row) => (
      row.gate.linkerBypassed !== true
      && (row.gate.marginPass === true || row.gate.exactMarginBypass === true)
    )).length,
    linkerCategoryPassCount: rows.filter((row) => (
      row.gate.linkerBypassed !== true && row.gate.categoryPass === true
    )).length,
    linkerMentionTypePassCount: rows.filter(
      (row) => row.gate.linkerBypassed !== true && row.gate.mentionTypePass === true
    ).length,
    linkerPassCount: rows.filter((row) => (
      row.gate.linkerBypassed !== true && row.gate.passed === true
    )).length,
    linkerFamilyIdentifiedCount: rows.filter(
      (row) => row.gate.familyIdentified === true
    ).length,
    contextResolvedCount: rows.filter((row) => row.contextResolved).length,
    jointEligibleCount: rows.filter((row) => row.gate.jointEligible === true).length,
    billableInclusionEligibleCount: rows.filter(
      (row) => row.gate.billableInclusionEligible === true
    ).length,
    standingEligibleCount: rows.filter(
      (row) => row.gate.standingEligible === true
    ).length,
    safeExclusionEligibleCount: rows.filter(
      (row) => row.gate.safeExclusionEligible === true
    ).length,
    structuredFactEligibleCount: rows.filter(
      (row) => row.gate.structuredFactEligible === true
    ).length,
    abstainedCount: rows.filter((row) => row.gate.abstained === true).length,
    rejectionCounts: Object.fromEntries(
      Object.entries(rejectionCounts)
        .sort(([left], [right]) => left.localeCompare(right))
    )
  };
}

function resolvedSpanFromLink(span = {}, link = {}, line = {}, sourceClause = null) {
  const resolved = link?.resolvedSpan;
  if (!resolved || resolved.boundarySnapped !== true) {
    return span;
  }
  const lineText = String(line?.text || "");
  const lineId = String(span?.lineId || "");
  const originalStart = Number(span?.charStart);
  const originalEnd = Number(span?.charEnd);
  const start = Number(resolved?.charStart);
  const end = Number(resolved?.charEnd);
  const text = String(resolved?.text || "");
  const valid = String(resolved?.lineId || "") === lineId
    && Number.isInteger(start)
    && Number.isInteger(end)
    && Number.isInteger(originalStart)
    && Number.isInteger(originalEnd)
    && start >= 0
    && end <= lineText.length
    && start <= originalStart
    && end >= originalEnd
    && end - start > originalEnd - originalStart
    && lineText.slice(start, end) === text
    && (
      !sourceClause
      || (
        start >= Number(sourceClause.charStart)
        && end <= Number(sourceClause.charEnd)
      )
    );
  if (!valid) {
    return span;
  }
  return {
    ...span,
    text,
    charStart: start,
    charEnd: end,
    boundarySnapped: true,
    originalText: String(span?.text || ""),
    originalCharStart: originalStart,
    originalCharEnd: originalEnd,
    snapReason: String(resolved?.snapReason || "unique_alias_extension")
  };
}

function sha256Text(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteProbabilityOrNull(value) {
  const number = finiteNumberOrNull(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function summarizeMetricValues(values = []) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return {
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
      mean: null
    };
  }
  const at = (ratio) => sorted[Math.floor((sorted.length - 1) * ratio)];
  const rounded = (value) => Number(value.toFixed(6));
  return {
    count: sorted.length,
    min: rounded(sorted[0]),
    p50: rounded(at(0.5)),
    p95: rounded(at(0.95)),
    max: rounded(sorted[sorted.length - 1]),
    mean: rounded(sorted.reduce((total, value) => total + value, 0) / sorted.length)
  };
}

export async function buildLinkerCandidateLayer({
  feeCalculator,
  events = [],
  knownCodes = [],
  serviceDate = "",
  specialty = "",
  encounterSetting = "",
  env = process.env
} = {}) {
  const mode = whiteboxRuntimeModes(env).linker;
  const thresholds = safeWhiteboxThresholds(env, { specialty, encounterSetting });
  const normalizedEvents = (Array.isArray(events) ? events : [])
    .filter((event) => String(event?.name || "").trim())
    .slice(0, 100);
  const empty = {
    proposals: [],
    reviewIssues: [],
    metrics: {
      mode,
      queryCount: normalizedEvents.length,
      hitCount: 0,
      reviewCount: 0,
      degraded: false,
      indexVersion: null,
      thresholdVersion: thresholds.version,
      thresholdCells: thresholds.thresholdCells
    },
    trace: null
  };
  if (mode === "off" || !normalizedEvents.length || typeof feeCalculator?.linkSpans !== "function") {
    return empty;
  }
  if (thresholds.degradedReason) {
    return {
      ...empty,
      metrics: {
        ...empty.metrics,
        degraded: true,
        reason: String(thresholds.degradedReason).slice(0, 240)
      },
      trace: {
        stage: "linker_scan",
        outcome: "degraded",
        reason: "threshold_config_invalid"
      }
    };
  }
  const startedAt = Date.now();
  const envelope = await feeCalculator.linkSpans({
    spans: normalizedEvents.map((event) => ({
      text: String(event.name),
      category: event.type || event.category || ""
    })),
    kinds: ["procedure", "drug", "disease"],
    top_k: 5,
    service_date: serviceDate
  }).catch((error) => unavailableEnvelope(error, "index_unavailable"));
  if (envelope?.status !== "complete") {
    return {
      ...empty,
      metrics: {
        ...empty.metrics,
        degraded: true,
        durationMs: Date.now() - startedAt,
        reason: String(envelope?.reason || "linker unavailable").slice(0, 240)
      },
      trace: {
        stage: "linker_scan",
        outcome: "degraded",
        reason: String(envelope?.reason || "linker unavailable").slice(0, 240)
      }
    };
  }
  const known = new Set((Array.isArray(knownCodes) ? knownCodes : []).map(String));
  const proposals = [];
  const reviewIssues = [];
  const traceQueries = [];
  let observedHitCount = 0;
  let observedReviewCount = 0;
  for (const [index, result] of (envelope.results || []).entries()) {
    const event = normalizedEvents[index];
    const candidates = (Array.isArray(result?.candidates) ? result.candidates : [])
      .filter((candidate) => candidate?.code && !known.has(String(candidate.code)));
    const top = candidates[0];
    if (!top || Number(top.score) < thresholds.linkerReviewScore) {
      traceQueries.push(linkerTraceQuery(event, result, candidates, "below_threshold"));
      continue;
    }
    const high = Number(top.score) >= thresholds.linkerHighScore
      && Number(result.margin) >= thresholds.linkerMargin
      && top.categoryMatched === true;
    if (high) {
      observedHitCount += 1;
    } else {
      observedReviewCount += 1;
    }
    if (high && mode === "propose") {
      known.add(String(top.code));
      proposals.push(linkerCandidateProposal(event, result, top));
    } else if (mode === "propose") {
      const familyCandidates = result?.topFamilyReviewable === true
        ? (Array.isArray(result?.topFamilyMembers) ? result.topFamilyMembers : [])
          .filter((candidate) => candidate?.code && !known.has(String(candidate.code)))
          .map((candidate) => ({
            ...candidate,
            score: Number(top.score || 0),
            familyKey: String(result?.topFamilyKey || "")
          }))
        : [];
      reviewIssues.push(linkerReviewIssue(
        event,
        result,
        familyCandidates.length ? familyCandidates : candidates
      ));
    }
    traceQueries.push(linkerTraceQuery(
      event,
      result,
      candidates,
      high ? "candidate" : "review"
    ));
  }
  const durationMs = Date.now() - startedAt;
  return {
    proposals,
    reviewIssues,
    metrics: {
      mode,
      queryCount: normalizedEvents.length,
      hitCount: observedHitCount,
      reviewCount: observedReviewCount,
      degraded: false,
      indexVersion: envelope.indexVersion || null,
      durationMs
    },
    trace: {
      stage: "linker_scan",
      outcome: proposals.length || reviewIssues.length ? "matches_found" : "no_new_candidates",
      mode,
      indexVersion: envelope.indexVersion || null,
      queryCount: normalizedEvents.length,
      durationMs,
      proposedCodes: proposals.map((proposal) => proposal.code),
      reviewIssueCount: reviewIssues.length,
      queries: traceQueries
    }
  };
}

export function isTrivialClinicalLine(value = "") {
  return TRIVIAL_LINE_PATTERNS.some((pattern) => pattern.test(String(value || "")));
}

function encoderEventFromSpan(evaluated, line) {
  const axes = evaluated.contextRole?.normalizedAxes || {};
  const candidate = evaluated.topCandidate;
  const contextAxes = evaluated.contextRole?.normalizedAxes || null;
  const evidenceText = String(evaluated?.clause?.text || line.text || "");
  return {
    clinical_event_id: `encoder_${safeId([line.lineId, evaluated.spanId, candidate.code].join("_"))}`,
    type: eventTypeFromCategory(evaluated.category),
    billing_domain: billingDomainFromCategory(evaluated.category),
    name: candidate.name || evaluated.text,
    action_status: contextAxes?.actionStatus?.value || "performed",
    temporal_relation: contextAxes?.temporalRelation?.value || "current_visit",
    source_origin: contextAxes?.sourceOrigin?.value || "own_clinic_record",
    provider_ownership: contextAxes?.providerOwnership?.value || "own_clinic",
    evidence_line_ids: [line.lineId],
    evidence: evidenceText.slice(0, 180),
    extraction_source: "encoder",
    extractionSource: "encoder",
    review_required: true,
    reviewRequired: true,
    status: "candidate",
    _whiteboxLink: {
      code: String(candidate.code),
      name: String(candidate.name),
      kind: String(candidate.kind),
      points: Number(candidate.points || 0),
      score: Number(candidate.score || 0),
      margin: Number(evaluated.link?.margin || 0),
      indexVersion: evaluated.link?.indexVersion || null
    },
    _whiteboxAxes: axes
  };
}

function encoderExcludedEventFromSpan(evaluated, line) {
  const axes = evaluated.contextRole?.normalizedAxes || {};
  const candidate = evaluated.topCandidate;
  const actionStatus = axes.actionStatus?.value || "unknown";
  const temporalRelation = axes.temporalRelation?.value || "unknown";
  const sourceOrigin = axes.sourceOrigin?.value || "unknown";
  const providerOwnership = axes.providerOwnership?.value || "unknown";
  const evidenceText = String(evaluated?.clause?.text || line.text || "");
  return {
    clinical_event_id: `encoder_excluded_${safeId([
      line.lineId,
      evaluated.spanId,
      candidate.code
    ].join("_"))}`,
    type: eventTypeFromCategory(evaluated.category),
    name: candidate.name || evaluated.text,
    status: excludedLegacyStatus({
      actionStatus,
      temporalRelation,
      sourceOrigin,
      providerOwnership
    }),
    action_status: actionStatus,
    temporal_relation: temporalRelation,
    source_origin: sourceOrigin,
    provider_ownership: providerOwnership,
    evidence_line_ids: [line.lineId],
    evidence: evidenceText.slice(0, 180),
    reason: excludedReason({
      actionStatus,
      temporalRelation,
      sourceOrigin,
      providerOwnership
    }),
    extraction_source: "encoder",
    extractionSource: "encoder",
    _whiteboxLink: {
      code: String(candidate.code),
      name: String(candidate.name),
      kind: String(candidate.kind),
      points: Number(candidate.points || 0),
      score: Number(candidate.score || 0),
      margin: Number(evaluated.link?.margin || 0),
      indexVersion: evaluated.link?.indexVersion || null
    },
    _whiteboxAxes: axes
  };
}

function excludedLegacyStatus({
  actionStatus = "",
  temporalRelation = "",
  sourceOrigin = "",
  providerOwnership = ""
} = {}) {
  if (actionStatus === "not_performed") {
    return "negated";
  }
  if (
    providerOwnership === "other_provider"
    || sourceOrigin === "other_provider_record"
  ) {
    return "other_provider";
  }
  if (
    temporalRelation === "past"
    || ["patient_reported", "external_document", "carried_in_result"].includes(sourceOrigin)
  ) {
    return "history";
  }
  return "unclear";
}

function excludedReason({
  actionStatus = "",
  temporalRelation = "",
  sourceOrigin = "",
  providerOwnership = ""
} = {}) {
  if (actionStatus === "not_performed") {
    return "当日未実施として分類したため、算定候補には含めていません。";
  }
  if (
    providerOwnership === "other_provider"
    || sourceOrigin === "other_provider_record"
  ) {
    return "他院・他提供者の実施内容として分類したため、算定候補には含めていません。";
  }
  if (
    temporalRelation === "past"
    || ["patient_reported", "external_document", "carried_in_result"].includes(sourceOrigin)
  ) {
    return "過去・持参情報として分類したため、当日実施分には含めていません。";
  }
  return "当日自院での実施を確定できないため、算定候補には含めていません。";
}

function normalizeContextAxes(axes = {}) {
  const required = [
    "actionStatus",
    "temporalRelation",
    "sourceOrigin",
    "providerOwnership",
    "standingStatus"
  ];
  return Object.fromEntries(required.map((axis) => {
    const result = axes?.[axis];
    if (!result || typeof result !== "object") {
      return [axis, { value: "unknown", confidence: 0, abstained: true }];
    }
    return [axis, {
      value: String(result.value || "unknown"),
      confidence: Number(result.confidence || 0),
      abstained: result.abstained === true
    }];
  }));
}

function predicateContextForLine(line = {}) {
  if (line?.cues?.negatedService || line?.cues?.pastOrExternal) {
    return {
      role: "excluded",
      axes: [
        ...(line?.cues?.negatedService ? ["action_status"] : []),
        ...(line?.cues?.pastOrExternal ? ["temporal_relation", "source_origin"] : [])
      ]
    };
  }
  if (line?.cues?.futureOrOrderOnly) {
    return {
      role: "plan",
      axes: ["action_status", "temporal_relation"]
    };
  }
  if (line?.cues?.currentVisit) {
    return { role: "performed", axes: ["temporal_relation"] };
  }
  return { role: "unknown", axes: [] };
}

function emptyEncoderFacts(lines = []) {
  return {
    visit_facts: {
      outside_prescription_issued: "unknown",
      generic_name_prescription: "unknown",
      prescription_evidence: ""
    },
    clinical_events: [],
    standing_mentions: [],
    checklist_findings: [],
    excluded_events: [],
    missing_information: [],
    review_flags: [],
    line_review: (Array.isArray(lines) ? lines : []).map((line) => ({
      line_id: line.lineId,
      line_role: "none"
    }))
  };
}

function degradedPlan(base, reason, envelope = null) {
  return {
    ...base,
    status: "degraded",
    degraded: true,
    metrics: {
      ...base.metrics,
      degraded: true,
      degradedReasons: [reason]
    },
    trace: [{
      stage: "whitebox_router",
      outcome: "degraded",
      reason,
      detail: String(envelope?.reason || "").slice(0, 240)
    }]
  };
}

function unavailableEnvelope(error, status = "model_unavailable") {
  return {
    status,
    results: [],
    reason: String(error?.message || error || "whitebox worker unavailable").slice(0, 500)
  };
}

function normalizeThresholds(value = {}) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new Error("whitebox thresholds schemaVersion must be 1");
  }
  return {
    schemaVersion: 1,
    ...Object.fromEntries(WHITEBOX_THRESHOLD_FIELDS.map((field) => [
      field,
      probability(value[field], field)
    ]))
  };
}

function selectThresholds(value = {}, selector = {}) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new Error("whitebox thresholds schemaVersion must be 1");
  }
  const defaults = normalizeThresholds({
    ...DEFAULT_WHITEBOX_THRESHOLDS,
    ...thresholdOverrides(value.defaults || value)
  });
  const cells = normalizedThresholdCells(value.cells);
  const specialty = normalizeThresholdDimension(selector.specialty);
  const setting = normalizeThresholdDimension(selector.encounterSetting);
  const candidateKeys = [
    setting ? `*|${setting}` : "",
    specialty ? `${specialty}|*` : "",
    specialty && setting ? `${specialty}|${setting}` : ""
  ].filter(Boolean);
  const thresholdCells = ["defaults"];
  let selected = defaults;
  for (const key of candidateKeys) {
    const override = cells.get(key);
    if (!override) {
      continue;
    }
    selected = normalizeThresholds({
      ...selected,
      ...override,
      schemaVersion: 1
    });
    thresholdCells.push(key);
  }
  return { thresholds: selected, thresholdCells };
}

function normalizedThresholdCells(value) {
  if (value === undefined || value === null) {
    return new Map();
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("whitebox threshold cells must be an object");
  }
  const normalized = new Map();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeThresholdCellKey(rawKey);
    if (normalized.has(key)) {
      throw new Error(`duplicate whitebox threshold cell: ${key}`);
    }
    normalized.set(key, thresholdOverrides(rawValue));
  }
  return normalized;
}

function normalizeThresholdCellKey(value) {
  const parts = String(value || "").split("|");
  if (parts.length !== 2) {
    throw new Error(`whitebox threshold cell must be specialty|setting: ${value}`);
  }
  const specialty = normalizeThresholdDimension(parts[0]);
  const setting = normalizeThresholdDimension(parts[1]);
  if (!specialty || !setting) {
    throw new Error(`whitebox threshold cell dimensions must not be empty: ${value}`);
  }
  return `${specialty}|${setting}`;
}

function normalizeThresholdDimension(value) {
  const normalized = String(value || "").normalize("NFKC").trim().toLowerCase();
  return normalized === "*" ? "*" : normalized;
}

function thresholdOverrides(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("whitebox threshold overrides must be an object");
  }
  return Object.fromEntries(WHITEBOX_THRESHOLD_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
    .map((field) => [field, probability(value[field], field)]));
}

function safeWhiteboxThresholds(env, selector = {}) {
  try {
    return whiteboxThresholds(env, selector);
  } catch (error) {
    return {
      ...DEFAULT_WHITEBOX_THRESHOLDS,
      version: `invalid_config_fallback:${thresholdDigest(DEFAULT_WHITEBOX_THRESHOLDS)}`,
      thresholdCells: ["invalid_config_fallback"],
      degradedReason: String(error?.message || error)
    };
  }
}

function whiteboxSpecialty(session = {}) {
  return String(
    session?.departmentSnapshot?.specialty
    || session?.specialty
    || session?.facilitySnapshot?.specialty
    || ""
  ).normalize("NFKC").trim().toLowerCase();
}

function thresholdDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function probability(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return number;
}

function enumMode(value, allowed, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function lineRoleForContract(role) {
  if (role === "performed") return "performed";
  if (role === "standing") return "management_continuation";
  if (role === "plan") return "plan";
  return "none";
}

function eventTypeFromCategory(category = "") {
  const value = String(category || "");
  if (["drug", "medication"].includes(value)) return "medication";
  if (["diagnosis", "disease"].includes(value)) return "other";
  if (["lab", "imaging", "procedure", "treatment", "management", "counseling", "material", "injection"].includes(value)) {
    return value;
  }
  return "procedure";
}

function billingDomainFromCategory(category = "") {
  return {
    medication: "standard_medication",
    drug: "standard_medication",
    lab: "standard_lab",
    imaging: "standard_imaging",
    material: "standard_material",
    management: "standard_management",
    counseling: "standard_counseling"
  }[String(category || "")] || "standard_procedure";
}

function linkerCandidateProposal(event, result, top) {
  const proposalId = `linker_${safeId([event?.clinicalEventId || event?.name, top.code].join("_"))}`;
  const points = Number(top.points || 0);
  const score = Number(top.score || 0);
  const reason = `表記「${String(event?.name || "")}」をマスタ「${String(top.name || "")}」と照合しました（類似度${score.toFixed(3)}）。`;
  return {
    proposalId,
    title: `${top.name}の算定確認`,
    reason,
    conditionText: "実施事実・対象病名・回数制限・施設基準を確認してから採用してください。",
    basis: "whitebox_linker_candidate",
    evidence: String(event?.evidence || "").slice(0, 160),
    actionType: points > 0 ? "adoptable" : "confirm_required",
    potentialPoints: points,
    code: String(top.code),
    orderType: top.kind === "drug" ? "medication" : "procedure",
    source: "clinical_billing_opportunity",
    sortOrder: 65,
    confidence: score,
    route: "encoder",
    candidateLine: {
      lineId: `proposal_line_${proposalId}`,
      code: String(top.code),
      name: String(top.name),
      orderType: top.kind === "drug" ? "medication" : "procedure",
      points,
      quantity: 1,
      totalPoints: points,
      status: "candidate",
      reason,
      source: "whitebox_linker",
      extractionSource: "encoder",
      reviewRequired: true,
      coverage: {
        scope: "master_lookup_only",
        chapter: "whitebox_linker",
        supportLevel: "review_required",
        reviewRequired: true
      }
    }
  };
}

function linkerReviewIssue(event, result, candidates) {
  const labels = candidates.slice(0, 5)
    .map((candidate) => `${candidate.name}（${candidate.code}）`)
    .join("、");
  return {
    reviewIssueId: `issue_linker_${safeId(event?.clinicalEventId || event?.name)}`,
    issueCode: result?.topFamilyReviewable === true
      ? "ambiguous_master_family"
      : "ambiguous_master",
    severity: "warning",
    title: "マスター候補の確認",
    messageForStaff: `「${String(event?.name || "")}」に近い算定区分が複数あります。${labels || "該当区分"}から実施内容に一致するものを確認してください。`,
    evidence: String(event?.evidence || "").slice(0, 160),
    requiredInput: "実施内容に一致する標準コード",
    source: "whitebox_linker",
    codeCandidates: candidates.map((candidate) => candidate.code),
    linkerMargin: Number(result?.margin || 0),
    linkerFamilyMargin: finiteNumberOrNull(result?.familyMargin),
    linkerFamilyKey: String(result?.topFamilyKey || ""),
    linkerFamilyMemberCount: Number(result?.topFamilyMemberCount || 0),
    route: "encoder"
  };
}

function linkerTraceQuery(event, result, candidates, chosen) {
  return {
    queryHash: crypto.createHash("sha256")
      .update(`halunasu:fee-linker-query:${String(event?.name || "")}`)
      .digest("hex")
      .slice(0, 24),
    category: String(event?.type || event?.category || "unknown").slice(0, 40),
    margin: Number(result?.margin || 0),
    chosen,
    topK: (Array.isArray(candidates) ? candidates : []).slice(0, 5).map((candidate) => ({
      code: String(candidate?.code || ""),
      kind: String(candidate?.kind || ""),
      score: Number(candidate?.score || 0),
      rawScore: Number(candidate?.rawScore ?? candidate?.score ?? 0),
      categoryMatched: candidate?.categoryMatched === true
    }))
  };
}

function structuredPrescriptionFacts(session = {}) {
  const options = session?.calculationOptions || session?.calculation_options || {};
  const medication = options?.medication
    || session?.encounterDetails?.medication
    || session?.medication
    || {};
  const deliveryKind = String(
    medication?.delivery_kind
    || medication?.deliveryKind
    || ""
  ).trim();
  const genericNameValue = medication?.generic_name_prescription_add_on
    ?? medication?.genericNamePrescription
    ?? options?.generic_name_prescription
    ?? null;
  return {
    configured: ["outside_prescription", "in_house"].includes(deliveryKind)
      || genericNameValue != null,
    outside: deliveryKind === "outside_prescription"
      ? "yes"
      : deliveryKind === "in_house"
        ? "no"
        : "unknown",
    genericName: genericNameValue == null
      ? "unknown"
      : genericNameValue === false || genericNameValue === "no"
        ? "no"
        : "yes",
    evidence: String(
      medication?.prescription_evidence
      || medication?.prescriptionEvidence
      || ""
    ).trim().slice(0, 90)
  };
}

function whiteboxExtractorVersion({
  spanEnvelope = {},
  linkerEnvelope = {},
  contextEnvelope = {},
  thresholds = {},
  env = process.env
} = {}) {
  const identity = {
    schemaVersion: 1,
    span: String(env?.FEE_SPAN_DETECTOR_MANIFEST_PATH || "").trim()
      || spanEnvelope.extractorVersion
      || spanEnvelope.artifactVersion
      || spanEnvelope.modelVersion
      || "unavailable",
    linker: String(env?.FEE_LINKER_MANIFEST_PATH || "").trim()
      || linkerEnvelope.artifactVersion
      || linkerEnvelope.indexVersion
      || linkerEnvelope.modelVersion
      || "unavailable",
    context: String(env?.FEE_CONTEXT_CLASSIFIER_MANIFEST_PATH || "").trim()
      || contextEnvelope.artifactVersion
      || contextEnvelope.modelVersion
      || "unavailable",
    thresholds: thresholds.version || thresholdDigest(thresholds)
  };
  return `whitebox-v1:${crypto.createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24)}`;
}

function safeId(value) {
  return String(value || "item")
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80) || "item";
}
