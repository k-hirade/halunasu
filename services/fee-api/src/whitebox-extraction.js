import crypto from "node:crypto";
import { readFileSync } from "node:fs";

export const WHITEBOX_LINKER_MODES = Object.freeze(["off", "shadow", "propose"]);
export const WHITEBOX_CONTEXT_MODES = Object.freeze(["off", "shadow", "assist"]);
export const WHITEBOX_SPAN_MODES = Object.freeze(["off", "shadow", "route"]);

export const DEFAULT_WHITEBOX_THRESHOLDS = Object.freeze({
  schemaVersion: 1,
  spanConfidence: 0.9,
  // WX3 applies calibrated per-axis thresholds in the ONNX runtime.
  // This optional router threshold may only make that decision stricter.
  contextConfidence: 0,
  linkerHighScore: 0.92,
  linkerReviewScore: 0.8,
  linkerMargin: 0.05,
  relevanceConfidence: 0.95
});

const WHITEBOX_THRESHOLD_FIELDS = Object.freeze([
  "spanConfidence",
  "contextConfidence",
  "linkerHighScore",
  "linkerReviewScore",
  "linkerMargin",
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
  const result = (value) => ({ ...value, normalizedAxes: normalized });
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
  const ambiguousLineIds = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = String(line?.text || "");
    if (!VISIT_FACTS_SENSITIVE_PATTERN.test(text)) {
      continue;
    }
    const lineId = String(line?.lineId || "");
    const cues = line?.cues || {};
    const unsafeContext = cues.pastOrExternal === true || cues.futureOrOrderOnly === true;
    const outsidePositive = OUTSIDE_PRESCRIPTION_POSITIVE_PATTERN.test(text)
      && !OUTSIDE_PRESCRIPTION_NEGATIVE_PATTERN.test(text);
    const outsideNegative = OUTSIDE_PRESCRIPTION_NEGATIVE_PATTERN.test(text);
    const inHouse = IN_HOUSE_PRESCRIPTION_PATTERN.test(text);
    const genericName = GENERIC_NAME_PRESCRIPTION_PATTERN.test(text);
    if (unsafeContext) {
      ambiguousLineIds.push(lineId);
      continue;
    }
    if ((outsidePositive && inHouse) || (outsidePositive && outsideNegative)) {
      ambiguousLineIds.push(lineId);
      continue;
    }
    if (!outsidePositive && !outsideNegative && !inHouse && !genericName) {
      ambiguousLineIds.push(lineId);
      continue;
    }
    observations.push({
      lineId,
      outside: outsidePositive ? "yes" : (outsideNegative || inHouse ? "no" : "unknown"),
      genericName: genericName ? "yes" : "unknown",
      evidence: text.trim().slice(0, 90)
    });
  }

  const outsideValues = new Set(observations
    .map((entry) => entry.outside)
    .filter((value) => value !== "unknown"));
  const genericValues = new Set(observations
    .map((entry) => entry.genericName)
    .filter((value) => value !== "unknown"));
  if (outsideValues.size > 1 || genericValues.size > 1) {
    ambiguousLineIds.push(...observations.map((entry) => entry.lineId));
  }
  const textOutside = outsideValues.size === 1 ? [...outsideValues][0] : "unknown";
  const textGeneric = genericValues.size === 1 ? [...genericValues][0] : "unknown";
  if (
    structured.outside !== "unknown"
    && textOutside !== "unknown"
    && structured.outside !== textOutside
  ) {
    ambiguousLineIds.push(...observations.map((entry) => entry.lineId));
  }
  if (
    structured.genericName !== "unknown"
    && textGeneric !== "unknown"
    && structured.genericName !== textGeneric
  ) {
    ambiguousLineIds.push(...observations.map((entry) => entry.lineId));
  }
  const uniqueAmbiguous = [...new Set(ambiguousLineIds.filter(Boolean))];
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
    status: uniqueAmbiguous.length ? "ambiguous" : "complete",
    facts,
    source: observations.length
      ? (structured.configured ? "structured_and_text" : "deterministic_text")
      : (structured.configured ? "structured_session" : "unknown"),
    evidenceLineIds: observations.map((entry) => entry.lineId).filter(Boolean),
    ambiguousLineIds: uniqueAmbiguous,
    reasonCodes: uniqueAmbiguous.length
      ? ["visit_facts_sensitive_change"]
      : []
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

  let linkerEnvelope = {
    status: modes.linker === "off"
      ? "disabled"
      : (spans.length ? "index_unavailable" : "complete"),
    results: []
  };
  let linkerDurationMs = 0;
  if (modes.linker !== "off" && spans.length && typeof feeCalculator?.linkSpans === "function") {
    const linkerStartedAt = Date.now();
    linkerEnvelope = await feeCalculator.linkSpans({
      spans: spans.map(({ text, category }) => ({ text, category })),
      kinds: ["procedure", "drug", "disease"],
      top_k: 5,
      service_date: session?.serviceDate || ""
    }).catch((error) => unavailableEnvelope(error, "index_unavailable"));
    linkerDurationMs = Date.now() - linkerStartedAt;
  }

  let contextEnvelope = {
    status: modes.context === "off"
      ? "disabled"
      : (spans.length ? "model_unavailable" : "complete"),
    results: []
  };
  let contextDurationMs = 0;
  if (modes.context !== "off" && spans.length && typeof feeCalculator?.classifyContext === "function") {
    const lineIndex = new Map(lines.map((line, index) => [line.lineId, index]));
    const contextStartedAt = Date.now();
    contextEnvelope = await feeCalculator.classifyContext({
      items: spans.map((span) => {
        const index = lineIndex.get(span.lineId) ?? -1;
        return {
          lineId: span.lineId,
          spanId: span.spanId,
          text: index >= 0 ? lines[index].text : span.text,
          spanText: span.text,
          charStart: span.charStart,
          charEnd: span.charEnd,
          previousLine: index > 0 ? lines[index - 1].text : "",
          nextLine: index >= 0 && index + 1 < lines.length ? lines[index + 1].text : ""
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
  const visitFactsPlan = determineWhiteboxVisitFacts({ lines, session });
  const fullLlmRequired = visitFactsPlan.status !== "complete";
  const extractorVersion = whiteboxExtractorVersion({
    spanEnvelope,
    linkerEnvelope,
    contextEnvelope,
    thresholds,
    env
  });
  const linkedByIndex = Array.isArray(linkerEnvelope?.results) ? linkerEnvelope.results : [];
  const contextBySpanId = new Map((Array.isArray(contextEnvelope?.results) ? contextEnvelope.results : [])
    .map((entry) => [String(entry?.spanId || ""), entry]));
  let spanIndex = 0;
  const lineRoutes = [];
  const encoderEvents = [];
  const encoderExcludedEvents = [];
  const standingMentions = [];
  let contextDisagreementCount = 0;
  let contextOverrideCount = 0;
  const contextDisagreementAxes = new Set();
  let contextAbstainSpanCount = 0;
  const contextUncertainAxisCounts = {};

  for (const line of lines) {
    const spanRow = spanRows.find((row) => String(row?.lineId || "") === String(line.lineId)) || {
      relevance: "abstain",
      spans: []
    };
    const lineSpans = Array.isArray(spanRow.spans) ? spanRow.spans : [];
    const evaluatedSpans = [];
    for (const span of lineSpans) {
      const link = linkedByIndex[spanIndex] || { candidates: [], margin: 0 };
      spanIndex += 1;
      const context = contextBySpanId.get(String(span.spanId || "")) || null;
      const topCandidate = Array.isArray(link.candidates) ? link.candidates[0] : null;
      const contextRole = context
        ? contextRoleFromAxes(context.axes, thresholds.contextConfidence)
        : { role: "llm", reasonCodes: ["context_missing"] };
      if (contextRole.uncertainAxes?.length) {
        contextAbstainSpanCount += 1;
        for (const axis of contextRole.uncertainAxes) {
          contextUncertainAxisCounts[axis] = Number(
            contextUncertainAxisCounts[axis] || 0
          ) + 1;
        }
      }
      const predicateContext = predicateContextForLine(line);
      const consensus = contextConsensus({
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
      const linkerHigh = Boolean(
        topCandidate
        && Number(topCandidate.score) >= thresholds.linkerHighScore
        && Number(link.margin) >= thresholds.linkerMargin
        && topCandidate.categoryMatched === true
      );
      const spanHigh = Number(span.confidence) >= thresholds.spanConfidence;
      const role = spanHigh && linkerHigh ? consensus.role : "llm";
      evaluatedSpans.push({
        ...span,
        role,
        contextRole,
        consensus,
        link: { ...link, indexVersion: linkerEnvelope.indexVersion || null },
        topCandidate,
        reasonCodes: [
          ...(spanHigh ? [] : ["span_low_confidence"]),
          ...(linkerHigh ? [] : ["linker_low_confidence_or_margin"]),
          ...consensus.reasonCodes
        ]
      });
    }
    let aggregate;
    if (!lineSpans.length) {
      const trivial = isTrivialClinicalLine(line.text);
      const confidentlyIrrelevant = spanRow.relevance === "irrelevant"
        && Number(spanRow.relevanceConfidence) >= thresholds.relevanceConfidence;
      aggregate = trivial || confidentlyIrrelevant
        ? { role: "none", reasonCodes: [trivial ? "trivial_line" : "relevance_irrelevant"] }
        : { role: "llm", reasonCodes: ["span_missing_nontrivial_line"] };
    } else {
      aggregate = aggregateLineContext(evaluatedSpans);
    }
    const shadowRoute = !fullLlmRequired && aggregate.role !== "llm"
      ? "encoder"
      : "llm";
    const route = canRoute && shadowRoute === "encoder"
      ? "encoder"
      : "llm";
    lineRoutes.push({
      lineId: line.lineId,
      route,
      shadowRoute,
      lineRole: aggregate.role,
      reasonCodes: fullLlmRequired
        ? ["visit_facts_sensitive_change"]
        : aggregate.reasonCodes,
      spans: evaluatedSpans
    });
    if (shadowRoute !== "encoder") {
      continue;
    }
    for (const evaluated of evaluatedSpans) {
      if (evaluated.role === "performed" && evaluated.topCandidate) {
        encoderEvents.push(encoderEventFromSpan(evaluated, line));
      }
      if (evaluated.role === "excluded" && evaluated.topCandidate) {
        encoderExcludedEvents.push(encoderExcludedEventFromSpan(evaluated, line));
      }
      const standingStatus = evaluated.contextRole?.standingStatus;
      if (
        aggregate.role === "standing"
        &&
        evaluated.role === "standing"
        && ["continued", "changed", "stopped"].includes(standingStatus)
      ) {
        standingMentions.push({
          line_id: line.lineId,
          target: evaluated.topCandidate?.name || evaluated.text,
          status: standingStatus,
          source: "encoder"
        });
      }
    }
  }

  const llmLineIds = new Set(lineRoutes.filter((line) => line.route === "llm").map((line) => line.lineId));
  const llmLines = lines.filter((line) => llmLineIds.has(line.lineId));
  const shadowEncoderLineCount = lineRoutes.filter(
    (line) => line.shadowRoute === "encoder"
  ).length;
  const spanBearingLineCount = lineRoutes.filter(
    (line) => Array.isArray(line.spans) && line.spans.length > 0
  ).length;
  const shadowEncoderSpanBearingLineCount = lineRoutes.filter(
    (line) => (
      line.shadowRoute === "encoder"
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
  const encoderFacts = {
    ...emptyEncoderFacts(lines),
    visit_facts: visitFactsPlan.facts,
    clinical_events: encoderEvents,
    excluded_events: encoderExcludedEvents,
    standing_mentions: standingMentions,
    line_review: lineRoutes
      .filter((line) => line.route === "encoder")
      .map((line) => ({
        line_id: line.lineId,
        line_role: lineRoleForContract(line.lineRole)
      }))
  };
  const degraded = !shadowStackAvailable;
  return {
    ...base,
    status: canRoute && !fullLlmRequired ? "route_ready" : "shadow",
    degraded,
    extractorVersion,
    lineRoutes,
    llmLines: canRoute && !fullLlmRequired ? llmLines : lines,
    encoderFacts: canRoute && !fullLlmRequired ? encoderFacts : emptyEncoderFacts(lines),
    encoderShadowFacts: encoderFacts,
    metrics: {
      ...base.metrics,
      mode: canRoute && !fullLlmRequired ? "route" : "shadow",
      degraded,
      degradedReasons: [
        ...(thresholdConfigValid ? [] : ["threshold_config_invalid"]),
        ...(linkerEnvelope?.status !== "complete" ? ["linker_unavailable"] : []),
        ...(contextEnvelope?.status !== "complete" ? ["context_classifier_unavailable"] : [])
      ],
      safetyFallbackReasons: fullLlmRequired
        ? ["visit_facts_sensitive_change"]
        : [],
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
        ambiguousLineCount: visitFactsPlan.ambiguousLineIds.length
      },
      shadowEncoderLineCount,
      shadowRoutableLineRatio: lines.length
        ? shadowEncoderLineCount / lines.length
        : 0,
      spanBearingLineCount,
      shadowEncoderSpanBearingLineCount,
      spanBearingRoutableLineRatio: spanBearingLineCount
        ? shadowEncoderSpanBearingLineCount / spanBearingLineCount
        : 0,
      routeReasonCounts: countRouteReasons(lineRoutes),
      encoderLineCount: canRoute && !fullLlmRequired
        ? lineRoutes.filter((line) => line.route === "encoder").length
        : 0,
      llmLineCount: canRoute && !fullLlmRequired ? llmLines.length : lines.length,
      expectedLlmLineRatio: lines.length
        ? (canRoute && !fullLlmRequired ? llmLines.length : lines.length) / lines.length
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
      outcome: canRoute && !fullLlmRequired ? "routed" : "shadow_only",
      spanDetectorStatus: spanEnvelope.status,
      linkerStatus: linkerEnvelope.status,
      contextClassifierStatus: contextEnvelope.status,
      contextClassifierCalls: contextEnvelope?.status === "complete" && spans.length ? 1 : 0,
      contextClassifierOverrides: contextOverrideCount,
      contextClassifierDisagreements: contextDisagreementCount,
      encoderLineIds: lineRoutes.filter((line) => line.route === "encoder").map((line) => line.lineId),
      shadowEncoderLineIds: lineRoutes.filter((line) => line.shadowRoute === "encoder").map((line) => line.lineId),
      llmLineIds: (canRoute && !fullLlmRequired ? llmLines : lines).map((line) => line.lineId),
      extractorVersion,
      visitFactsStatus: visitFactsPlan.status,
      visitFactsSource: visitFactsPlan.source,
      visitFactsAmbiguousLineIds: visitFactsPlan.ambiguousLineIds
    }]
  };
}

function countRouteReasons(lineRoutes = []) {
  const counts = {};
  for (const line of Array.isArray(lineRoutes) ? lineRoutes : []) {
    for (const rawReason of Array.isArray(line?.reasonCodes) ? line.reasonCodes : []) {
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
      reviewIssues.push(linkerReviewIssue(event, result, candidates));
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
    evidence: String(line.text || "").slice(0, 180),
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
    evidence: String(line.text || "").slice(0, 180),
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
    spanConfidence: probability(value.spanConfidence, "spanConfidence"),
    contextConfidence: probability(value.contextConfidence, "contextConfidence"),
    linkerHighScore: probability(value.linkerHighScore, "linkerHighScore"),
    linkerReviewScore: probability(value.linkerReviewScore, "linkerReviewScore"),
    linkerMargin: probability(value.linkerMargin, "linkerMargin"),
    relevanceConfidence: probability(value.relevanceConfidence, "relevanceConfidence")
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
    issueCode: "ambiguous_master",
    severity: "warning",
    title: "マスター候補の確認",
    messageForStaff: `「${String(event?.name || "")}」に近い算定区分が複数あります。${labels || "該当区分"}から実施内容に一致するものを確認してください。`,
    evidence: String(event?.evidence || "").slice(0, 160),
    requiredInput: "実施内容に一致する標準コード",
    source: "whitebox_linker",
    codeCandidates: candidates.map((candidate) => candidate.code),
    linkerMargin: Number(result?.margin || 0),
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
