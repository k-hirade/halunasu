import {
  FEE_CLINICAL_FACTS_PROMPT_VERSION,
  extractFeeClinicalFactsWithOpenAi
} from "../../../packages/medical-core/src/fee/openai-fee-clinical-facts.js";

export const AUTO_PLACEHOLDER_ORDER_NAMES = new Set([
  "処置・手技",
  "薬剤処方",
  "特定器材・材料",
  "画像診断",
  "医学管理等",
  "検体検査",
  "注射",
  "カルテ記載内容から算定候補を確認"
]);

const CLINICAL_AUTO_OPTION_KEYS = new Set([
  "procedure_codes",
  "outpatient_basic",
  "inpatient_basic",
  "facility_standard_keys",
  "imaging_orders",
  "treatment_orders",
  "medication_orders",
  "medication",
  "material_inputs",
  "comment_inputs",
  "lab_options"
]);

const ACUTE_GENERAL_INPATIENT_BASIC_CODES = Object.freeze({
  "1": "190117710",
  "2": "190199710",
  "3": "190199810",
  "4": "190199910",
  "5": "190200010",
  "6": "190077410"
});

const DPC_CONTEXT_PATTERN = /DPC|診断群分類|包括評価/u;
const STRONG_INPATIENT_CONTEXT_PATTERN = /入院\s*\d{1,2}\s*日目|入院中|入院管理|病棟で|病棟管理|急性期一般入院料\s*[1-6]|入院基本料|DPC対象病院|DPC.*(?:管理|入院|対象)|(?:入院|病棟).*(?:継続|管理|観察)/u;
const NON_CURRENT_INPATIENT_CONTEXT_PATTERN = /入院適応(?:は)?低い|入院適応なし|入院不要|入院なし|入院は不要|退院後|退院希望|入院歴|過去.{0,12}入院|前回入院|入院前/u;

export const FEE_CLINICAL_RULE_SET_VERSION = "fee-clinical-rules-v3";

const DIRECT_RETRIEVAL_FEE_CATEGORIES_BY_EVENT_TYPE = Object.freeze({
  lab: new Set(["lab_test_basic"]),
  imaging: new Set(["imaging_basic", "physiological_exam_basic", "procedure_basic"]),
  exam: new Set(["lab_test_basic", "imaging_basic", "physiological_exam_basic", "procedure_basic"]),
  procedure: new Set(["procedure_basic", "treatment_basic", "physiological_exam_basic"]),
  treatment: new Set(["procedure_basic", "treatment_basic"]),
  management: new Set(["management_fee"]),
  counseling: new Set(["management_fee"])
});

const CT_EQUIPMENT_KIND_PATTERNS = Object.freeze([
  { kind: "multislice_128_or_more", pattern: /(?:128\s*列\s*以上|128列以上|百二十八列以上)/u },
  { kind: "multislice_64_to_128", pattern: /(?:64\s*列\s*以上\s*128\s*列\s*未満|64列以上128列未満|六十四列以上百二十八列未満)/u },
  { kind: "multislice_16_to_64", pattern: /(?:16\s*列\s*以上\s*64\s*列\s*未満|16列以上64列未満|十六列以上六十四列未満)/u },
  { kind: "multislice_4_to_16", pattern: /(?:4\s*列\s*以上\s*16\s*列\s*未満|4列以上16列未満|四列以上十六列未満)/u }
]);

const MRI_EQUIPMENT_KIND_PATTERNS = Object.freeze([
  { kind: "three_tesla", pattern: /(?:3\s*T|３\s*T|3テスラ|３テスラ|三テスラ)/iu },
  { kind: "one_point_five_tesla", pattern: /(?:1\.5\s*T|１\.５\s*T|1\.5テスラ|１\.５テスラ|一・五テスラ)/iu }
]);

export async function buildClinicalCalculationPreparation({
  session = {},
  calculationInput = {},
  feeCalculator,
  openAiApiKey = "",
  openAiModel = "gpt-5.4-nano",
  openAiReasoningEffort = "low",
  openAiTimeoutMs = 0,
  priorSessions = [],
  clinicalFactsExtractor = null
} = {}) {
  const manualOptions = manualCalculationOptions(session, calculationInput);
  if (isPlainObject(session.claimContext) || isPlainObject(calculationInput.claimContext)) {
    return {
      calculationOptions: Object.keys(manualOptions).length ? manualOptions : null,
      calculationOptionsAutoKeys: [],
      calculationOptionsSource: Object.keys(manualOptions).length ? "manual" : null,
      diagnoses: [],
      candidateProposals: [],
      reviewWarnings: [],
      clinicalEvents: [],
      masterCandidates: [],
      billingCandidates: [],
      reviewIssues: [],
      clinicalExtraction: clinicalExtractionMetadata({
        session,
        calculationInput,
        source: "manual",
        openAiModel,
        openAiReasoningEffort,
        feeCalculator
      }),
      metrics: {
        clinicalStructuring: {
          source: "manual",
          durationMs: 0,
          model: openAiModel,
          reasoningEffort: openAiReasoningEffort,
          promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
          ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
          masterVersion: feeMasterVersion(feeCalculator)
        }
      }
    };
  }

  const text = normalizeClinicalText(calculationInput.clinicalText || session.clinicalText || "");
  const inferred = {};
  const inferredDiagnoses = [];
  const candidateProposals = [];
  const reviewWarnings = [];
  const clinicalEvents = [];
  const masterCandidates = [];
  const billingCandidates = [];
  const reviewIssues = [];
  const clinicalTrace = [];
  const metrics = {
    clinicalStructuring: {
      source: text ? "not_run" : "no_clinical_text",
      durationMs: 0,
      model: openAiModel,
      reasoningEffort: openAiReasoningEffort,
      promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
      ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
      masterVersion: feeMasterVersion(feeCalculator),
      timeoutMs: Number(openAiTimeoutMs || 0)
    },
    ruleBasedClinicalInference: {
      durationMs: 0,
      masterLookupCount: 0,
      masterLookupDurationMs: 0
    }
  };

  if (text) {
    const structured = await inferStructuredClinicalCalculationOptions({
      text,
      session,
      feeCalculator,
      openAiApiKey,
      openAiModel,
      openAiReasoningEffort,
      openAiTimeoutMs,
      clinicalFactsExtractor
    });
    metrics.clinicalStructuring = structured.metrics;
    const ruleMetrics = createMasterSearchMetrics(feeCalculator);
    const ruleStartedAt = Date.now();
    const ruleBased = structured.used
      ? await inferDeterministicSupplementalClinicalCalculationOptions({
        text,
        session,
        feeCalculator: ruleMetrics.calculator
      })
      : await inferRuleBasedClinicalCalculationOptions({
        text,
        session,
        feeCalculator: ruleMetrics.calculator
      });
    metrics.ruleBasedClinicalInference = {
      durationMs: Date.now() - ruleStartedAt,
      source: structured.used ? "objective_supplement" : "fallback_rules",
      ...ruleMetrics.snapshot()
    };

    if (structured.used) {
      Object.assign(inferred, normalizeClinicalInferredOptions(
        mergeCalculationOptions(structured.inferred, ruleBased.inferred)
      ));
      inferredDiagnoses.push(...asArray(structured.diagnoses));
      candidateProposals.push(...asArray(structured.candidateProposals), ...asArray(ruleBased.candidateProposals));
      reviewWarnings.push(...structured.reviewWarnings, ...ruleBased.reviewWarnings);
      clinicalEvents.push(...asArray(structured.clinicalEvents));
      masterCandidates.push(...asArray(structured.masterCandidates));
      billingCandidates.push(...asArray(structured.billingCandidates));
      reviewIssues.push(...asArray(structured.reviewIssues));
      clinicalTrace.push(...asArray(structured.clinicalTrace));
    } else {
      Object.assign(inferred, ruleBased.inferred);
      candidateProposals.push(...asArray(ruleBased.candidateProposals));
      reviewWarnings.push(...structured.reviewWarnings, ...ruleBased.reviewWarnings);
    }
  }

  const normalizedInferred = normalizeClinicalInferredOptions(inferred);
  if (isInpatientEncounter(session, text) && !hasOwn(manualOptions, "outpatient_basic")) {
    delete normalizedInferred.outpatient_basic;
  }
  if (!isInpatientEncounter(session, text)) {
    const historyBasic = inferOutpatientBasicFromPatientHistory({
      session,
      priorSessions,
      diagnoses: [
        ...asArray(session.diagnoses),
        ...inferredDiagnoses
      ],
      currentOutpatientBasic: normalizedInferred.outpatient_basic || null
    });
    if (
      !hasOwn(manualOptions, "outpatient_basic")
      && historyBasic.outpatientBasic
    ) {
      normalizedInferred.outpatient_basic = historyBasic.outpatientBasic;
    }
    reviewWarnings.push(...historyBasic.reviewWarnings);
    reviewWarnings.push(...inferPediatricAddOnReviewWarnings({
      session,
      text,
      outpatientBasic: normalizedInferred.outpatient_basic || historyBasic.outpatientBasic || null
    }));
  }

  const autoKeys = Object.keys(normalizedInferred).filter((key) => (
    CLINICAL_AUTO_OPTION_KEYS.has(key) && !hasOwn(manualOptions, key)
  ));
  const merged = normalizeClinicalInferredOptions(mergeCalculationOptions(manualOptions, normalizedInferred));
  return {
    calculationOptions: Object.keys(merged).length ? merged : null,
    calculationOptionsAutoKeys: autoKeys,
    calculationOptionsSource: calculationOptionsSource(manualOptions, autoKeys),
    diagnoses: normalizeClinicalDiagnoses(inferredDiagnoses),
    candidateProposals: normalizeCandidateProposals(candidateProposals),
    reviewWarnings: normalizeReviewWarnings(reviewWarnings),
    clinicalEvents: normalizeClinicalEventsForResult(clinicalEvents),
    masterCandidates: normalizeMasterCandidates(masterCandidates),
    billingCandidates: normalizeBillingCandidates(billingCandidates),
    reviewIssues: normalizeReviewIssues(reviewIssues),
    clinicalExtraction: clinicalExtractionMetadata({
      session,
      calculationInput,
      source: metrics.clinicalStructuring?.source || "unknown",
      openAiModel,
      openAiReasoningEffort,
      openAiTimeoutMs,
      feeCalculator,
      clinicalEventCount: clinicalEvents.length,
      masterCandidateCount: masterCandidates.length,
      billingCandidateCount: billingCandidates.length,
      reviewIssueCount: reviewIssues.length,
      clinicalTrace,
      responseId: metrics.clinicalStructuring?.responseId || null,
      usage: metrics.clinicalStructuring?.usage || null
    }),
    metrics
  };
}

export function isAutoPlaceholderOrderName(value) {
  return AUTO_PLACEHOLDER_ORDER_NAMES.has(String(value || "").trim());
}

export function normalizeClinicalText(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .trim();
}

async function inferStructuredClinicalCalculationOptions({
  text,
  session = {},
  feeCalculator,
  openAiApiKey = "",
  openAiModel = "gpt-5.4-nano",
  openAiReasoningEffort = "low",
  openAiTimeoutMs = 0,
  clinicalFactsExtractor = null
} = {}) {
  const extractor = typeof clinicalFactsExtractor === "function" ? clinicalFactsExtractor : null;
  if (!extractor && !String(openAiApiKey || "").trim()) {
    return {
      used: false,
      inferred: {},
      candidateProposals: [],
      reviewWarnings: [],
      metrics: {
        source: "rules_no_openai",
        durationMs: 0,
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
        ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
        masterVersion: feeMasterVersion(feeCalculator),
        openAiProviderDurationMs: 0,
        clinicalFactsConvertDurationMs: 0,
        convertedDiagnosisCount: 0,
        convertedOptionKeys: [],
        convertedReviewWarningCount: 0,
        masterLookupCount: 0,
        masterLookupDurationMs: 0,
        timeoutMs: Number(openAiTimeoutMs || 0)
      }
    };
  }

  const startedAt = Date.now();
  const conversionSearch = createMasterSearchMetrics(feeCalculator);
  let openAiProviderDurationMs = 0;
  let firstOutputTextMs = null;
  let firstSnapshotSeen = false;
  try {
    const providerStartedAt = Date.now();
    const factsResult = extractor
      ? await extractor({
        clinicalText: text,
        session,
        sessionContext: buildFeeSessionContext(session),
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        timeoutMs: openAiTimeoutMs
      })
      : await extractFeeClinicalFactsWithOpenAi({
        apiKey: openAiApiKey,
        clinicalText: text,
        sessionContext: buildFeeSessionContext(session),
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        timeoutMs: openAiTimeoutMs,
        stream: true,
        onOutputTextSnapshot: () => {
          if (!firstSnapshotSeen) {
            firstSnapshotSeen = true;
            firstOutputTextMs = Date.now() - providerStartedAt;
          }
        }
      });
    openAiProviderDurationMs = Date.now() - providerStartedAt;
    const facts = factsResult?.parsed || factsResult || {};
    const conversionStartedAt = Date.now();
    const converted = await clinicalFactsToCalculationOptions(facts, {
      text,
      session,
      feeCalculator: conversionSearch.calculator
    });
    const convertedOptionKeys = Object.keys(converted.inferred || {});
    return {
      used: true,
      ...converted,
      metrics: {
        source: "openai",
        durationMs: Date.now() - startedAt,
        openAiProviderDurationMs,
        firstOutputTextMs,
        clinicalFactsConvertDurationMs: Date.now() - conversionStartedAt,
        extractedDiagnosisCount: Array.isArray(facts?.diagnoses) ? facts.diagnoses.length : 0,
        extractedClinicalEventCount: clinicalEventsFromClinicalFacts(facts).length,
        extractedBillingEventCount: Array.isArray(facts?.billing_events) ? facts.billing_events.length : 0,
        extractedExcludedEventCount: Array.isArray(facts?.excluded_events) ? facts.excluded_events.length : 0,
        convertedDiagnosisCount: Array.isArray(converted.diagnoses) ? converted.diagnoses.length : 0,
        convertedOptionKeys,
        convertedReviewWarningCount: Array.isArray(converted.reviewWarnings) ? converted.reviewWarnings.length : 0,
        convertedMasterCandidateCount: Array.isArray(converted.masterCandidates) ? converted.masterCandidates.length : 0,
        convertedBillingCandidateCount: Array.isArray(converted.billingCandidates) ? converted.billingCandidates.length : 0,
        convertedReviewIssueCount: Array.isArray(converted.reviewIssues) ? converted.reviewIssues.length : 0,
        convertedClinicalTraceCount: Array.isArray(converted.clinicalTrace) ? converted.clinicalTrace.length : 0,
        ...conversionSearch.snapshot(),
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        promptVersion: factsResult?.promptVersion || FEE_CLINICAL_FACTS_PROMPT_VERSION,
        ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
        masterVersion: feeMasterVersion(feeCalculator),
        timeoutMs: Number(openAiTimeoutMs || 0),
        responseId: factsResult?.responseId || null,
        usage: factsResult?.usage || null
      }
    };
  } catch (error) {
    return {
      used: false,
      inferred: {},
      diagnoses: [],
      candidateProposals: [],
      reviewWarnings: [
        "AI構造化に失敗したため、従来のルールベース抽出で算定候補を作成しました。"
      ],
      metrics: {
        source: "rules_fallback",
        durationMs: Date.now() - startedAt,
        openAiProviderDurationMs: openAiProviderDurationMs || Date.now() - startedAt,
        firstOutputTextMs,
        clinicalFactsConvertDurationMs: 0,
        convertedDiagnosisCount: 0,
        convertedOptionKeys: [],
        convertedReviewWarningCount: 0,
        ...conversionSearch.snapshot(),
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
        promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
        ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
        masterVersion: feeMasterVersion(feeCalculator),
        timeoutMs: Number(openAiTimeoutMs || 0),
        fallbackReason: safeClinicalStructuringError(error)
      }
    };
  }
}

function safeClinicalStructuringError(error) {
  return [
    error?.name || "Error",
    error?.safeProviderMessage || error?.providerErrorCode || error?.code || error?.message || ""
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(": ")
    .slice(0, 240);
}

function createMasterSearchMetrics(feeCalculator) {
  const metrics = {
    masterLookupCount: 0,
    masterLookupDurationMs: 0
  };
  if (typeof feeCalculator?.searchMaster !== "function") {
    return {
      calculator: feeCalculator,
      snapshot: () => ({ ...metrics })
    };
  }

  return {
    calculator: {
      ...feeCalculator,
      async searchMaster(input) {
        const startedAt = Date.now();
        metrics.masterLookupCount += 1;
        try {
          return await feeCalculator.searchMaster(input);
        } finally {
          metrics.masterLookupDurationMs += Date.now() - startedAt;
        }
      }
    },
    snapshot: () => ({ ...metrics })
  };
}

function feeMasterVersion(feeCalculator) {
  return String(
    feeCalculator?.masterVersion
    || feeCalculator?.version
    || process.env.FEE_MASTER_VERSION
    || process.env.FEE_MASTER_DB_VERSION
    || "runtime-master-current"
  );
}

function clinicalExtractionMetadata({
  session = {},
  calculationInput = {},
  source = "unknown",
  openAiModel = "gpt-5.4-nano",
  openAiReasoningEffort = "low",
  openAiTimeoutMs = 0,
  feeCalculator,
  clinicalEventCount = 0,
  masterCandidateCount = 0,
  billingCandidateCount = 0,
  reviewIssueCount = 0,
  clinicalTrace = [],
  responseId = null,
  usage = null
} = {}) {
  const text = normalizeClinicalText(calculationInput.clinicalText || session.clinicalText || "");
  const inputHash = clinicalInputHash([
    session.orgId,
    session.feeSessionId,
    session.patientId,
    session.serviceDate,
    text
  ].join("\n"));
  return {
    runId: `clinical_${inputHash}`,
    source,
    inputHash,
    model: openAiModel,
    reasoningEffort: openAiReasoningEffort,
    timeoutMs: Number(openAiTimeoutMs || 0),
    promptVersion: FEE_CLINICAL_FACTS_PROMPT_VERSION,
    ruleSetVersion: FEE_CLINICAL_RULE_SET_VERSION,
    masterVersion: feeMasterVersion(feeCalculator),
    responseId,
    usage: usage || null,
    clinicalEventCount: Number(clinicalEventCount || 0),
    masterCandidateCount: Number(masterCandidateCount || 0),
    billingCandidateCount: Number(billingCandidateCount || 0),
    reviewIssueCount: Number(reviewIssueCount || 0),
    trace: normalizeClinicalTrace(clinicalTrace)
  };
}

function clinicalInputHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function inferRuleBasedClinicalCalculationOptions({ text = "", session = {}, feeCalculator } = {}) {
  const inferred = {};
  const reviewWarnings = [];

  if (isInpatientEncounter(session, text)) {
    const inpatientBasic = inferInpatientBasicOptions(text, session);
    Object.assign(inferred, inpatientBasic.inferred);
    reviewWarnings.push(...inpatientBasic.reviewWarnings);
  } else {
    const outpatientBasic = inferOutpatientBasicOptions(text);
    if (outpatientBasic) {
      inferred.outpatient_basic = outpatientBasic;
    }
  }

  const imaging = inferImagingOrders(text);
  if (imaging.orders.length) {
    inferred.imaging_orders = imaging.orders;
  }
  reviewWarnings.push(...imaging.reviewWarnings);

  const drugInference = await inferMedicationOrders(text, feeCalculator);
  if (drugInference.orders.length) {
    inferred.medication_orders = drugInference.orders;
    inferred.medication = {
      delivery_kind: inferMedicationDeliveryKind(text),
      prescription_category: "other"
    };
  }
  reviewWarnings.push(...drugInference.reviewWarnings);

  const materialInference = await inferMaterialInputs(text, feeCalculator);
  if (materialInference.inputs.length) {
    inferred.material_inputs = materialInference.inputs;
  }
  reviewWarnings.push(...materialInference.reviewWarnings);

  return {
    inferred,
    reviewWarnings
  };
}

async function inferDeterministicSupplementalClinicalCalculationOptions({ text = "", session = {}, feeCalculator } = {}) {
  const objectiveText = objectiveClinicalText(text);
  if (!objectiveText) {
    return {
      inferred: {},
      reviewWarnings: []
    };
  }

  const inferred = {};
  const reviewWarnings = [];

  if (isInpatientEncounter(session, text)) {
    const inpatientBasic = inferInpatientBasicOptions(text, session);
    Object.assign(inferred, inpatientBasic.inferred);
    reviewWarnings.push(...inpatientBasic.reviewWarnings);
  }

  const imaging = inferImagingOrders(objectiveText);
  if (imaging.orders.length) {
    inferred.imaging_orders = imaging.orders;
  }
  reviewWarnings.push(...imaging.reviewWarnings);

  return {
    inferred,
    reviewWarnings
  };
}

async function clinicalFactsToCalculationOptions(facts = {}, { text = "", session = {}, feeCalculator } = {}) {
  const inferred = {};
  const diagnoses = diagnosesFromClinicalFacts(facts);
  const reviewWarnings = [];
  const procedureCodes = [];
  const imagingOrders = [];
  const medicationOrders = [];
  const materialInputs = [];
  const commentInputs = [];
  const collectionFeeInputs = [];
  const candidateProposals = [];
  const masterCandidates = [];
  const billingCandidates = [];
  const reviewIssues = [];
  const clinicalTrace = [];
  const clinicalEvents = clinicalEventsFromClinicalFacts(facts);

  if (isInpatientEncounter(session, text)) {
    const inpatientBasic = inferInpatientBasicOptions(text, session);
    Object.assign(inferred, inpatientBasic.inferred);
    reviewWarnings.push(...inpatientBasic.reviewWarnings);
  } else {
    const outpatientBasic = outpatientBasicFromStructuredVisit(facts?.visit_type, text);
    if (outpatientBasic) {
      inferred.outpatient_basic = outpatientBasic;
    }
  }

  for (const event of excludedClinicalEventsFromClinicalFacts(facts)) {
    const issue = reviewIssueFromExcludedClinicalEvent(event);
    if (issue) {
      reviewIssues.push(issue);
      reviewWarnings.push(issue.messageForStaff);
    }
  }
  reviewWarnings.push(...clinicalFactReviewWarnings(facts?.missing_information));
  reviewWarnings.push(...clinicalFactReviewWarnings(facts?.review_flags));

  for (const event of clinicalEvents) {
    const type = normalizeClinicalEventType(event);
    if (!isBillableClinicalEvent(event)) {
      const issue = reviewIssueFromExcludedClinicalEvent(event);
      if (issue) {
        reviewIssues.push(issue);
        reviewWarnings.push(issue.messageForStaff);
      }
      continue;
    }

    if (type === "imaging") {
      const imaging = await imagingOrderFromClinicalEvent(event, feeCalculator);
      if (imaging.order) imagingOrders.push(imaging.order);
      procedureCodes.push(...imaging.procedureCodes);
      commentInputs.push(...imaging.commentInputs);
      collectionFeeInputs.push(...imaging.collectionFeeInputs);
      masterCandidates.push(...asArray(imaging.masterCandidates));
      billingCandidates.push(...billingCandidatesFromProcedureResult(event, imaging));
      reviewWarnings.push(...imaging.reviewWarnings);
      clinicalTrace.push(...asArray(imaging.traceEvents));
      continue;
    }

    if (type === "lab") {
      const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
        categoryLabel: "検体検査",
        allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event)
      });
      procedureCodes.push(...procedure.procedureCodes);
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs, ...labCollectionFeeInputsFromClinicalEvent(event, procedure));
      masterCandidates.push(...asArray(procedure.masterCandidates));
      billingCandidates.push(...billingCandidatesFromProcedureResult(event, procedure));
      reviewWarnings.push(...procedure.reviewWarnings);
      clinicalTrace.push(...asArray(procedure.traceEvents), ...labRuleTraceEvents(event, procedure));
      continue;
    }

    if (type === "medication") {
      const medication = await medicationOrderFromClinicalEvent(event, feeCalculator);
      if (medication.order) {
        medicationOrders.push(medication.order);
      }
      masterCandidates.push(...asArray(medication.masterCandidates));
      billingCandidates.push(...billingCandidatesFromMedicationResult(event, medication));
      reviewWarnings.push(...medication.reviewWarnings);
      continue;
    }

    if (type === "material") {
      const material = await materialInputFromClinicalEvent(event, feeCalculator);
      if (material.input) {
        materialInputs.push(material.input);
      }
      masterCandidates.push(...asArray(material.masterCandidates));
      billingCandidates.push(...billingCandidatesFromMaterialResult(event, material));
      reviewWarnings.push(...material.reviewWarnings);
      continue;
    }

    if (["procedure", "exam", "treatment"].includes(type)) {
      const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
        categoryLabel: type === "exam" ? "検査・処置" : type === "treatment" ? "処置・手技" : "診療行為",
        allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event)
      });
      procedureCodes.push(...procedure.procedureCodes);
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs);
      masterCandidates.push(...asArray(procedure.masterCandidates));
      billingCandidates.push(...billingCandidatesFromProcedureResult(event, procedure));
      reviewWarnings.push(...procedure.reviewWarnings);
      clinicalTrace.push(...asArray(procedure.traceEvents));
      continue;
    }

    if (["management", "counseling"].includes(type)) {
      const categoryLabel = type === "management" ? "医学管理等" : "指導料";
      const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
        categoryLabel,
        allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event)
      });
      if (procedure.procedureCodes.length) {
        procedureCodes.push(...procedure.procedureCodes);
        commentInputs.push(...procedure.commentInputs);
        collectionFeeInputs.push(...procedure.collectionFeeInputs);
        masterCandidates.push(...asArray(procedure.masterCandidates));
        billingCandidates.push(...billingCandidatesFromProcedureResult(event, procedure));
        reviewWarnings.push(...procedure.reviewWarnings);
        clinicalTrace.push(...asArray(procedure.traceEvents));
      } else {
        const proposal = await clinicalEventCandidateProposal(event, feeCalculator, {
          categoryLabel,
          sortOrder: type === "management" ? 25 : 30
        });
        if (proposal) {
          candidateProposals.push(proposal);
          billingCandidates.push(billingCandidateFromProposal(event, proposal));
        } else {
          const issue = reviewIssueFromUnsupportedClinicalEvent(event);
          if (issue) {
            reviewIssues.push(issue);
            reviewWarnings.push(issue.messageForStaff);
          }
        }
      }
      continue;
    }

    const issue = reviewIssueFromUnsupportedClinicalEvent(event);
    if (issue) {
      reviewIssues.push(issue);
      reviewWarnings.push(issue.messageForStaff);
    }
  }

  if (imagingOrders.length) {
    inferred.imaging_orders = dedupeObjects(imagingOrders);
  }
  if (procedureCodes.length) {
    inferred.procedure_codes = uniqueStrings(procedureCodes);
  }
  if (commentInputs.length) {
    inferred.comment_inputs = dedupeObjects(commentInputs, (item) => item?.code || item?.text || JSON.stringify(item));
  }
  if (collectionFeeInputs.length) {
    inferred.lab_options = {
      collection_fee_inputs: uniqueStrings(collectionFeeInputs)
    };
  }
  if (medicationOrders.length) {
    inferred.medication_orders = dedupeObjects(medicationOrders, (item) => item.drug_code);
    inferred.medication = {
      delivery_kind: inferMedicationDeliveryKind(text),
      prescription_category: "other"
    };
  }
  if (materialInputs.length) {
    inferred.material_inputs = dedupeObjects(materialInputs, (item) => item.code);
  }

  return {
    inferred,
    diagnoses,
    candidateProposals: normalizeCandidateProposals(candidateProposals),
    reviewWarnings: normalizeReviewWarnings(reviewWarnings),
    clinicalEvents,
    masterCandidates: normalizeMasterCandidates(masterCandidates),
    billingCandidates: normalizeBillingCandidates(billingCandidates),
    reviewIssues: normalizeReviewIssues(reviewIssues),
    clinicalTrace: normalizeClinicalTrace(clinicalTrace)
  };
}

async function clinicalEventCandidateProposal(event = {}, feeCalculator, {
  categoryLabel = "診療行為",
  sortOrder = 50
} = {}) {
  const name = clinicalEventName(event);
  const evidence = clinicalEventEvidence(event);
  const title = `${name || categoryLabel}の算定確認`;
  const reason = `${name || categoryLabel}を${categoryLabel}に関係する医療イベントとして抽出しました。`;
  const conditionText = `${categoryLabel}として算定できる項目があれば、対象疾患・施設基準・同月算定条件を確認してください。`;
  const queries = clinicalEventSearchQueries(event, { categoryLabel });
  const item = await searchProcedureCandidateItem(feeCalculator, queries, [
    ...(name ? [new RegExp(escapeRegExp(name), "u")] : []),
    new RegExp(escapeRegExp(categoryLabel), "u")
  ], {
    allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event)
  });
  if (item?.code) {
    return candidateProposalFromProcedureItem({
      proposalId: `clinical_event_${candidateIdPart(name || categoryLabel)}_${item.code}`,
      title,
      reason,
      conditionText,
      evidence,
      item,
      sortOrder,
      basis: "カルテ本文から実施済みの医療イベントとして抽出しました。条件を満たす場合だけ採用してください。"
    });
  }
  return {
    proposalId: `clinical_event_${candidateIdPart([categoryLabel, name, evidence].join("_"))}_confirm`,
    title,
    reason,
    conditionText: `${conditionText} 標準コードはマスター検索で確認してください。`,
    evidence,
    actionType: "confirm_required",
    potentialPoints: 0,
    orderType: "procedure",
    source: "clinical_event_opportunity",
    sortOrder
  };
}

async function searchProcedureCandidateItem(feeCalculator, queries = [], preferredPatterns = [], options = {}) {
  if (typeof feeCalculator?.searchMaster !== "function") {
    return null;
  }
  const allowedFeeCategories = options.allowedFeeCategories || null;
  for (const query of uniqueStrings(queries).filter((value) => value.length >= 2)) {
    try {
      const result = await feeCalculator.searchMaster({ type: "procedure", query, limit: 10 });
      const items = asArray(result?.items).filter((item) => item?.code && (
        item.kind === "procedure"
        || item.sourceType === "medical_procedure_master"
        || item.source === "medical_procedure_master"
      ))
        .map((item) => annotateMedicalServiceCandidate(item))
        .filter((item) => !directRetrievalFilterReason(item, { allowedFeeCategories }));
      const preferred = items.find((item) => {
        const text = [item.name, item.baseName, item.displayName, item.shortName].filter(Boolean).join(" ");
        return preferredPatterns.some((pattern) => pattern.test(text));
      });
      const candidate = preferred || items.find((item) => Number(item.points || item.totalPoints || 0) > 0) || items[0];
      if (candidate?.code) {
        return candidate;
      }
    } catch {
      // Master search is advisory here; failed lookups should not block calculation.
    }
  }
  return null;
}

function candidateProposalFromProcedureItem({
  proposalId,
  title,
  reason,
  conditionText,
  basis = "",
  evidence = "",
  item = {},
  sortOrder = 50
} = {}) {
  const points = Number(item.points || item.totalPoints || 0);
  return {
    proposalId,
    title,
    reason,
    conditionText,
    basis,
    evidence,
    actionType: points > 0 ? "adoptable" : "confirm_required",
    potentialPoints: points,
    code: String(item.code || ""),
    orderType: "procedure",
    source: "clinical_billing_opportunity",
    sortOrder,
    candidateLine: {
      lineId: `proposal_line_${String(proposalId || item.code || "").replace(/[^\w-]/gu, "_")}`,
      code: String(item.code || ""),
      name: item.name || item.displayName || item.baseName || title,
      orderType: "procedure",
      points,
      quantity: 1,
      totalPoints: points,
      status: "candidate",
      reason,
      source: "medical_procedure_master",
      coverage: {
        scope: "master_lookup_only",
        chapter: "procedure_code_master",
        supportLevel: "review_required",
        reviewRequired: true
      },
      supportLevel: "review_required",
      reviewRequired: true
    }
  };
}

function masterCandidateFromItem(item = {}, event = {}, {
  masterType = "medical_service",
  rank = 1,
  candidateStatus = "strong_match",
  searchQuery = "",
  generatedBy = "master_search"
} = {}) {
  if (!item?.code) {
    return null;
  }
  const classified = classifyMedicalServiceCandidate(item);
  const code = String(item.code || "");
  const name = item.name || item.displayName || item.baseName || item.shortName || "";
  return {
    masterCandidateId: `mc_${candidateIdPart([event?.clinicalEventId, code, searchQuery].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterType,
    masterCode: code,
    masterName: name,
    points: Number(item.points || item.totalPoints || 0),
    category: item.kind || item.sourceType || item.source || "",
    feeCategory: classified.feeCategory,
    itemRole: classified.itemRole,
    directRetrievalAllowed: classified.directRetrievalAllowed,
    requiresParentCode: classified.requiresParentCode,
    derivedOnly: classified.derivedOnly,
    searchQuery,
    searchScore: Number(item.score || 0) || null,
    rank,
    candidateStatus,
    source: item.sourceType || item.source || "",
    sourceVersion: item.sourceVersion || item.source_version || "",
    effectiveFrom: item.effectiveFrom || item.effective_from || "",
    effectiveTo: item.effectiveTo || item.effective_to || "",
    generatedBy
  };
}

function normalizeMasterCandidates(values = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of asArray(values).filter(Boolean)) {
    const key = [
      candidate.clinicalEventId,
      candidate.masterType,
      candidate.masterCode,
      candidate.searchQuery
    ].join("|");
    if (!candidate.masterCode || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result.slice(0, 80);
}

function stringValue(value) {
  return String(value || "").trim();
}

function annotateMedicalServiceCandidate(item = {}) {
  const classified = classifyMedicalServiceCandidate(item);
  return {
    ...item,
    feeCategory: classified.feeCategory,
    itemRole: classified.itemRole,
    directRetrievalAllowed: classified.directRetrievalAllowed,
    requiresParentCode: classified.requiresParentCode,
    derivedOnly: classified.derivedOnly
  };
}

function classifyMedicalServiceCandidate(item = {}) {
  const explicitFeeCategory = stringValue(item.feeCategory || item.fee_category || item.categoryRole || item.category_role);
  const explicitItemRole = stringValue(item.itemRole || item.item_role || item.role);
  if (explicitFeeCategory || explicitItemRole) {
    const itemRole = normalizeMasterItemRole(explicitItemRole || inferRoleFromFeeCategory(explicitFeeCategory));
    const feeCategory = explicitFeeCategory || inferFeeCategoryFromRole(itemRole);
    return normalizedMedicalServiceClassification({
      feeCategory,
      itemRole,
      directRetrievalAllowed: item.directRetrievalAllowed ?? item.direct_retrieval_allowed,
      requiresParentCode: item.requiresParentCode ?? item.requires_parent_code
    });
  }

  const code = String(item.code || "");
  const text = normalizeProcedureMatchText([
    item.name,
    item.baseName,
    item.displayName,
    item.shortName
  ].filter(Boolean).join(" "));

  if (/減算|不適合/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "reduction", itemRole: "reduction" });
  }
  if (/判断料/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "lab_judgment", itemRole: "judgment" });
  }
  if (/検体検査管理加算|外来迅速検体検査加算/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "lab_addon", itemRole: "addon" });
  }
  if (/採血|静脈血|動脈血|B-V|ＢＶ|検体採取/iu.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "lab_collection", itemRole: "collection" });
  }
  if (code.startsWith("111") || code.startsWith("112")) {
    return normalizedMedicalServiceClassification({ feeCategory: "basic_fee", itemRole: "base" });
  }
  if (code.startsWith("113") || /管理料|指導料/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "management_fee", itemRole: "base" });
  }
  if (code.startsWith("170") || /ct|mri|画像|撮影/u.test(text)) {
    return normalizedMedicalServiceClassification({ feeCategory: "imaging_basic", itemRole: "base" });
  }
  if (code.startsWith("160")) {
    if (/超音波|心電図|視野|眼圧|眼底|スリット|眼軸|内視鏡|呼吸機能/u.test(text)) {
      return normalizedMedicalServiceClassification({ feeCategory: "physiological_exam_basic", itemRole: "base" });
    }
    return normalizedMedicalServiceClassification({ feeCategory: "lab_test_basic", itemRole: "base" });
  }
  if (code.startsWith("140")) {
    return normalizedMedicalServiceClassification({ feeCategory: "treatment_basic", itemRole: "base" });
  }
  return normalizedMedicalServiceClassification({ feeCategory: "procedure_basic", itemRole: "base" });
}

function normalizedMedicalServiceClassification({
  feeCategory = "procedure_basic",
  itemRole = "base",
  directRetrievalAllowed = null,
  requiresParentCode = null
} = {}) {
  const normalizedRole = normalizeMasterItemRole(itemRole);
  const category = stringValue(feeCategory) || inferFeeCategoryFromRole(normalizedRole);
  const derivedOnly = ["addon", "judgment", "collection", "reduction"].includes(normalizedRole);
  const directAllowed = directRetrievalAllowed == null
    ? !derivedOnly
    : Boolean(directRetrievalAllowed);
  return {
    feeCategory: category,
    itemRole: normalizedRole,
    directRetrievalAllowed: directAllowed && !derivedOnly,
    requiresParentCode: requiresParentCode == null ? derivedOnly : Boolean(requiresParentCode),
    derivedOnly
  };
}

function normalizeMasterItemRole(value) {
  const role = stringValue(value);
  if (["addon", "judgment", "collection", "reduction", "comment", "material", "base"].includes(role)) {
    return role;
  }
  return "base";
}

function inferRoleFromFeeCategory(value) {
  const category = stringValue(value);
  if (category.includes("addon")) return "addon";
  if (category.includes("judgment")) return "judgment";
  if (category.includes("collection")) return "collection";
  if (category.includes("reduction")) return "reduction";
  return "base";
}

function inferFeeCategoryFromRole(role) {
  if (role === "addon") return "procedure_addon";
  if (role === "judgment") return "lab_judgment";
  if (role === "collection") return "lab_collection";
  if (role === "reduction") return "reduction";
  return "procedure_basic";
}

function directRetrievalFilterReason(item = {}, { allowedFeeCategories = null } = {}) {
  const classified = classifyMedicalServiceCandidate(item);
  if (classified.derivedOnly || !classified.directRetrievalAllowed) {
    return `derived_only:${classified.itemRole || classified.feeCategory}`;
  }
  const allowed = allowedFeeCategorySet(allowedFeeCategories);
  if (allowed.size && !allowed.has(classified.feeCategory)) {
    return `category_gate:${classified.feeCategory}`;
  }
  return "";
}

function allowedDirectRetrievalFeeCategoriesForEvent(event = {}) {
  const type = normalizeClinicalEventType(event);
  return DIRECT_RETRIEVAL_FEE_CATEGORIES_BY_EVENT_TYPE[type] || new Set(["procedure_basic"]);
}

function allowedFeeCategorySet(value) {
  if (value instanceof Set) {
    return value;
  }
  return new Set(asArray(value).map((item) => String(item || "").trim()).filter(Boolean));
}

function allowedFeeCategoriesForTrace(value) {
  return [...allowedFeeCategorySet(value)].sort();
}

function filteredCandidateTrace(candidate = {}, reason = "") {
  const classified = classifyMedicalServiceCandidate(candidate);
  return {
    code: String(candidate.code || ""),
    name: candidate.name || candidate.displayName || candidate.baseName || candidate.shortName || "",
    feeCategory: classified.feeCategory,
    itemRole: classified.itemRole,
    reason
  };
}

function searchTraceSummary(query = "", search = {}) {
  return {
    query,
    outcome: search?.item?.code ? "matched" : search?.error ? "error" : "no_match",
    inspectedCount: Number(search?.inspectedCount || 0),
    selectedCode: search?.item?.code ? String(search.item.code) : "",
    filteredCandidates: asArray(search?.filteredCandidates).slice(0, 5),
    error: search?.error || ""
  };
}

function clinicalTraceEvent({
  stage = "unknown",
  event = {},
  categoryLabel = "",
  outcome = "",
  allowedFeeCategories = null,
  query = "",
  selected = null,
  searches = [],
  message = ""
} = {}) {
  return {
    traceId: `trace_${candidateIdPart([stage, event?.clinicalEventId || event?.clinical_event_id, outcome, query].join("_"))}`,
    stage,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    eventType: normalizeClinicalEventType(event),
    eventName: clinicalEventName(event),
    categoryLabel,
    outcome,
    allowedFeeCategories: allowedFeeCategoriesForTrace(allowedFeeCategories),
    query,
    selected,
    searches: asArray(searches),
    message
  };
}

function normalizeClinicalTrace(values = []) {
  const seen = new Set();
  const result = [];
  for (const trace of asArray(values).filter(Boolean)) {
    const key = trace.traceId || [
      trace.stage,
      trace.clinicalEventId,
      trace.eventName,
      trace.outcome,
      trace.query
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trace);
  }
  return result.slice(0, 120);
}

function billingCandidatesFromProcedureResult(event = {}, result = {}) {
  const procedureCodeSet = new Set(asArray(result?.procedureCodes).map((code) => String(code || "")));
  return asArray(result?.masterCandidates)
    .filter((candidate) => procedureCodeSet.has(String(candidate.masterCode || "")))
    .map((candidate) => ({
      billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, candidate.masterCode].join("_"))}`,
      clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
      masterCandidateId: candidate.masterCandidateId,
      candidateKind: "procedure",
      eligibilityStatus: "billable",
      safetyLevel: "safe_if_confirmed",
      code: candidate.masterCode,
      name: candidate.masterName,
      pointValue: candidate.points,
      feeCategory: candidate.feeCategory,
      itemRole: candidate.itemRole,
      generatedBy: candidate.generatedBy,
      source: "rule_engine_master_match"
    }));
}

function billingCandidatesFromMedicationResult(event = {}, result = {}) {
  if (!result?.order?.drug_code) {
    return [];
  }
  const candidate = asArray(result.masterCandidates).find((item) => item.masterCode === String(result.order.drug_code));
  return [{
    billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, result.order.drug_code].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterCandidateId: candidate?.masterCandidateId || "",
    candidateKind: "drug",
    eligibilityStatus: "billable",
    safetyLevel: "safe_if_confirmed",
    code: String(result.order.drug_code),
    name: candidate?.masterName || clinicalEventName(event),
    pointValue: candidate?.points || 0,
    source: "rule_engine_master_match"
  }];
}

function billingCandidatesFromMaterialResult(event = {}, result = {}) {
  if (!result?.input?.code) {
    return [];
  }
  const candidate = asArray(result.masterCandidates).find((item) => item.masterCode === String(result.input.code));
  return [{
    billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, result.input.code].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterCandidateId: candidate?.masterCandidateId || "",
    candidateKind: "material",
    eligibilityStatus: "billable",
    safetyLevel: "safe_if_confirmed",
    code: String(result.input.code),
    name: candidate?.masterName || clinicalEventName(event),
    pointValue: candidate?.points || 0,
    source: "rule_engine_master_match"
  }];
}

function billingCandidateFromProposal(event = {}, proposal = {}) {
  if (!proposal) {
    return null;
  }
  return {
    billingCandidateId: `bc_${candidateIdPart([event?.clinicalEventId, proposal.proposalId].join("_"))}`,
    clinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    masterCandidateId: "",
    candidateKind: "proposal",
    eligibilityStatus: "proposal",
    safetyLevel: "safe_if_confirmed",
    code: proposal.code || proposal.candidateLine?.code || "",
    name: proposal.title || clinicalEventName(event),
    pointValue: Number(proposal.potentialPoints || proposal.candidateLine?.points || 0),
    source: "rule_engine_proposal"
  };
}

function normalizeBillingCandidates(values = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of asArray(values).filter(Boolean)) {
    const key = [
      candidate.clinicalEventId,
      candidate.candidateKind,
      candidate.code,
      candidate.name
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result.slice(0, 80);
}

function normalizeCandidateProposals(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const key = [
      value.proposalId,
      value.code,
      value.candidateLine?.code,
      value.title
    ].map((part) => String(part || "").trim()).filter(Boolean).join("|");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function outpatientBasicFromStructuredVisit(visitType = {}, text = "") {
  const kind = String(visitType?.kind || "").trim();
  const evidence = normalizeClinicalText(visitType?.evidence || "");
  if (!["initial", "revisit"].includes(kind) || !evidence) {
    return null;
  }
  if (isNegatedContext(evidence) || isFutureOrOrderOnlyContext(evidence)) {
    return null;
  }
  if (kind === "initial" && /(初診|初回受診|初めて|初来院)/u.test(evidence)) {
    return { fee_kind: "initial" };
  }
  if (kind === "revisit" && /(再診|再来|フォロー|経過観察)/u.test(evidence) && isCurrentVisitEvidence(evidence)) {
    return { fee_kind: "revisit" };
  }
  return null;
}

function inferOutpatientBasicOptions(text) {
  for (const sentence of splitClinicalSentences(text)) {
    if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence)) {
      continue;
    }
    if (/(初診|初回受診|初めて|初来院)/u.test(sentence)) {
      return { fee_kind: "initial" };
    }
    if (/(再診|再来|フォロー|経過観察|再評価)/u.test(sentence) && isCurrentVisitEvidence(sentence)) {
      return { fee_kind: "revisit" };
    }
  }
  return null;
}

function inferInpatientBasicOptions(text = "", session = {}) {
  const normalizedText = normalizeClinicalText(text);
  if (!isInpatientEncounter(session, normalizedText)) {
    return {
      inferred: {},
      reviewWarnings: []
    };
  }

  if (hasDpcContext(normalizedText, session)) {
    return {
      inferred: {},
      reviewWarnings: [
        "DPC対象またはDPC確認が必要な入院です。出来高の入院基本料は自動候補化せず、DPCレビューとして確認してください。"
      ]
    };
  }

  const acuteGeneral = acuteGeneralInpatientBasicFromText(normalizedText);
  if (!acuteGeneral) {
    return {
      inferred: {},
      reviewWarnings: [
        "入院診療の記載があります。入院基本料の種別、施設基準、算定日数を確認してください。"
      ]
    };
  }

  return {
    inferred: {
      inpatient_basic: {
        basic_fee_code: acuteGeneral.basicFeeCode,
        basic_fee_days: acuteGeneral.days,
        facility_standard_key: "一般入院"
      },
      facility_standard_keys: ["一般入院"]
    },
    reviewWarnings: [
      "急性期一般入院料をカルテ本文から候補化しました。施設基準、病棟、算定日数を確認してください。"
    ]
  };
}

function acuteGeneralInpatientBasicFromText(text = "") {
  const normalizedText = normalizeClinicalText(text);
  const match = normalizedText.match(/急性期一般入院料\s*([1-6])/u);
  const kind = match?.[1] || "";
  const basicFeeCode = ACUTE_GENERAL_INPATIENT_BASIC_CODES[kind];
  if (!basicFeeCode) {
    return null;
  }
  return {
    basicFeeCode,
    days: inferInpatientBasicDays(normalizedText)
  };
}

function inferInpatientBasicDays(text = "") {
  const normalizedText = normalizeClinicalText(text);
  const explicitDays = normalizedText.match(/(?:として)?\s*(\d{1,2})\s*日分/u);
  if (explicitDays) {
    return clampInpatientDays(explicitDays[1]);
  }
  const dayOfAdmission = normalizedText.match(/入院\s*(\d{1,2})\s*日目/u);
  if (dayOfAdmission) {
    return clampInpatientDays(dayOfAdmission[1]);
  }
  return 1;
}

function clampInpatientDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 1) {
    return 1;
  }
  return Math.min(31, Math.floor(days));
}

function isInpatientEncounter(session = {}, text = "") {
  const setting = String(session?.setting || session?.encounter?.setting || "").trim().toLowerCase();
  if (setting === "inpatient") {
    return true;
  }
  if (setting === "outpatient") {
    return false;
  }
  return hasInpatientCareContext(text);
}

function hasInpatientCareContext(text = "") {
  const normalizedText = normalizeClinicalText(text);
  if (!normalizedText || NON_CURRENT_INPATIENT_CONTEXT_PATTERN.test(normalizedText)) {
    return false;
  }
  return STRONG_INPATIENT_CONTEXT_PATTERN.test(normalizedText);
}

function hasDpcContext(text = "", session = {}) {
  const normalizedText = normalizeClinicalText(text);
  if (DPC_CONTEXT_PATTERN.test(normalizedText)) {
    return true;
  }
  const dpcOptions = [
    session?.dpc,
    session?.calculationOptions?.dpc,
    session?.claimContext?.dpc,
    session?.encounter?.dpc
  ].filter(isPlainObject);
  return dpcOptions.some((option) => (
    Boolean(option.dpc_claim)
    || Boolean(option.dpcCode)
    || Boolean(option.dpc_code)
    || Boolean(option.classification_code)
  ));
}

function inferOutpatientBasicFromPatientHistory({
  session = {},
  priorSessions = [],
  diagnoses = [],
  currentOutpatientBasic = null
} = {}) {
  if (!session.patientId) {
    return {
      outpatientBasic: currentOutpatientBasic || null,
      reviewWarnings: ["患者IDがないため、過去受診履歴に基づく初診/再診判定ができません。"]
    };
  }

  const currentDiagnosisNames = diagnosisNames(diagnoses);
  const usablePriorSessions = asArray(priorSessions)
    .filter((prior) => prior && prior.feeSessionId !== session.feeSessionId);

  const historyBasedBasic = usablePriorSessions.length
    ? { fee_kind: "revisit" }
    : { fee_kind: "initial" };
  const reviewWarnings = [];

  if (currentOutpatientBasic?.fee_kind && currentOutpatientBasic.fee_kind !== historyBasedBasic.fee_kind) {
    if (historyBasedBasic.fee_kind === "revisit") {
      reviewWarnings.push("同一患者の過去算定記録があるため再診料候補を優先しています。新疾患初診として扱う場合は手動で確認してください。");
    } else {
      reviewWarnings.push("同一患者の過去算定記録が見つからないため初診料候補を優先しています。過去受診履歴がある場合は手動で確認してください。");
    }
    return {
      outpatientBasic: historyBasedBasic,
      reviewWarnings
    };
  }

  if (usablePriorSessions.length) {
    const priorDiagnosisNames = diagnosisNames(usablePriorSessions.flatMap((prior) => asArray(prior.diagnoses)));
    if (!currentDiagnosisNames.length) {
      reviewWarnings.push("同一患者の過去算定記録があるため再診料候補を立てています。病名が未入力のため、継続診療か新疾患初診かを確認してください。");
    } else if (priorDiagnosisNames.length && !hasRelatedDiagnosisName(currentDiagnosisNames, priorDiagnosisNames)) {
      reviewWarnings.push("同一患者の過去算定記録があるため再診料候補を立てています。過去病名と今回病名の継続性を確認してください。");
    }
  }

  return {
    outpatientBasic: currentOutpatientBasic || historyBasedBasic,
    reviewWarnings
  };
}

function diagnosisNames(values = []) {
  return normalizeClinicalDiagnoses(values)
    .map((diagnosis) => diagnosis.name)
    .filter(Boolean);
}

function hasRelatedDiagnosisName(currentNames = [], priorNames = []) {
  const currentKeys = currentNames.map(normalizeDiagnosisMatchKey).filter(Boolean);
  const priorKeys = priorNames.map(normalizeDiagnosisMatchKey).filter(Boolean);
  return currentKeys.some((current) => priorKeys.some((prior) => (
    current.includes(prior)
    || prior.includes(current)
    || shareDiagnosisToken(current, prior)
  )));
}

function inferPediatricAddOnReviewWarnings({ session = {}, text = "", outpatientBasic = null } = {}) {
  if (!outpatientBasic?.fee_kind || isInpatientEncounter(session, text)) {
    return [];
  }
  const age = patientAgeOnServiceDate(session);
  const normalizedText = normalizeClinicalText(text);
  const explicitlyMentioned = /乳幼児|幼児|小児加算|乳幼児加算|小児科外来診療料/u.test(normalizedText);
  if (!(Number.isFinite(age) && age < 6) && !explicitlyMentioned) {
    return [];
  }
  return [
    "小児加算の確認: 患者年齢またはカルテ記載から小児加算の対象になり得ます。初診/再診、受付時刻、時間外・休日・深夜、施設区分を確認してください。"
  ];
}

function patientAgeOnServiceDate(session = {}) {
  const serviceDate = parseDateOnly(session?.serviceDate || session?.encounter?.serviceDate);
  const birthDate = parseDateOnly(
    session?.patientSnapshot?.birthDate
    || session?.patient?.birthDate
    || session?.patientBirthDate
  );
  if (!serviceDate || !birthDate || birthDate > serviceDate) {
    return Number.NaN;
  }
  let age = serviceDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const serviceMonth = serviceDate.getUTCMonth();
  const birthMonth = birthDate.getUTCMonth();
  if (
    serviceMonth < birthMonth
    || (serviceMonth === birthMonth && serviceDate.getUTCDate() < birthDate.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

function parseDateOnly(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function normalizeDiagnosisMatchKey(value) {
  return String(value || "")
    .replace(/疑い|の可能性|可能性|急性|慢性|症|病|疾患|障害|[\s（）()・、,]/gu, "")
    .trim()
    .toLowerCase();
}

function shareDiagnosisToken(left, right) {
  if (left.length < 3 || right.length < 3) {
    return false;
  }
  for (let index = 0; index <= left.length - 3; index += 1) {
    if (right.includes(left.slice(index, index + 3))) {
      return true;
    }
  }
  return false;
}

function ctEquipmentKindFromText(value = "") {
  const text = normalizeClinicalText(value);
  for (const { kind, pattern } of CT_EQUIPMENT_KIND_PATTERNS) {
    if (pattern.test(text)) {
      return kind;
    }
  }
  return "";
}

function mriEquipmentKindFromText(value = "") {
  const text = normalizeClinicalText(value);
  for (const { kind, pattern } of MRI_EQUIPMENT_KIND_PATTERNS) {
    if (pattern.test(text)) {
      return kind;
    }
  }
  return "";
}

function clinicalEventEquipmentKind(event = {}, imagingKind = "") {
  const explicit = [
    event?.equipment_kind,
    event?.equipmentKind,
    event?.ct_equipment_kind,
    event?.ctEquipmentKind,
    event?.mri_equipment_kind,
    event?.mriEquipmentKind,
    event?.payload?.equipment_kind,
    event?.payload?.equipmentKind,
    event?.payload?.ct_equipment_kind,
    event?.payload?.ctEquipmentKind,
    event?.payload?.mri_equipment_kind,
    event?.payload?.mriEquipmentKind
  ].map((value) => String(value || "").trim()).find(Boolean);
  if (explicit) {
    return normalizeImagingEquipmentKind(explicit, imagingKind);
  }
  const evidence = clinicalEventEvidence(event);
  return imagingKind === "ct" ? ctEquipmentKindFromText(evidence) : mriEquipmentKindFromText(evidence);
}

function normalizeImagingEquipmentKind(value = "", imagingKind = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  const known = new Set([
    "multislice_4_to_16",
    "multislice_16_to_64",
    "multislice_64_to_128",
    "multislice_128_or_more",
    "three_tesla",
    "one_point_five_tesla",
    "other"
  ]);
  if (known.has(normalized)) {
    return normalized;
  }
  return imagingKind === "ct" ? ctEquipmentKindFromText(normalized) : mriEquipmentKindFromText(normalized);
}

function inferImagingOrders(text) {
  const orders = [];
  const reviewWarnings = [];
  const sentences = splitClinicalSentences(text);

  for (const sentence of sentences) {
    if (isNegatedClinicalServiceContext(sentence)) {
      continue;
    }
    if (/(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])|ＭＲＩ/u.test(sentence)) {
      if (isFutureOrOrderOnlyContext(sentence)) {
        reviewWarnings.push("MRI検査は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は撮影内容を確認してください。");
      } else if (isPerformedImagingContext(sentence, "mri")) {
        const equipmentKind = mriEquipmentKindFromText(sentence);
        const order = {
          kind: "mri",
          contrast: hasLocalContrastContext(sentence, "mri"),
          electronic_image_management: true
        };
        if (equipmentKind) {
          order.mri_equipment_kind = equipmentKind;
        } else {
          reviewWarnings.push("MRI検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
        }
        orders.push(order);
      }
      continue;
    }
    if (/(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u.test(sentence)) {
      if (isFutureOrOrderOnlyContext(sentence)) {
        reviewWarnings.push("CT検査は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は撮影内容を確認してください。");
      } else if (isPerformedImagingContext(sentence, "ct")) {
        const equipmentKind = ctEquipmentKindFromText(sentence);
        const order = {
          kind: "ct",
          contrast: hasLocalContrastContext(sentence, "ct"),
          electronic_image_management: true
        };
        if (equipmentKind) {
          order.ct_equipment_kind = equipmentKind;
        } else {
          reviewWarnings.push("CT検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
        }
        orders.push(order);
      }
      continue;
    }
    if (/(X線|Ｘ線|レントゲン|単純撮影)/u.test(sentence)) {
      if (isFutureOrOrderOnlyContext(sentence)) {
        reviewWarnings.push("単純X線は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は撮影内容を確認してください。");
      } else if (isPerformedImagingContext(sentence, "simple_radiography")) {
        orders.push({
          kind: "simple_radiography",
          acquisition_kind: "digital",
          radiography_diagnostic_kind: "simple_i",
          electronic_image_management: true
        });
        reviewWarnings.push("単純X線は撮影方式・写真診断区分がカルテ本文から完全には確定できないため、デジタル/写真診断イとして候補化しています。請求前に確認してください。");
      }
    }
  }

  return {
    orders: dedupeObjects(orders),
    reviewWarnings
  };
}

function isPerformedObjectiveFinding(sentence) {
  return /(:|：|所見|結果|高値|低値|基準値|貯留|病変|あり|認める|施行|実施|検査|撮影|テスト|クラス|\+{1,4}|陽性|陰性)/u.test(sentence);
}

async function inferMedicationOrders(text, feeCalculator) {
  const orders = [];
  const reviewWarnings = [];
  if (typeof feeCalculator?.searchMaster !== "function") {
    return { orders, reviewWarnings };
  }

  for (const candidate of medicationNameCandidatesFromClinicalText(text)) {
    const sentence = candidate.sentence;
    const query = candidate.query;
    if (!sentence) {
      continue;
    }
    if (isHistoricalMedicationContext(sentence)) {
      continue;
    }
    if (!isCurrentPrescriptionContext(sentence)) {
      reviewWarnings.push(`薬剤「${query}」は今回処方として確定できないため、算定候補には入れていません。`);
      continue;
    }
    const quantity = inferMedicationQuantity(sentence, query);
    if (!hasCalculableMedicationQuantity(quantity)) {
      reviewWarnings.push(`薬剤「${query}」は数量または日数が不足しているため、算定候補には入れていません。`);
      continue;
    }
    const item = await searchFirstMasterItem(feeCalculator, "drug", query, "drug");
    if (!item?.code) {
      reviewWarnings.push(`薬剤「${query}」をマスターコードへ解決できませんでした。`);
      continue;
    }
    orders.push({
      drug_code: String(item.code),
      ...quantity,
      dispensing_kind: "internal_or_prn"
    });
  }
  return {
    orders: dedupeObjects(orders, (item) => item.drug_code),
    reviewWarnings
  };
}

function medicationNameCandidatesFromClinicalText(text = "") {
  const seen = new Set();
  const result = [];
  for (const sentence of splitClinicalSentences(text)) {
    if (!isMedicationCandidateSentence(sentence)) {
      continue;
    }
    for (const rawName of extractMedicationNameCandidates(sentence)) {
      const query = canonicalMedicationName(rawName);
      if (!query || query.length < 2 || isMedicationNameNoise(query)) {
        continue;
      }
      const key = query.replace(/\s+/gu, "").toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ query, sentence });
    }
  }
  return result.slice(0, 12);
}

function isMedicationCandidateSentence(sentence = "") {
  return /(処方|内服|外用|投与|注射|点滴|開始|追加|増量|変更|切り替え|継続|頓服|日分|mg|ｍｇ|錠|カプセル|軟膏|クリーム|テープ|ローション|配合錠)/u.test(sentence)
    && !/(検討のみ|適応検討|説明のみ|指導のみ|中止|終了のみ)/u.test(sentence);
}

function extractMedicationNameCandidates(sentence = "") {
  const normalized = String(sentence || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  const candidates = [];
  const patterns = [
    /([一-龥ァ-ヶーA-Za-z0-9]+(?:配合錠|錠|カプセル|軟膏|クリーム|テープ|ローション|散|顆粒|シロップ|注射液|点眼液|内服液|液))/gu,
    /([一-龥ァ-ヶーA-Za-z][一-龥ァ-ヶーA-Za-z0-9]{1,32})(?=\s*\d+(?:\.\d+)?\s*(?:mg|g|μg|mcg|mL|ml|%))/giu,
    /(?:併用|追加|変更|切り替え|処方)[:：]\s*([一-龥ァ-ヶーA-Za-z0-9]{2,32})/gu,
    /(?:処方|内服|外用|投与|開始|追加|変更|切り替え|継続|頓服)[:：]?\s*([^。、\n「」]{2,42})/gu
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = String(match[1] || "").trim();
      if (value) candidates.push(value);
    }
  }
  return uniqueStrings(candidates);
}

function inferMedicationQuantity(text, query) {
  const normalizedText = String(text || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  const normalizedQuery = String(query || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  const index = normalizedText.indexOf(normalizedQuery);
  const nearby = index >= 0 ? normalizedText.slice(index, index + 100) : normalizedText;
  const days = nearby.match(/(\d+)\s*日分/u)?.[1];
  const perDay = nearby.match(/(?:毎食後|毎食|1日|１日)\s*(\d+)\s*(?:錠|枚|包|回)?/u)?.[1]
    || nearby.match(/(\d+)\s*(?:錠|枚|包)\s*[/／]\s*日/u)?.[1];
  const totalQuantity = nearby.match(/総量\s*(\d+(?:\.\d+)?)/u)?.[1];
  return {
    ...(totalQuantity ? { total_quantity: totalQuantity } : {}),
    ...(perDay ? { quantity_per_day: perDay } : {}),
    ...(days ? { days } : {})
  };
}

function hasCalculableMedicationQuantity(quantity = {}) {
  return Boolean(quantity.total_quantity || (quantity.quantity_per_day && quantity.days));
}

function inferMedicationDeliveryKind(text) {
  if (/(院外|処方箋|院外処方)/u.test(text)) {
    return "outside_prescription";
  }
  return "in_house";
}

async function inferMaterialInputs(text, feeCalculator) {
  const inputs = [];
  const reviewWarnings = [];
  if (typeof feeCalculator?.searchMaster !== "function") {
    return { inputs, reviewWarnings };
  }
  for (const candidate of materialNameCandidatesFromClinicalText(text)) {
    const sentence = candidate.sentence;
    const query = candidate.query;
    if (!sentence) {
      continue;
    }
    if (!isCurrentMaterialUseContext(sentence)) {
      reviewWarnings.push(`特定器材・材料「${query}」は今回使用として確定できないため、算定候補には入れていません。`);
      continue;
    }
    const item = await searchFirstMasterItem(feeCalculator, "material", query, "material");
    if (!item?.code) {
      reviewWarnings.push(`特定器材・材料「${query}」をマスターコードへ解決できませんでした。`);
      continue;
    }
    inputs.push({ code: String(item.code), quantity: "1" });
  }
  return {
    inputs: dedupeObjects(inputs, (item) => item.code),
    reviewWarnings
  };
}

function materialNameCandidatesFromClinicalText(text = "") {
  const seen = new Set();
  const result = [];
  for (const sentence of splitClinicalSentences(text)) {
    if (!/(材料|特定器材|使用|装着|保護|固定|交換|シーネ|包帯|カテーテル|ドレーン|フィルム|パッド)/u.test(sentence)) {
      continue;
    }
    const matches = sentence.matchAll(/([一-龥ァ-ヶーA-Za-z0-9]+(?:シーネ|包帯|カテーテル|ドレーン|チューブ|フィルム|パッド))/gu);
    for (const match of matches) {
      const query = String(match[1] || "").trim();
      if (!query || /(湿布|貼付薬)$/u.test(query)) {
        continue;
      }
      const key = query.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ query, sentence });
    }
  }
  return result.slice(0, 8);
}

function buildFeeSessionContext(session = {}) {
  return {
    patientDisplayName: session.patientSnapshot?.displayName || "",
    facilityName: session.facilitySnapshot?.displayName || "",
    departmentName: session.departmentSnapshot?.displayName || "",
    serviceDate: session.serviceDate || "",
    billingMonth: session.billingMonth || session.claimMonth || "",
    claimMonth: session.claimMonth || session.billingMonth || "",
    visitType: session.visitType || "",
    diagnoses: String(session.diagnosesSource || "").trim() === "manual" ? asArray(session.diagnoses)
      .map((diagnosis) => diagnosis?.name || diagnosis?.displayName || diagnosis)
      .map((name) => String(name || "").trim())
      .filter(Boolean)
      .slice(0, 20) : []
  };
}

function diagnosesFromClinicalFacts(facts = {}) {
  return normalizeClinicalDiagnoses(asArray(facts?.diagnoses)
    .map((diagnosis) => {
      const name = cleanClinicalDiagnosisName(diagnosis?.name || diagnosis?.displayName || diagnosis);
      if (!name) {
        return null;
      }
      const status = normalizeDiagnosisStatus(diagnosis?.status);
      if (!isUsableClinicalDiagnosisStatus(status)) {
        return null;
      }
      return {
        name,
        ...(status ? { status } : {})
      };
    })
    .filter(Boolean));
}

function clinicalEventsFromClinicalFacts(facts = {}) {
  const sourceEvents = asArray(facts?.clinical_events).length
    ? asArray(facts.clinical_events)
    : asArray(facts?.billing_events);
  return sourceEvents
    .map((event, index) => normalizeClinicalEvent(event, index))
    .filter(Boolean);
}

function normalizeClinicalEventsForResult(values = []) {
  const seen = new Set();
  const result = [];
  for (const [index, event] of asArray(values).filter(Boolean).entries()) {
    const normalized = normalizeClinicalEvent(event, index);
    if (!normalized) {
      continue;
    }
    const key = [
      normalized.clinicalEventId,
      normalized.type,
      normalized.name,
      normalized.actionStatus,
      normalized.temporalRelation,
      normalized.providerOwnership,
      normalized.evidence
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      clinicalEventId: normalized.clinicalEventId,
      type: normalized.type,
      name: normalized.name,
      actionStatus: normalized.actionStatus,
      temporalRelation: normalized.temporalRelation,
      sourceOrigin: normalized.sourceOrigin,
      providerOwnership: normalized.providerOwnership,
      resultAssertion: normalized.resultAssertion,
      certainty: normalized.certainty,
      section: normalized.section,
      evidence: normalized.evidence,
      modality: normalized.modality,
      bodySite: normalized.body_site,
      areaSizeCm2: normalized.area_size_cm2,
      quantityPerDay: normalized.quantity_per_day,
      days: normalized.days,
      totalQuantity: normalized.total_quantity,
      searchTerms: clinicalEventSearchQueries(normalized),
      reviewReason: normalized.review_reason
    });
  }
  return result.slice(0, 120);
}

function excludedClinicalEventsFromClinicalFacts(facts = {}) {
  return asArray(facts?.excluded_events)
    .map((event, index) => normalizeClinicalEvent(event, index, { excluded: true }))
    .filter(Boolean);
}

function normalizeClinicalEvent(event = {}, index = 0, { excluded = false } = {}) {
  if (!isPlainObject(event)) {
    return null;
  }
  const type = normalizeClinicalEventType(event);
  const name = clinicalEventName(event);
  if (!name && !type) {
    return null;
  }
  const actionStatus = normalizeClinicalEventActionStatus(event, { excluded });
  const temporalRelation = normalizeClinicalEventTemporalRelation(event, { actionStatus });
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  const sourceOrigin = normalizeClinicalEventSourceOrigin(event, { providerOwnership, temporalRelation });
  const resultAssertion = normalizeClinicalEventResultAssertion(event);
  const certainty = normalizeClinicalEventCertainty(event);
  const clinicalEventId = String(event?.clinical_event_id || event?.clinicalEventId || event?.event_id || event?.eventId || "")
    || `ce_${index + 1}_${candidateIdPart([type, name, clinicalEventEvidence(event)].join("_"))}`;
  const legacyStatus = legacyStatusFromClinicalEvent({
    actionStatus,
    temporalRelation,
    providerOwnership,
    originalStatus: event?.status
  });
  return {
    ...event,
    clinicalEventId,
    clinical_event_id: clinicalEventId,
    type,
    name,
    actionStatus,
    action_status: actionStatus,
    temporalRelation,
    temporal_relation: temporalRelation,
    sourceOrigin,
    source_origin: sourceOrigin,
    providerOwnership,
    provider_ownership: providerOwnership,
    resultAssertion,
    result_assertion: resultAssertion,
    certainty,
    status: legacyStatus,
    date_relation: legacyDateRelationFromClinicalEvent({ temporalRelation, providerOwnership }),
    section: normalizeClinicalSection(event?.section),
    evidence: String(event?.evidence || "").trim(),
    search_queries: uniqueStrings([
      ...asArray(event?.search_queries),
      ...asArray(event?.searchQueries)
    ]),
    modality: String(event?.modality || "none").trim() || "none",
    body_site: String(event?.body_site || event?.bodySite || "").trim(),
    quantity_per_day: String(event?.quantity_per_day || event?.quantityPerDay || "").trim(),
    days: String(event?.days || "").trim(),
    total_quantity: String(event?.total_quantity || event?.totalQuantity || "").trim(),
    area_size_cm2: String(event?.area_size_cm2 || event?.areaSizeCm2 || "").trim(),
    review_reason: String(event?.review_reason || event?.reviewReason || event?.reason || "").trim()
  };
}

function normalizeClinicalEventActionStatus(event = {}, { excluded = false } = {}) {
  const explicit = String(event?.action_status || event?.actionStatus || "").trim();
  if ([
    "performed",
    "prescribed",
    "administered",
    "ordered",
    "planned",
    "considered",
    "instruction_only",
    "not_performed",
    "unknown"
  ].includes(explicit)) {
    return explicit;
  }

  const legacy = String(event?.status || "").trim();
  if (["performed", "prescribed", "administered", "planned", "ordered", "considered", "instruction_only"].includes(legacy)) {
    return legacy;
  }
  if (legacy === "negated") {
    return "not_performed";
  }
  if (legacy === "history" || legacy === "other_provider") {
    return "performed";
  }
  if (excluded) {
    return "unknown";
  }
  return legacy === "unclear" ? "unknown" : "unknown";
}

function normalizeClinicalEventTemporalRelation(event = {}, { actionStatus = "" } = {}) {
  const explicit = String(event?.temporal_relation || event?.temporalRelation || "").trim();
  if (["current_visit", "same_day_but_unknown", "past", "future", "unknown"].includes(explicit)) {
    return explicit;
  }
  const legacy = String(event?.date_relation || event?.dateRelation || "").trim();
  if (legacy === "current_visit") return "current_visit";
  if (legacy === "future") return "future";
  if (legacy === "past" || legacy === "other_provider") return "past";
  const status = String(event?.status || "").trim();
  if (["planned", "ordered", "considered"].includes(actionStatus) || ["planned", "ordered", "considered"].includes(status)) {
    return "future";
  }
  if (status === "history" || status === "other_provider") {
    return "past";
  }
  if (["performed", "prescribed", "administered"].includes(actionStatus)) {
    return "current_visit";
  }
  return "unknown";
}

function normalizeClinicalEventSourceOrigin(event = {}, { providerOwnership = "", temporalRelation = "" } = {}) {
  const explicit = String(event?.source_origin || event?.sourceOrigin || "").trim();
  if ([
    "own_clinic_record",
    "patient_reported",
    "external_document",
    "carried_in_result",
    "other_provider_record",
    "unknown"
  ].includes(explicit)) {
    return explicit;
  }
  const text = clinicalEventEvidence(event);
  if (providerOwnership === "other_provider" || /他院|前医|かかりつけ|紹介元/u.test(text)) {
    return "other_provider_record";
  }
  if (/持参|健診結果|外部資料/u.test(text)) {
    return "carried_in_result";
  }
  if (temporalRelation === "past") {
    return "patient_reported";
  }
  return "own_clinic_record";
}

function normalizeClinicalEventResultAssertion(event = {}) {
  const explicit = String(event?.result_assertion || event?.resultAssertion || "").trim();
  if (["positive", "negative", "normal", "abnormal", "numeric", "not_applicable", "unknown"].includes(explicit)) {
    return explicit;
  }
  const text = clinicalEventEvidence(event);
  if (/[<>]?\d+(?:\.\d+)?\s*(?:%|％|mg\/?dL|IU\/?mL|U\/?mL|mmHg|cm|mm|\/μL|\/uL)/iu.test(text)) {
    return "numeric";
  }
  if (/陰性|なし|異常なし|正常範囲|正常/u.test(text)) {
    return /異常なし|正常/u.test(text) ? "normal" : "negative";
  }
  if (/陽性|高値|低値|異常|あり|認める/u.test(text)) {
    return "abnormal";
  }
  return "unknown";
}

function normalizeClinicalEventCertainty(event = {}) {
  const explicit = String(event?.certainty || "").trim();
  if (["explicit", "inferred", "ambiguous"].includes(explicit)) {
    return explicit;
  }
  const text = clinicalEventEvidence(event);
  if (/疑い|可能性|示唆|検討|かもしれない/u.test(text)) {
    return "ambiguous";
  }
  if (text) {
    return "explicit";
  }
  return "ambiguous";
}

function normalizeClinicalSection(value) {
  const section = String(value || "unknown").trim().toUpperCase();
  return ["S", "O", "A", "P"].includes(section) ? section : "unknown";
}

function legacyStatusFromClinicalEvent({
  actionStatus = "",
  temporalRelation = "",
  providerOwnership = "",
  originalStatus = ""
} = {}) {
  const original = String(originalStatus || "").trim();
  if (["performed", "prescribed", "administered", "planned", "ordered", "considered", "instruction_only", "history", "other_provider", "negated", "unclear"].includes(original)) {
    if (["history", "other_provider", "negated", "unclear"].includes(original)) {
      return original;
    }
  }
  if (providerOwnership === "other_provider") return "other_provider";
  if (temporalRelation === "past") return "history";
  if (actionStatus === "not_performed") return "negated";
  if (["performed", "prescribed", "administered", "planned", "ordered", "considered", "instruction_only"].includes(actionStatus)) {
    return actionStatus;
  }
  return "unclear";
}

function legacyDateRelationFromClinicalEvent({ temporalRelation = "", providerOwnership = "" } = {}) {
  if (providerOwnership === "other_provider") return "other_provider";
  if (temporalRelation === "future") return "future";
  if (temporalRelation === "past") return "past";
  if (temporalRelation === "current_visit" || temporalRelation === "same_day_but_unknown") return "current_visit";
  return "unknown";
}

function cleanClinicalDiagnosisName(value) {
  const name = String(value || "")
    .replace(/^\s*(?:病名|診断名)\s*[:：]\s*/u, "")
    .trim()
    .slice(0, 120);
  if (isClinicalFindingNotDiagnosis(name)) {
    return "";
  }
  return name;
}

function isClinicalFindingNotDiagnosis(value) {
  const text = normalizeClinicalText(value)
    .replace(/\s+/gu, "");
  if (!text) {
    return false;
  }
  if (/(高値|低値|陽性|陰性|基準値|結果|[<>]?\d+(?:\.\d+)?\s*(?:U\/?mL|IU\/?mL|mg\/?dL|ng\/?mL|pg\/?mL|%|％|\/μL|\/uL))/iu.test(text)
    && !/(炎|症|病|癌|腫瘍|不全|障害|嚢胞|症候群|疾患|異常)$/u.test(text)) {
    return true;
  }
  if (/^(?:血液検査|検査結果|検査値|所見)[:：]?/u.test(text)) {
    return true;
  }
  return false;
}

function normalizeClinicalDiagnoses(values = []) {
  const seen = new Set();
  const result = [];
  for (const diagnosis of asArray(values)) {
    const name = cleanClinicalDiagnosisName(diagnosis?.name || diagnosis?.displayName || diagnosis);
    if (!name) {
      continue;
    }
    const key = name.replace(/\s+/gu, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const status = normalizeDiagnosisStatus(diagnosis?.status);
    result.push({
      name,
      ...(status ? { status } : {})
    });
  }
  return result.slice(0, 20);
}

function normalizeDiagnosisStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["denied", "negated", "ruled_out", "family_history", "none"].includes(status)) {
    return "excluded";
  }
  if (["confirmed", "suspected", "history", "active"].includes(status)) {
    return status;
  }
  return "";
}

function isUsableClinicalDiagnosisStatus(status) {
  if (status === "excluded") {
    return false;
  }
  if (!status) {
    return true;
  }
  return ["confirmed", "suspected", "history", "active"].includes(status);
}

function normalizeClinicalEventType(event = {}) {
  return String(event?.type || "other").trim();
}

function normalizeClinicalEventStatus(event = {}) {
  return String(event?.status || legacyStatusFromClinicalEvent({
    actionStatus: event?.action_status || event?.actionStatus,
    temporalRelation: event?.temporal_relation || event?.temporalRelation,
    providerOwnership: event?.provider_ownership || event?.providerOwnership
  }) || "unclear").trim();
}

function isBillableClinicalEventStatus(status) {
  return ["performed", "prescribed", "administered"].includes(status);
}

function normalizeClinicalEventDateRelation(event = {}) {
  return legacyDateRelationFromClinicalEvent({
    temporalRelation: event?.temporal_relation || event?.temporalRelation || event?.date_relation || event?.dateRelation,
    providerOwnership: event?.provider_ownership || event?.providerOwnership
  });
}

function normalizeClinicalEventProviderOwnership(event = {}) {
  const value = String(event?.provider_ownership || event?.providerOwnership || "unknown").trim();
  if (value === "other_department") {
    return "same_institution_other_department";
  }
  return value;
}

function isBillableClinicalEvent(event = {}) {
  const actionStatus = String(event?.action_status || event?.actionStatus || normalizeClinicalEventStatus(event)).trim();
  if (!["performed", "prescribed", "administered"].includes(actionStatus)) {
    return false;
  }
  const temporalRelation = String(event?.temporal_relation || event?.temporalRelation || normalizeClinicalEventDateRelation(event)).trim();
  if (["future", "past"].includes(temporalRelation)) {
    return false;
  }
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  if (["same_institution_other_department", "other_provider"].includes(providerOwnership)) {
    return false;
  }
  return true;
}

function clinicalEventName(event = {}) {
  return String(event?.name || "").trim();
}

function clinicalEventEvidence(event = {}) {
  return [event?.evidence, event?.name, event?.review_reason]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function excludedClinicalEventWarning(event = {}) {
  const type = normalizeClinicalEventType(event);
  const status = normalizeClinicalEventStatus(event);
  const dateRelation = normalizeClinicalEventDateRelation(event);
  const providerOwnership = normalizeClinicalEventProviderOwnership(event);
  const name = clinicalEventName(event) || clinicalImagingDisplayName(event) || "項目";
  const reason = String(event?.reason || event?.review_reason || "").trim();

  if (type === "medication" && isMedicationNameNoise(name)) {
    return "";
  }
  if (["same_institution_other_department", "other_department", "other_provider"].includes(providerOwnership)) {
    return `${name}は他科・他院で管理または実施された内容として抽出されたため、今回の算定候補には入れていません。`;
  }
  if (["past", "other_provider"].includes(dateRelation)) {
    return `${name}は過去値・持参情報として抽出されたため、当日実施分としては算定候補に入れていません。`;
  }
  if (dateRelation === "future") {
    return `${name}は今後の予定として抽出されたため、今回の算定候補には入れていません。実施済みの場合は内容を確認してください。`;
  }
  if (type === "imaging" && ["planned", "ordered"].includes(status)) {
    return `${name}は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は内容を確認してください。`;
  }
  if (type === "medication" && status === "history") {
    return `薬剤「${name}」は既往薬・内服中として記載されているため、今回処方の算定候補には入れていません。`;
  }
  if (type === "medication" && ["planned", "ordered", "considered", "instruction_only", "unclear"].includes(status)) {
    return `薬剤「${name}」は今回処方として確定できないため、算定候補には入れていません。`;
  }
  if (type === "material" && status === "instruction_only") {
    return `特定器材・材料「${name}」は指導・説明のみとして記載されているため、算定候補には入れていません。`;
  }
  if (type === "material" && ["planned", "ordered", "considered", "unclear"].includes(status)) {
    return `特定器材・材料「${name}」は今回使用として確定できないため、算定候補には入れていません。`;
  }
  if (reason && ["planned", "ordered", "considered", "instruction_only", "history", "negated", "unclear"].includes(status)) {
    return reason;
  }
  return "";
}

function clinicalFactReviewWarnings(values = []) {
  return asArray(values)
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      const name = String(item?.name || item?.item || "").trim();
      const reason = String(item?.reason || item?.review_reason || item?.message || item?.detail || "").trim();
      if (name && reason && !reason.includes(name)) {
        return `${name}: ${reason}`;
      }
      return reason || name;
    })
    .filter(isActionableClinicalFactWarning)
    .filter(Boolean);
}

function isActionableClinicalFactWarning(warning) {
  const text = String(warning || "").trim();
  if (!text || /^(空欄|なし|無し|不明|未記載|確認事項)$/u.test(text)) {
    return false;
  }
  if (/文面から受診回数の明示なし/u.test(text)) {
    return false;
  }
  if (/初診\/再診の明記なし|初診・再診の明記なし|診療形態.*明記なし/u.test(text)) {
    return false;
  }
  if (/(billingMonth|claimMonth|請求月).*(未指定|未記載|不明)/iu.test(text)) {
    return false;
  }
  if (/適応検討のみで実施の記載なし/u.test(text)) {
    return false;
  }
  if (/(数量|日数|回数|総量).*(明記なし|不足|不明)/u.test(text) && !/[「:：]/u.test(text)) {
    return false;
  }
  return true;
}

function unsupportedClinicalEventWarning(event = {}) {
  const type = normalizeClinicalEventType(event);
  const name = clinicalEventName(event) || "抽出項目";
  if (type === "lab") {
    return `${name}は検体検査として抽出しましたが、現在の自動算定では検査コード確定が未対応です。実施内容をマスター検索で確認してください。`;
  }
  if (type === "management") {
    return `${name}は医学管理等として抽出しましたが、現在の自動算定では管理料コード確定が未対応です。算定条件を確認してください。`;
  }
  if (type === "counseling") {
    return `${name}は指導・説明として抽出しましたが、現在の自動算定では算定可否の自動判定が未対応です。算定条件を確認してください。`;
  }
  if (type && type !== "other") {
    return `${name}は${clinicalEventTypeLabel(type)}として抽出しましたが、現在の自動算定では直接候補化できないため、要確認です。`;
  }
  return "";
}

function reviewIssueFromExcludedClinicalEvent(event = {}) {
  const messageForStaff = excludedClinicalEventWarning(event);
  if (!messageForStaff) {
    return null;
  }
  return {
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, clinicalEventName(event), messageForStaff].join("_"))}`,
    issueCode: reviewIssueCodeFromWarning(messageForStaff, event),
    severity: "warning",
    title: reviewIssueTitleFromWarning(messageForStaff, event),
    messageForStaff,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "clinical_event_rule"
  };
}

function reviewIssueFromUnsupportedClinicalEvent(event = {}) {
  const messageForStaff = unsupportedClinicalEventWarning(event);
  if (!messageForStaff) {
    return null;
  }
  return {
    reviewIssueId: `issue_${candidateIdPart([event?.clinicalEventId, clinicalEventName(event), messageForStaff].join("_"))}`,
    issueCode: "unsupported_event",
    severity: "warning",
    title: clinicalEventName(event) ? `${clinicalEventName(event)}の確認` : "確認事項",
    messageForStaff,
    relatedClinicalEventId: event?.clinicalEventId || event?.clinical_event_id || "",
    evidence: clinicalEventEvidence(event),
    source: "clinical_event_rule"
  };
}

function reviewIssueCodeFromWarning(message = "", event = {}) {
  const text = String(message || "");
  const status = normalizeClinicalEventStatus(event);
  if (/他科|他院/u.test(text)) return "other_provider";
  if (/過去値|持参/u.test(text)) return "past_or_carried_in";
  if (/予定|依頼|今後/u.test(text)) return "planned_not_performed";
  if (/数量|日数|総量|回数/u.test(text)) return "missing_quantity";
  if (/施設基準/u.test(text)) return "facility_unknown";
  if (["planned", "ordered", "considered"].includes(status)) return "planned_not_performed";
  if (status === "instruction_only") return "instruction_only";
  return "needs_review";
}

function reviewIssueTitleFromWarning(message = "", event = {}) {
  const text = String(message || "");
  if (/他科|他院/u.test(text)) return "他科・他院情報";
  if (/過去値|持参/u.test(text)) return "過去値・持参情報";
  if (/予定|依頼|今後/u.test(text)) return "実施確認";
  if (/数量|日数|総量|回数/u.test(text)) return "数量・日数の確認";
  if (/施設基準/u.test(text)) return "施設基準の確認";
  const name = clinicalEventName(event);
  return name ? `${name}の確認` : "確認事項";
}

function normalizeReviewIssues(values = []) {
  const seen = new Set();
  const result = [];
  for (const issue of asArray(values)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const key = [
      issue.issueCode,
      issue.relatedClinicalEventId,
      normalizeReviewTarget(issue.messageForStaff || issue.title || "")
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(issue);
  }
  return result.slice(0, 40);
}

function clinicalEventTypeLabel(type) {
  return {
    injection: "注射",
    rehabilitation: "リハビリ",
    surgery: "手術",
    home_care: "在宅",
    pathology: "病理",
    psychiatric: "精神科専門療法"
  }[String(type || "").trim()] || "未対応項目";
}

async function imagingOrderFromClinicalEvent(event = {}, feeCalculator) {
  const reviewWarnings = [];
  const procedureCodes = [];
  const kind = clinicalImagingKind(event);
  const evidence = clinicalEventEvidence(event);
  if (kind === "mri") {
    const equipmentKind = clinicalEventEquipmentKind(event, "mri");
    const order = {
      kind: "mri",
      contrast: hasLocalContrastContext(evidence, "mri"),
      electronic_image_management: true
    };
    if (equipmentKind) {
      order.mri_equipment_kind = equipmentKind;
    } else {
      reviewWarnings.push("MRI検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
    }
    return {
      order,
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings
    };
  }
  if (kind === "ct") {
    const equipmentKind = clinicalEventEquipmentKind(event, "ct");
    const order = {
      kind: "ct",
      contrast: hasLocalContrastContext(evidence, "ct"),
      electronic_image_management: true
    };
    if (equipmentKind) {
      order.ct_equipment_kind = equipmentKind;
    } else {
      reviewWarnings.push("CT検査は機器区分がカルテ本文から確定できないため、点数確定前に機器区分を確認してください。");
    }
    return {
      order,
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings
    };
  }
  if (kind === "simple_radiography") {
    reviewWarnings.push("単純X線は撮影方式・写真診断区分がカルテ本文から完全には確定できないため、デジタル/写真診断イとして候補化しています。請求前に確認してください。");
    return {
      order: {
        kind: "simple_radiography",
        acquisition_kind: "digital",
        radiography_diagnostic_kind: "simple_i",
        electronic_image_management: true
      },
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings
    };
  }

  if (kind === "ultrasound") {
    const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
      categoryLabel: "超音波検査",
      allowedFeeCategories: allowedDirectRetrievalFeeCategoriesForEvent(event),
      unresolvedMessage: `${clinicalEventName(event) || "超音波検査"}は超音波検査として抽出しましたが、標準コードを自動確定できませんでした。部位と検査内容をマスター検索で確認してください。`,
      resolvedMessage: `${clinicalEventName(event) || "超音波検査"}を実施済みとしてマスター候補に反映しました。部位・検査方法・算定条件を確認してください。`
    });
    return {
      order: null,
      procedureCodes: procedure.procedureCodes,
      commentInputs: procedure.commentInputs,
      collectionFeeInputs: procedure.collectionFeeInputs,
      masterCandidates: procedure.masterCandidates,
      reviewWarnings: procedure.reviewWarnings,
      traceEvents: procedure.traceEvents
    };
  }

  if (kind) {
    reviewWarnings.push(`${clinicalEventName(event) || clinicalImagingDisplayName(event)}は現在の算定ルールで直接候補化できないため、要確認です。`);
  }
  return { order: null, procedureCodes, commentInputs: [], collectionFeeInputs: [], masterCandidates: [], reviewWarnings };
}

function clinicalImagingKind(event = {}) {
  const modality = String(event?.modality || "").trim();
  if (["mri", "ct", "simple_radiography", "ultrasound"].includes(modality)) {
    return modality;
  }
  const text = clinicalEventEvidence(event);
  if (/(?:^|[^A-Za-z])MRI(?:$|[^A-Za-z])|ＭＲＩ/u.test(text)) return "mri";
  if (/(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u.test(text)) return "ct";
  if (/(X線|Ｘ線|レントゲン|単純撮影)/u.test(text)) return "simple_radiography";
  if (/(超音波|エコー)/u.test(text)) return "ultrasound";
  return modality && modality !== "none" ? modality : "";
}

function clinicalImagingDisplayName(event = {}) {
  const kind = clinicalImagingKind(event);
  if (kind === "mri") return "MRI検査";
  if (kind === "ct") return "CT検査";
  if (kind === "simple_radiography") return "単純X線";
  if (kind === "ultrasound") return "超音波検査";
  return "";
}

async function medicationOrderFromClinicalEvent(event = {}, feeCalculator) {
  const reviewWarnings = [];
  const rawName = clinicalEventName(event);
  if (isMedicationNameNoise(rawName)) {
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  const name = canonicalMedicationName(rawName);
  if (!name) {
    reviewWarnings.push("薬剤名がカルテ本文から確定できないため、薬剤算定候補には入れていません。");
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  const quantity = medicationQuantityFromClinicalEvent(event);
  if (!hasCalculableMedicationQuantity(quantity)) {
    reviewWarnings.push(`薬剤「${name}」は数量または日数が不足しているため、算定候補には入れていません。`);
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  const item = await searchFirstMasterItem(feeCalculator, "drug", name, "drug");
  if (!item?.code) {
    reviewWarnings.push(`薬剤「${name}」をマスターコードへ解決できませんでした。`);
    return { order: null, masterCandidates: [], reviewWarnings };
  }
  return {
    order: {
      drug_code: String(item.code),
      ...quantity,
      dispensing_kind: "internal_or_prn"
    },
    masterCandidates: [
      masterCandidateFromItem(item, event, {
        masterType: "drug",
        searchQuery: name
      })
    ].filter(Boolean),
    reviewWarnings
  };
}

function canonicalMedicationName(value) {
  let name = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .trim();
  if (!name) {
    return "";
  }
  if (isMedicationNameNoise(name)) {
    return "";
  }
  const parenthesized = name.match(/[（(]([^（）()]+)[）)]/u)?.[1];
  if (parenthesized && !/胃薬|湿布|頓服|併用|処方/u.test(parenthesized)) {
    name = parenthesized;
  }
  name = name
    .replace(/^(?:薬剤|処方薬)[:：]/u, "")
    .replace(/(?:錠|カプセル|配合錠|テープ|クリーム|軟膏|散|顆粒|シロップ).*$/u, (match) => {
      if (/^(?:錠|カプセル|配合錠|テープ|クリーム|軟膏|散|顆粒|シロップ)$/u.test(match)) {
        return match;
      }
      return "";
    })
    .replace(/\d+(?:\.\d+)?\s*(?:mg|g|μg|mcg|mL|ml|%|ｍｇ|ｇ|μｇ|ｍＬ|％).*$/iu, "")
    .replace(/[（(].*?[）)]/gu, "")
    .trim();
  return name;
}

function isMedicationNameNoise(value) {
  const text = String(value || "")
    .replace(/\s+/gu, "")
    .trim();
  if (!text) {
    return true;
  }
  return /^(?:再指導|終了|継続|増量検討|切り替え|説明|指導)$/u.test(text)
    || /指導|説明|検討|予定|予約|案内|許可|禁止|終了$/u.test(text);
}

function medicationQuantityFromClinicalEvent(event = {}) {
  const fromEvent = {
    ...(numericText(event?.total_quantity) ? { total_quantity: numericText(event.total_quantity) } : {}),
    ...(numericText(event?.quantity_per_day) ? { quantity_per_day: numericText(event.quantity_per_day) } : {}),
    ...(integerText(event?.days) ? { days: integerText(event.days) } : {})
  };
  if (hasCalculableMedicationQuantity(fromEvent)) {
    return fromEvent;
  }

  return {
    ...inferMedicationQuantity(clinicalEventEvidence(event), clinicalEventName(event)),
    ...fromEvent
  };
}

async function materialInputFromClinicalEvent(event = {}, feeCalculator) {
  const reviewWarnings = [];
  const name = clinicalEventName(event);
  if (!name) {
    reviewWarnings.push("特定器材・材料名がカルテ本文から確定できないため、算定候補には入れていません。");
    return { input: null, masterCandidates: [], reviewWarnings };
  }
  const item = await searchFirstMasterItem(feeCalculator, "material", name, "material");
  if (!item?.code) {
    reviewWarnings.push(`特定器材・材料「${name}」をマスターコードへ解決できませんでした。`);
    return { input: null, masterCandidates: [], reviewWarnings };
  }
  return {
    input: {
      code: String(item.code),
      quantity: numericText(event?.total_quantity) || numericText(event?.quantity_per_day) || "1"
    },
    masterCandidates: [
      masterCandidateFromItem(item, event, {
        masterType: "material",
        searchQuery: name
      })
    ].filter(Boolean),
    reviewWarnings
  };
}

function labCollectionFeeInputsFromClinicalEvent(event = {}, procedure = {}) {
  if (!asArray(procedure?.procedureCodes).length) {
    return [];
  }
  return hasExplicitBloodCollectionEvidence(event) ? ["blood_venous"] : [];
}

function hasExplicitBloodCollectionEvidence(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.specimen,
    event?.sample,
    event?.payload?.specimen
  ].filter(Boolean).join("\n"));
  return /採血|血液検査|血清|血漿|末梢血|静脈血/u.test(text);
}

function labRuleTraceEvents(event = {}, procedure = {}) {
  const procedureCodes = asArray(procedure?.procedureCodes).map((code) => String(code || "")).filter(Boolean);
  if (!procedureCodes.length) {
    return [];
  }
  const derived = [
    {
      kind: "lab_judgment_fee",
      generatedBy: "python.lab_rules.add_d026_judgement_fees",
      reason: "検査実施料コードから検査判断料を派生します。"
    },
    {
      kind: "lab_management_fee",
      generatedBy: "python.lab_rules.add_lab_management_fee",
      reason: "判断料と施設基準が確認できる場合のみ検体検査管理加算を派生します。"
    }
  ];
  if (hasExplicitBloodCollectionEvidence(event)) {
    derived.push({
      kind: "collection_fee_input",
      generatedBy: "clinical_event.lab_collection_input",
      input: "blood_venous",
      reason: "カルテに採血または血液検査の明示があるため、採血料の候補入力を渡します。"
    });
  }
  return [
    clinicalTraceEvent({
      stage: "lab_rule_expansion",
      event,
      categoryLabel: "検体検査",
      outcome: "prepared",
      message: "lab_derived_items_are_generated_by_python_rules",
      selected: {
        procedureCodes,
        derived
      }
    })
  ];
}

async function procedureCodesFromPerformedClinicalEvent(event = {}, feeCalculator, options = {}) {
  const status = normalizeClinicalEventStatus(event);
  if (!isBillableClinicalEventStatus(status)) {
    const warning = excludedClinicalEventWarning(event);
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings: warning ? [warning] : []
    };
  }

  const name = clinicalEventName(event);
  const categoryLabel = options.categoryLabel || "診療行為";
  const queries = clinicalEventSearchQueries(event, {
    categoryLabel,
    extraQueries: options.queries
  });
  return searchPerformedProcedureCode(feeCalculator, {
    event,
    name,
    categoryLabel,
    queries,
    allowedFeeCategories: options.allowedFeeCategories || allowedDirectRetrievalFeeCategoriesForEvent(event),
    resolvedMessage: options.resolvedMessage || `${name || categoryLabel}を実施済みの${categoryLabel}としてマスター候補に反映しました。算定条件を確認してください。`,
    unresolvedMessage: options.unresolvedMessage || `${name || categoryLabel}は実施済みの${categoryLabel}として抽出しましたが、標準コードを自動確定できませんでした。マスター検索で確認してください。`
  });
}

async function searchPerformedProcedureCode(feeCalculator, {
  event = {},
  name = "",
  categoryLabel = "診療行為",
  queries = [],
  allowedFeeCategories = null,
  resolvedMessage = "",
  unresolvedMessage = ""
} = {}) {
  if (typeof feeCalculator?.searchMaster !== "function") {
    const traceEvents = [clinicalTraceEvent({
      stage: "master_search",
      event,
      categoryLabel,
      outcome: "unavailable",
      allowedFeeCategories,
      message: "master_search_unavailable"
    })];
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      masterCandidates: [],
      reviewWarnings: [unresolvedMessage || `${name || categoryLabel}は実施済みとして検出しましたが、マスター検索を利用できません。`],
      traceEvents
    };
  }

  const normalizedQueries = uniqueStrings(queries).filter((query) => query.length >= 2).slice(0, 8);
  const searchTrace = [];
  for (const query of normalizedQueries) {
    const search = await searchProcedureMasterItem(feeCalculator, query, {
      name,
      categoryLabel,
      allowedFeeCategories
    });
    searchTrace.push(searchTraceSummary(query, search));
    if (search?.item?.code) {
      const item = search.item;
      const masterCandidate = masterCandidateFromItem(item, event, {
        masterType: "medical_service",
        searchQuery: query
      });
      return {
        procedureCodes: [String(item.code)],
        commentInputs: [],
        collectionFeeInputs: [],
        masterCandidates: [masterCandidate].filter(Boolean),
        reviewWarnings: [],
        traceEvents: [
          clinicalTraceEvent({
            stage: "master_search",
            event,
            categoryLabel,
            outcome: "matched",
            allowedFeeCategories,
            query,
            selected: masterCandidate,
            searches: searchTrace
          })
        ]
      };
    }
  }

  const traceEvents = [clinicalTraceEvent({
    stage: "master_search",
    event,
    categoryLabel,
    outcome: "unresolved",
    allowedFeeCategories,
    searches: searchTrace
  })];
  return {
    procedureCodes: [],
    commentInputs: [],
    collectionFeeInputs: [],
    masterCandidates: [],
    reviewWarnings: [unresolvedMessage || `${name || categoryLabel}は実施済みとして検出しましたが、標準コードを自動確定できませんでした。`],
    traceEvents
  };
}

async function searchProcedureMasterItem(feeCalculator, query, context = {}) {
  try {
    const result = await feeCalculator.searchMaster({ type: "procedure", query, limit: 5 });
    const items = Array.isArray(result?.items) ? result.items : [];
    const candidates = items.filter((item) => (
      item?.code
      && (
        item.kind === "procedure"
        || item.sourceType === "medical_procedure_master"
        || item.source === "medical_procedure_master"
      )
    ))
      .map((item) => annotateMedicalServiceCandidate(item));
    const filteredCandidates = [];
    for (const candidate of candidates) {
      const filterReason = directRetrievalFilterReason(candidate, context);
      if (filterReason) {
        filteredCandidates.push(filteredCandidateTrace(candidate, filterReason));
        continue;
      }
      if (isHighConfidenceProcedureMasterItem(candidate, { ...context, query })) {
        return {
          item: candidate,
          inspectedCount: candidates.length,
          filteredCandidates
        };
      }
    }
    return {
      item: null,
      inspectedCount: candidates.length,
      filteredCandidates
    };
  } catch (error) {
    return {
      item: null,
      inspectedCount: 0,
      filteredCandidates: [],
      error: "master_search_failed",
      message: error instanceof Error ? error.message : String(error || "")
    };
  }
}

function isHighConfidenceProcedureMasterItem(item = {}, { query = "", name = "", categoryLabel = "" } = {}) {
  const itemText = normalizeProcedureMatchText([
    item.name,
    item.baseName,
    item.displayName,
    item.shortName
  ].filter(Boolean).join(" "));
  const contextText = normalizeProcedureMatchText([query, name, categoryLabel].filter(Boolean).join(" "));
  if (!itemText || !contextText) {
    return false;
  }

  const queryKey = normalizeProcedureMatchText(query);
  const nameKey = normalizeProcedureMatchText(name);
  const queryTokens = procedureMatchTokens(query);
  const nameTokens = procedureMatchTokens(name);
  return Boolean(
    (queryKey && itemText.includes(queryKey))
    || (nameKey && itemText.includes(nameKey))
    || queryTokens.some((token) => token.length >= 3 && itemText.includes(token))
    || nameTokens.some((token) => token.length >= 3 && itemText.includes(token))
  );
}

function normalizeProcedureMatchText(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .replace(/[（）()・、,，.\-－ー]/gu, "")
    .toLowerCase();
}

function procedureMatchTokens(value = "") {
  return normalizeProcedureMatchText(value)
    .split(/(?:検査|測定|撮影|処置|管理料|指導料|料|法|術|血液|尿|眼|鼻|耳|皮膚|腹部|胸部)/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function clinicalEventSearchQueries(event = {}, { categoryLabel = "", extraQueries = [] } = {}) {
  const name = clinicalEventName(event);
  const evidence = clinicalEventEvidence(event);
  const bodySite = String(event?.body_site || event?.bodySite || "").trim();
  const modality = String(event?.modality || "").trim();
  const deterministicTerms = [
    name,
    bodySite && name ? `${bodySite}${name}` : "",
    modality && name ? `${modality} ${name}` : "",
    ...procedureMasterQueriesFromEvidence(evidence),
    ...clinicalEventAliasQueries(event),
    categoryLabel
  ];
  // LLM search phrases are only a fallback hint. Master search should primarily
  // follow normalized clinical-event attributes and evidence-derived terms.
  const llmHints = [
    ...(event?.search_terms?.primary ? [event.search_terms.primary] : []),
    ...asArray(event?.search_terms?.synonyms),
    ...(event?.searchTerms?.primary ? [event.searchTerms.primary] : []),
    ...asArray(event?.searchTerms?.synonyms),
    ...asArray(event?.searchQueries),
    ...asArray(event?.search_queries)
  ];
  return uniqueStrings([
    ...asArray(extraQueries),
    ...deterministicTerms,
    ...llmHints
  ]);
}

function clinicalEventAliasQueries(event = {}) {
  const type = normalizeClinicalEventType(event);
  if (type === "lab" || type === "exam") {
    return labAliasQueries(event);
  }
  if (type === "imaging") {
    return imagingAliasQueries(event);
  }
  return [];
}

function labAliasQueries(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    ...asArray(event?.payload?.analytes),
    ...asArray(event?.payload?.pathogenTargets),
    event?.payload?.method,
    event?.payload?.specimen
  ].filter(Boolean).join(" "));
  const queries = [];

  const hasCovid = /COVID|ＣＯＶＩＤ|SARS|ＳＡＲＳ|コロナ|新型コロナ/u.test(text);
  const hasInfluenza = /インフル|influenza|ＩＮＦＬＵＥＮＺＡ|flu|ＦＬＵ/u.test(text);
  const hasRapidOrAntigen = /迅速|抗原|定性|Ag|Ａｇ/u.test(text);
  if (hasCovid && hasInfluenza) {
    queries.push("ＳＡＲＳ－ＣｏＶ－２・インフルエンザウイルス抗原同時検出定性");
    queries.push("新型コロナ インフルエンザ 抗原同時検出");
  } else if (hasCovid && hasRapidOrAntigen) {
    queries.push("ＳＡＲＳ－ＣｏＶ－２抗原検出");
  } else if (hasInfluenza && hasRapidOrAntigen) {
    queries.push("インフルエンザウイルス抗原定性");
  }

  if (/溶連菌|A群|Ａ群|strep|ＳＴＲＥＰ/u.test(text)) {
    queries.push("Ａ群β溶連菌迅速試験定性");
    queries.push("溶連菌迅速検査");
  }
  if (/\bCRP\b|ＣＲＰ|C反応性蛋白|Ｃ反応性蛋白/u.test(text)) {
    queries.push("ＣＲＰ");
  }
  if (/CBC|ＣＢＣ|血算|末梢血液一般|血球計算|白血球|赤血球|血小板/u.test(text)) {
    queries.push("末梢血液一般検査");
  }
  if (/尿一般|尿定性|尿蛋白|尿糖|尿潜血|尿検査/u.test(text)) {
    queries.push("尿中一般物質定性半定量検査");
  }
  return uniqueStrings(queries);
}

function imagingAliasQueries(event = {}) {
  const text = normalizeClinicalText([
    clinicalEventName(event),
    clinicalEventEvidence(event),
    event?.payload?.bodySite,
    event?.body_site,
    event?.bodySite,
    event?.modality
  ].filter(Boolean).join(" "));
  const queries = [];
  if (/眼軸長|IOL|ＩＯＬ|眼内レンズ度数/u.test(text)) {
    queries.push("光学的眼軸長測定");
  }
  if (/細隙灯|スリット/u.test(text)) {
    queries.push("スリットＭ");
  }
  if (/眼底/u.test(text)) {
    queries.push("精密眼底検査");
  }
  if (/視野/u.test(text)) {
    queries.push("精密視野検査");
  }
  if (/眼圧/u.test(text)) {
    queries.push("精密眼圧測定");
  }
  return uniqueStrings(queries);
}

function procedureMasterQueriesFromEvidence(evidence = "") {
  const queries = [];
  const text = normalizeClinicalText(evidence);
  for (const sentence of splitClinicalSentences(text)) {
    const head = sentence.split(/[:：]/u)[0]?.trim();
    if (head && head.length >= 2 && head.length <= 40) {
      queries.push(head);
    }
    for (const match of sentence.matchAll(/([一-龥ァ-ヶーA-Za-z0-9]{2,30}(?:検査|測定|撮影|処置|管理料|指導料|計算|テスト|スクリーニング))/gu)) {
      queries.push(match[1]);
    }
  }
  return uniqueStrings(queries);
}

async function searchFirstMasterItem(feeCalculator, type, query, expectedKind) {
  try {
    const result = await feeCalculator.searchMaster({ type, query, limit: 5 });
    const items = Array.isArray(result?.items) ? result.items : [];
    return items.find((item) => item?.kind === expectedKind && item.code)
      || items.find((item) => item?.code)
      || null;
  } catch {
    return null;
  }
}

function splitClinicalSentences(text) {
  return normalizeClinicalText(text)
    .split(/[\n。]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function objectiveClinicalText(text) {
  const lines = normalizeClinicalText(text)
    .split("\n")
    .map((line) => line.trim());
  const objectiveLines = [];
  let inObjective = false;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (isObjectiveSectionHeading(line)) {
      inObjective = true;
      const inline = line.replace(/^O(?:bjective)?\s*[（(：:「\-\s]*(?:Objective)?[^）)：:]*[）):：]?\s*/iu, "").trim();
      if (inline && inline !== line && !isClinicalSectionHeading(inline)) {
        objectiveLines.push(inline);
      }
      continue;
    }
    if (inObjective && isClinicalSectionHeading(line)) {
      break;
    }
    if (inObjective) {
      objectiveLines.push(line);
    }
  }

  return objectiveLines.join("\n").trim();
}

function isObjectiveSectionHeading(line) {
  const text = String(line || "").trim();
  return /^(?:O|Objective)\b/iu.test(text)
    || /^O[（(：:]/iu.test(text)
    || /客観的情報/u.test(text);
}

function isClinicalSectionHeading(line) {
  const text = String(line || "").trim();
  return /^(?:S|Subjective|A|Assessment|P|Plan)\b/iu.test(text)
    || /^[SAP][（(：:]/iu.test(text)
    || /(主観的情報|評価|計画)/u.test(text);
}

function isPerformedImagingContext(sentence, kind) {
  if (/(施行|実施|撮影済み|撮影|確認|所見|正面|側面|結果|あり|認める|狭小化|骨棘)/u.test(sentence)) {
    return true;
  }
  if (kind === "simple_radiography" && /(X線|Ｘ線|レントゲン)/u.test(sentence)) {
    return true;
  }
  return false;
}

function isFutureOrOrderOnlyContext(sentence) {
  return /(\d+\s*(?:日|週間|週|か月|カ月|ヶ月|ケ月|月)後|予定|次回|後日|紹介|持参|検討|依頼|オーダー|予約|後で|今後)/u.test(sentence);
}

function isCurrentVisitEvidence(sentence) {
  return /(本日|今回|当日|外来|来院|受診|診察|診療|継続診療|定期受診|再来)/u.test(sentence);
}

function isNegatedContext(sentence) {
  return /(なし|無し|否定|未実施|行わず|施行せず|撮影せず|中止)/u.test(sentence);
}

function isNegatedClinicalServiceContext(sentence) {
  return /(未実施|行わず|施行せず|撮影せず|検査せず|撮影なし|検査なし|中止)/u.test(sentence);
}

function hasLocalContrastContext(sentence, kind) {
  if (/(造影なし|造影無し|非造影)/u.test(sentence)) {
    return false;
  }
  const modality = kind === "mri" ? "(?:MRI|ＭＲＩ)" : "(?:CT|ＣＴ)";
  return new RegExp(`(?:造影.{0,12}${modality}|${modality}.{0,12}造影|造影剤使用)`, "u").test(sentence);
}

function isCurrentPrescriptionContext(sentence) {
  if (isNegatedContext(sentence)) {
    return false;
  }
  return /(処方|投与|開始|追加|併用|毎食|分処方|日分|貼付|塗布)/u.test(sentence);
}

function isHistoricalMedicationContext(sentence) {
  return /(既往|内服中|持参薬|常用|継続中|服用中|既に|以前から|アレルギー)/u.test(sentence);
}

function isCurrentMaterialUseContext(sentence) {
  if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence)) {
    return false;
  }
  if (/(指導|説明|検討|予定)/u.test(sentence)) {
    return false;
  }
  return /(使用|装着|貼付|保護|交換|処置|材料)/u.test(sentence);
}

function mergeCalculationOptions(existing = {}, inferred = {}) {
  const result = isPlainObject(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(inferred || {})) {
    if (Array.isArray(value)) {
      result[key] = uniqueObjects([...(Array.isArray(result[key]) ? result[key] : []), ...value]);
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = { ...value, ...(isPlainObject(result[key]) ? result[key] : {}) };
      continue;
    }
    if (!hasOwn(result, key)) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeClinicalInferredOptions(options = {}) {
  if (!isPlainObject(options)) {
    return {};
  }
  const result = { ...options };
  if (Array.isArray(result.procedure_codes)) {
    result.procedure_codes = uniqueStrings(result.procedure_codes);
  }
  if (Array.isArray(result.imaging_orders)) {
    result.imaging_orders = dedupeObjects(result.imaging_orders, (item) => item?.kind || JSON.stringify(item));
  }
  if (Array.isArray(result.treatment_orders)) {
    result.treatment_orders = dedupeObjects(result.treatment_orders);
  }
  if (Array.isArray(result.medication_orders)) {
    result.medication_orders = dedupeObjects(result.medication_orders, (item) => item?.drug_code || JSON.stringify(item));
  }
  if (Array.isArray(result.material_inputs)) {
    result.material_inputs = dedupeObjects(result.material_inputs, (item) => item?.code || JSON.stringify(item));
  }
  if (Array.isArray(result.comment_inputs)) {
    result.comment_inputs = dedupeObjects(result.comment_inputs, (item) => item?.code || item?.text || JSON.stringify(item));
  }
  if (isPlainObject(result.lab_options) && Array.isArray(result.lab_options.collection_fee_inputs)) {
    result.lab_options = {
      ...result.lab_options,
      collection_fee_inputs: uniqueStrings(result.lab_options.collection_fee_inputs)
    };
  }
  return result;
}

function manualCalculationOptions(session = {}, calculationInput = {}) {
  if (isPlainObject(calculationInput.calculationOptions)) {
    return calculationInput.calculationOptions;
  }
  if (!isPlainObject(session.calculationOptions)) {
    return {};
  }

  const source = String(session.calculationOptionsSource || "").trim();
  if (source === "manual") {
    return session.calculationOptions;
  }

  const autoKeys = calculationOptionsAutoKeys(session);
  if (autoKeys.length) {
    return omitCalculationOptionKeys(session.calculationOptions, autoKeys);
  }

  if (source === "clinical_auto") {
    return {};
  }

  if (normalizeClinicalText(session.clinicalText)) {
    return omitCalculationOptionKeys(session.calculationOptions, [...CLINICAL_AUTO_OPTION_KEYS]);
  }

  return session.calculationOptions;
}

function calculationOptionsAutoKeys(session = {}) {
  if (Array.isArray(session.calculationOptionsAutoKeys)) {
    return session.calculationOptionsAutoKeys.map((key) => String(key || "").trim()).filter(Boolean);
  }
  return [];
}

function omitCalculationOptionKeys(options = {}, keys = []) {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !omitted.has(key))
  );
}

function calculationOptionsSource(manualOptions = {}, autoKeys = []) {
  const hasManual = Object.keys(manualOptions).length > 0;
  const hasAuto = autoKeys.length > 0;
  if (hasManual && hasAuto) {
    return "manual_with_clinical_auto";
  }
  if (hasManual) {
    return "manual";
  }
  if (hasAuto) {
    return "clinical_auto";
  }
  return null;
}

function dedupeObjects(values = [], keyFn = (item) => JSON.stringify(item)) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uniqueObjects(values = []) {
  return dedupeObjects(values);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeReviewWarnings(values = []) {
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    const warning = cleanReviewWarning(raw);
    if (!warning || isLowValueClinicalReviewWarning(warning)) {
      continue;
    }
    const key = reviewWarningDedupKey(warning);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(warning);
  }
  return result
    .slice(0, 20);
}

function cleanReviewWarning(value) {
  let warning = String(value || "").trim();
  if (!warning) {
    return "";
  }
  warning = warning.replace(/\s+/gu, " ");
  if (/Lab management fee skipped: facility_standard_not_found|facility_standard_not_found/u.test(warning)) {
    return "施設基準が登録されていないため、検体検査管理加算は自動追加していません。";
  }
  warning = warning.replace(/^(?:hospital_profile_missing|facility_standard_not_found)\s*[:：]\s*/u, "");
  warning = warning.replace(/薬剤「([^」]+)」/gu, (match, name) => {
    const canonical = canonicalMedicationName(name);
    return canonical ? `薬剤「${canonical}」` : match;
  });
  return isActionableClinicalFactWarning(warning) ? warning : "";
}

function reviewWarningDedupKey(warning) {
  const procedureCode = warning.match(/\b(\d{6,})\b/u)?.[1];
  if (procedureCode) {
    return `procedure:${procedureCode}:${reviewWarningReasonKey(warning)}`;
  }
  const medication = warning.match(/薬剤「([^」]+)」/u)?.[1];
  if (medication) {
    return `medication:${canonicalMedicationName(medication)}:${reviewWarningReasonKey(warning)}`;
  }
  if (/施設基準/u.test(warning)) {
    return `facility:${reviewWarningReasonKey(warning)}`;
  }
  const planned = warning.match(/^(.+?)は予定・依頼/u)?.[1];
  if (planned) {
    return `planned:${normalizeReviewTarget(planned)}`;
  }
  const unsupported = warning.match(/^(.+?)は(?:実施済みの)?(?:検体検査|超音波検査|医学管理等|指導・説明|.+?)として/u)?.[1];
  if (unsupported) {
    return `unsupported:${normalizeReviewTarget(unsupported)}:${reviewWarningReasonKey(warning)}`;
  }
  const basic = warning.match(/(初診|再診|受診履歴|過去算定記録)/u)?.[1];
  if (basic) {
    return `visit:${reviewWarningReasonKey(warning)}`;
  }
  return warning;
}

function normalizeReviewTarget(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .replace(/[「」『』（）()]/gu, "")
    .toLowerCase();
}

function reviewWarningReasonKey(warning) {
  if (/(数量|日数|総量|回数).*(不足|不明|明記なし)/u.test(warning)) {
    return "quantity_missing";
  }
  if (/(予定|依頼|オーダー|次回|今後)/u.test(warning)) {
    return "planned_only";
  }
  if (/(未対応|コード確定|自動確定|標準コード|直接候補化できない)/u.test(warning)) {
    return "unsupported";
  }
  if (/施設基準/u.test(warning)) {
    return "facility_standard";
  }
  if (/(初診|再診|受診履歴|過去算定記録)/u.test(warning)) {
    return "visit_history";
  }
  return normalizeReviewTarget(warning).slice(0, 80);
}

function isLowValueClinicalReviewWarning(warning) {
  return /^(診断精査目的|治療方針再評価|NSAIDs注意)/u.test(warning);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numericText(value) {
  const normalized = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .match(/\d+(?:\.\d+)?/u)?.[0];
  return normalized || "";
}

function integerText(value) {
  const normalized = numericText(value);
  if (!normalized) return "";
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) return "";
  return String(Math.round(number));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(Object(object), key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateIdPart(value) {
  const normalized = String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || "item";
}
