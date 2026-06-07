import { extractFeeClinicalFactsWithOpenAi } from "../../../packages/medical-core/src/fee/openai-fee-clinical-facts.js";
import {
  procedureHintQueries,
  resolveClinicalProcedureHints
} from "./clinical-master-resolver.js";

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

const MANAGEMENT_CONTEXT_PROFILES = [
  {
    key: "dermatology_specific_disease_management",
    diagnosisPatterns: [/アトピー性皮膚炎|アトピー|慢性湿疹|湿疹/u],
    contextPatterns: [/皮膚|湿疹|外用|ステロイド|プロトピック|デュピクセント|スキンケア|保湿|入浴/u],
    queries: ["皮膚科特定疾患指導管理料", "皮膚科特定疾患"],
    preferredPatterns: [/皮膚科特定疾患指導管理料/u],
    title: "皮膚科の慢性疾患管理料の確認",
    reason: "慢性皮膚疾患に対して、外用薬の使い分け・保湿・スキンケア・入浴指導などの療養指導が記載されています。",
    conditionText: "皮膚科を標榜する医療機関で、対象疾患に対して計画的な指導を行った場合は算定できる可能性があります。他の管理料との併算定可否を確認してください。"
  },
  {
    key: "specific_disease_management",
    diagnosisPatterns: [/気管支喘息|喘息/u],
    contextPatterns: [/指導|説明|療養|計画|服薬|生活/u],
    queries: ["特定疾患療養管理料"],
    preferredPatterns: [/特定疾患療養管理料/u],
    title: "特定疾患療養管理料の確認",
    reason: "対象になり得る慢性疾患に対して、継続的な療養指導が記載されています。",
    conditionText: "対象疾患・施設種別・同月算定条件を満たす場合は算定できる可能性があります。令和6年改定後の対象疾患か確認してください。"
  },
  {
    key: "lifestyle_disease_management",
    diagnosisPatterns: [/高血圧|糖尿病|脂質異常|高脂血/u],
    contextPatterns: [/指導|説明|療養|計画書|署名|生活|栄養|運動|食事/u],
    queries: ["生活習慣病管理料"],
    preferredPatterns: [/生活習慣病管理料/u],
    title: "生活習慣病管理料の確認",
    reason: "生活習慣病に対して、療養計画・生活指導・服薬指導などが記載されています。",
    conditionText: "高血圧・糖尿病・脂質異常症などは、令和6年改定後は特定疾患療養管理料ではなく生活習慣病管理料の条件を確認してください。療養計画書や同月算定条件を満たす場合に算定できます。"
  }
];

const MANAGEMENT_GUIDANCE_PATTERN = /指導|説明|療養|計画書|署名|スキンケア|入浴|保湿|外用|塗布|部位別|生活指導|服薬指導|投与方法|費用/u;

const CLINICAL_AUTO_OPTION_KEYS = new Set([
  "procedure_codes",
  "outpatient_basic",
  "imaging_orders",
  "treatment_orders",
  "medication_orders",
  "medication",
  "material_inputs",
  "comment_inputs",
  "lab_options"
]);

const CLINICAL_PROCEDURE_ALIASES = Object.freeze({
  ca125: {
    code: "160038010",
    collectionFeeInput: "blood_venous"
  },
  transvaginalUltrasound: {
    code: "160072210",
    commentInput: {
      code: "820100683",
      text: "超音波検査（断層撮影法）（胸腹部）：ウ　女性生殖器領域"
    }
  }
});

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
      metrics: {
        clinicalStructuring: {
          source: "manual",
          durationMs: 0
        }
      }
    };
  }

  const text = normalizeClinicalText(calculationInput.clinicalText || session.clinicalText || "");
  const inferred = {};
  const inferredDiagnoses = [];
  const candidateProposals = [];
  const reviewWarnings = [];
  const metrics = {
    clinicalStructuring: {
      source: text ? "not_run" : "no_clinical_text",
      durationMs: 0,
      model: openAiModel,
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
    } else {
      Object.assign(inferred, ruleBased.inferred);
      candidateProposals.push(...asArray(ruleBased.candidateProposals));
      reviewWarnings.push(...structured.reviewWarnings, ...ruleBased.reviewWarnings);
    }
  }

  const normalizedInferred = normalizeClinicalInferredOptions(inferred);
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

  const opportunityProposals = await buildClinicalCandidateProposals({
    text,
    diagnoses: [
      ...asArray(session.diagnoses),
      ...inferredDiagnoses
    ],
    calculationOptions: normalizedInferred,
    reviewWarnings,
    feeCalculator
  });
  candidateProposals.push(...opportunityProposals);

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
        extractedBillingEventCount: Array.isArray(facts?.billing_events) ? facts.billing_events.length : 0,
        extractedExcludedEventCount: Array.isArray(facts?.excluded_events) ? facts.excluded_events.length : 0,
        convertedDiagnosisCount: Array.isArray(converted.diagnoses) ? converted.diagnoses.length : 0,
        convertedOptionKeys,
        convertedReviewWarningCount: Array.isArray(converted.reviewWarnings) ? converted.reviewWarnings.length : 0,
        ...conversionSearch.snapshot(),
        model: openAiModel,
        reasoningEffort: openAiReasoningEffort,
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

async function inferRuleBasedClinicalCalculationOptions({ text = "", session = {}, feeCalculator } = {}) {
  const inferred = {};
  const reviewWarnings = [];

  const outpatientBasic = inferOutpatientBasicOptions(text);
  if (outpatientBasic) {
    inferred.outpatient_basic = outpatientBasic;
  }

  const imaging = inferImagingOrders(text);
  if (imaging.orders.length) {
    inferred.imaging_orders = imaging.orders;
  }
  reviewWarnings.push(...imaging.reviewWarnings);

  const performedProcedureCodes = await inferPerformedProcedureCodes(text, feeCalculator);
  if (performedProcedureCodes.procedureCodes.length) {
    inferred.procedure_codes = performedProcedureCodes.procedureCodes;
  }
  if (performedProcedureCodes.commentInputs.length) {
    inferred.comment_inputs = performedProcedureCodes.commentInputs;
  }
  if (performedProcedureCodes.collectionFeeInputs.length) {
    inferred.lab_options = {
      collection_fee_inputs: performedProcedureCodes.collectionFeeInputs
    };
  }
  reviewWarnings.push(...performedProcedureCodes.reviewWarnings);

  const treatment = inferTreatmentOrders(text, session.orders);
  if (treatment.orders.length) {
    inferred.treatment_orders = treatment.orders;
  }
  reviewWarnings.push(...treatment.reviewWarnings);

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

  const imaging = inferImagingOrders(objectiveText);
  if (imaging.orders.length) {
    inferred.imaging_orders = imaging.orders;
  }
  reviewWarnings.push(...imaging.reviewWarnings);

  const performedProcedureCodes = await inferPerformedProcedureCodes(objectiveText, feeCalculator);
  if (performedProcedureCodes.procedureCodes.length) {
    inferred.procedure_codes = performedProcedureCodes.procedureCodes;
  }
  if (performedProcedureCodes.commentInputs.length) {
    inferred.comment_inputs = performedProcedureCodes.commentInputs;
  }
  if (performedProcedureCodes.collectionFeeInputs.length) {
    inferred.lab_options = {
      collection_fee_inputs: performedProcedureCodes.collectionFeeInputs
    };
  }
  reviewWarnings.push(...performedProcedureCodes.reviewWarnings);

  const treatment = inferTreatmentOrders(objectiveText, session.orders);
  if (treatment.orders.length) {
    inferred.treatment_orders = treatment.orders;
  }
  reviewWarnings.push(...treatment.reviewWarnings);

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
  const treatmentOrders = [];
  const medicationOrders = [];
  const materialInputs = [];
  const commentInputs = [];
  const collectionFeeInputs = [];
  const candidateProposals = [];

  const outpatientBasic = outpatientBasicFromStructuredVisit(facts?.visit_type, text);
  if (outpatientBasic) {
    inferred.outpatient_basic = outpatientBasic;
  }

  for (const event of asArray(facts?.excluded_events)) {
    const warning = excludedClinicalEventWarning(event);
    if (warning) reviewWarnings.push(warning);
  }
  reviewWarnings.push(...clinicalFactReviewWarnings(facts?.missing_information));
  reviewWarnings.push(...clinicalFactReviewWarnings(facts?.review_flags));

  for (const event of asArray(facts?.billing_events)) {
    const type = normalizeClinicalEventType(event);
    const status = normalizeClinicalEventStatus(event);
    if (!isBillableClinicalEventStatus(status)) {
      const warning = excludedClinicalEventWarning(event);
      if (warning) reviewWarnings.push(warning);
      continue;
    }

    if (type === "imaging") {
      const imaging = await imagingOrderFromClinicalEvent(event, feeCalculator);
      if (imaging.order) imagingOrders.push(imaging.order);
      procedureCodes.push(...imaging.procedureCodes);
      commentInputs.push(...imaging.commentInputs);
      collectionFeeInputs.push(...imaging.collectionFeeInputs);
      reviewWarnings.push(...imaging.reviewWarnings);
      continue;
    }

    if (type === "lab") {
      const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
        categoryLabel: "検体検査"
      });
      procedureCodes.push(...procedure.procedureCodes);
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs);
      reviewWarnings.push(...procedure.reviewWarnings);
      continue;
    }

    if (type === "medication") {
      const medication = await medicationOrderFromClinicalEvent(event, feeCalculator);
      if (medication.order) {
        medicationOrders.push(medication.order);
      }
      reviewWarnings.push(...medication.reviewWarnings);
      continue;
    }

    if (type === "material") {
      const material = await materialInputFromClinicalEvent(event, feeCalculator);
      if (material.input) {
        materialInputs.push(material.input);
      }
      reviewWarnings.push(...material.reviewWarnings);
      continue;
    }

    if (["procedure", "treatment"].includes(type)) {
      const treatment = treatmentOrderFromClinicalEvent(event, session.orders);
      if (treatment.order) {
        treatmentOrders.push(treatment.order);
      }
      reviewWarnings.push(...treatment.reviewWarnings);
      continue;
    }

    if (["management", "counseling"].includes(type)) {
      const categoryLabel = type === "management" ? "医学管理等" : "指導料";
      const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
        categoryLabel
      });
      if (procedure.procedureCodes.length) {
        procedureCodes.push(...procedure.procedureCodes);
        commentInputs.push(...procedure.commentInputs);
        collectionFeeInputs.push(...procedure.collectionFeeInputs);
        reviewWarnings.push(...procedure.reviewWarnings);
      } else {
        const proposal = await clinicalEventCandidateProposal(event, feeCalculator, {
          categoryLabel,
          sortOrder: type === "management" ? 25 : 30
        });
        if (proposal) {
          candidateProposals.push(proposal);
        } else {
          const warning = unsupportedClinicalEventWarning(event);
          if (warning) reviewWarnings.push(warning);
        }
      }
      continue;
    }

    const warning = unsupportedClinicalEventWarning(event);
    if (warning) reviewWarnings.push(warning);
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
  if (treatmentOrders.length) {
    inferred.treatment_orders = dedupeObjects(treatmentOrders);
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
    reviewWarnings: normalizeReviewWarnings(reviewWarnings)
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
  const queries = uniqueStrings([
    name,
    ...procedureMasterQueriesFromEvidence(evidence),
    categoryLabel
  ]);
  const item = await searchProcedureCandidateItem(feeCalculator, queries, [
    ...(name ? [new RegExp(escapeRegExp(name), "u")] : []),
    new RegExp(escapeRegExp(categoryLabel), "u")
  ]);
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

async function buildClinicalCandidateProposals({
  text = "",
  diagnoses = [],
  calculationOptions = {},
  reviewWarnings = [],
  feeCalculator
} = {}) {
  if (!normalizeClinicalText(text)) {
    return [];
  }
  const proposals = [];
  const existingProcedureCodes = new Set(asArray(calculationOptions?.procedure_codes).map((code) => String(code || "")));
  const diagnosisText = diagnosisNames(diagnoses).join(" ");
  const combinedText = [text, diagnosisText, ...asArray(reviewWarnings)].join("\n");

  const managementProposal = await chronicManagementFeeProposal({
    text: combinedText,
    existingProcedureCodes,
    feeCalculator
  });
  if (managementProposal) {
    proposals.push(managementProposal);
  }

  proposals.push(...await labValueCandidateProposals({
    text,
    existingProcedureCodes,
    feeCalculator
  }));

  return normalizeCandidateProposals(proposals);
}

async function chronicManagementFeeProposal({
  text = "",
  existingProcedureCodes = new Set(),
  feeCalculator
} = {}) {
  const normalizedText = normalizeClinicalText(text);
  if (!MANAGEMENT_GUIDANCE_PATTERN.test(normalizedText)) {
    return null;
  }

  const profiles = MANAGEMENT_CONTEXT_PROFILES.filter((profile) => (
    profile.diagnosisPatterns.some((pattern) => pattern.test(normalizedText))
    && (!profile.contextPatterns?.length || profile.contextPatterns.some((pattern) => pattern.test(normalizedText)))
  ));
  if (!profiles.length) {
    return null;
  }

  for (const profile of profiles) {
    const item = await searchProcedureCandidateItem(feeCalculator, profile.queries, profile.preferredPatterns);
    if (!item?.code) {
      continue;
    }
    if (existingProcedureCodes.has(String(item.code))) {
      return null;
    }
    return candidateProposalFromProcedureItem({
      proposalId: `clinical_${profile.key}_${item.code}`,
      title: profile.title,
      reason: profile.reason,
      conditionText: profile.conditionText,
      evidence: managementEvidenceText(normalizedText),
      item,
      sortOrder: 20,
      basis: "カルテ本文から慢性疾患への指導・説明を検出しました。対象疾患・施設種別・併算定条件を満たす場合だけ採用してください。"
    });
  }

  const fallback = profiles[0];
  return {
    proposalId: `clinical_${fallback.key}_confirm`,
    title: fallback.title,
    reason: fallback.reason,
    conditionText: "該当する管理料をマスター検索で確認してください。条件を満たす場合は点数に追加できます。",
    evidence: managementEvidenceText(normalizedText),
    actionType: "confirm_required",
    potentialPoints: 0,
    orderType: "procedure",
    source: "clinical_billing_opportunity",
    sortOrder: 20
  };
}

async function labValueCandidateProposals({ text = "", existingProcedureCodes = new Set(), feeCalculator } = {}) {
  const proposals = [];
  for (const sentence of splitClinicalSentences(text)) {
    if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence) || !isPerformedObjectiveFinding(sentence)) {
      continue;
    }
    const queries = procedureHintQueries(sentence);
    if (!queries.length) {
      continue;
    }
    const label = queries[0];
    const item = await searchProcedureCandidateItem(feeCalculator, queries, [
      new RegExp(escapeRegExp(label), "u"),
      ...queries.map((query) => new RegExp(escapeRegExp(query), "u"))
    ]);
    if (item?.code && existingProcedureCodes.has(String(item.code))) {
      continue;
    }
    if (item?.code) {
      proposals.push(candidateProposalFromProcedureItem({
        proposalId: `clinical_lab_${candidateIdPart(label)}_${item.code}`,
        title: `${label}検査の確認`,
        reason: `${label}の結果値がカルテに記載されています。`,
        conditionText: "当日実施した検査結果であれば算定できます。過去値・持参結果の場合は算定しないでください。",
        evidence: sentence,
        item,
        sortOrder: 40,
        basis: "客観所見に検査値があるため、当日実施かを確認して候補化します。"
      }));
    } else {
      proposals.push({
        proposalId: `clinical_lab_${candidateIdPart(label)}_confirm`,
        title: `${label}検査の確認`,
        reason: `${label}の結果値がカルテに記載されています。`,
        conditionText: "当日実施した検査結果であれば算定できます。標準コードはマスター検索で確認してください。",
        evidence: sentence,
        actionType: "confirm_required",
        potentialPoints: 0,
        orderType: "procedure",
        source: "clinical_billing_opportunity",
        sortOrder: 40
      });
    }
  }
  return proposals;
}

async function searchProcedureCandidateItem(feeCalculator, queries = [], preferredPatterns = []) {
  if (typeof feeCalculator?.searchMaster !== "function") {
    return null;
  }
  for (const query of uniqueStrings(queries).filter((value) => value.length >= 2)) {
    try {
      const result = await feeCalculator.searchMaster({ type: "procedure", query, limit: 10 });
      const items = asArray(result?.items).filter((item) => item?.code && (
        item.kind === "procedure"
        || item.sourceType === "medical_procedure_master"
        || item.source === "medical_procedure_master"
      ));
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

function managementEvidenceText(text = "") {
  return splitClinicalSentences(text)
    .find((sentence) => MANAGEMENT_GUIDANCE_PATTERN.test(sentence))
    || splitClinicalSentences(text)[0]
    || "";
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
        orders.push({
          kind: "mri",
          mri_equipment_kind: "other",
          contrast: hasLocalContrastContext(sentence, "mri"),
          electronic_image_management: true
        });
        reviewWarnings.push("MRI検査は機器区分がカルテ本文から確定できないため、旧入力契約の既定値（その他）で候補化しています。請求前に機器区分を確認してください。");
      }
      continue;
    }
    if (/(?:^|[^A-Za-z])CT(?:$|[^A-Za-z])|ＣＴ/u.test(sentence)) {
      if (isFutureOrOrderOnlyContext(sentence)) {
        reviewWarnings.push("CT検査は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は撮影内容を確認してください。");
      } else if (isPerformedImagingContext(sentence, "ct")) {
        orders.push({
          kind: "ct",
          ct_equipment_kind: "other",
          contrast: hasLocalContrastContext(sentence, "ct"),
          electronic_image_management: true
        });
        reviewWarnings.push("CT検査は機器区分がカルテ本文から確定できないため、旧入力契約の既定値（その他）で候補化しています。請求前に機器区分を確認してください。");
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

async function inferPerformedProcedureCodes(text, feeCalculator) {
  const procedureCodes = [];
  const commentInputs = [];
  const collectionFeeInputs = [];
  const reviewWarnings = [];
  for (const sentence of splitClinicalSentences(text)) {
    if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence)) {
      continue;
    }
    const hinted = resolveClinicalProcedureHints(sentence);
    if (hinted.procedureCodes.length && isPerformedOrClaimedProcedureContext(sentence)) {
      procedureCodes.push(...hinted.procedureCodes);
      commentInputs.push(...hinted.commentInputs);
      collectionFeeInputs.push(...hinted.collectionFeeInputs);
      reviewWarnings.push(...hinted.reviewWarnings);
    }
    const genericQueries = procedureHintQueries(sentence);
    if (!hinted.procedureCodes.length && genericQueries.length && isPerformedObjectiveFinding(sentence)) {
      const procedure = await searchPerformedProcedureCode(feeCalculator, {
        name: genericQueries[0],
        categoryLabel: "検体検査",
        queries: genericQueries,
        unresolvedMessage: `${genericQueries[0]}は実施済みの検体検査として検出しましたが、標準コードを自動確定できませんでした。検査項目をマスター検索で確認してください。`,
        resolvedMessage: `${genericQueries[0]}を実施済み検体検査としてマスター候補に反映しました。検査項目と算定条件を確認してください。`
      });
      procedureCodes.push(...procedure.procedureCodes);
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs);
      reviewWarnings.push(...procedure.reviewWarnings);
    }
    if (/(経腟超音波|経膣超音波|超音波|エコー)/u.test(sentence) && isPerformedObjectiveFinding(sentence)) {
      const procedure = await searchPerformedProcedureCode(feeCalculator, {
        name: ultrasoundDisplayName(sentence),
        categoryLabel: "超音波検査",
        queries: ultrasoundMasterQueries(sentence),
        unresolvedMessage: "超音波検査は実施済みの客観所見として検出しましたが、標準コードを自動確定できませんでした。部位と検査内容をマスター検索で確認してください。",
        resolvedMessage: "超音波検査を実施済みとしてマスター候補に反映しました。部位・検査方法・算定条件を確認してください。"
      });
      procedureCodes.push(...procedure.procedureCodes);
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs);
      reviewWarnings.push(...procedure.reviewWarnings);
    }
    if (/(?:CA\s*125|CA125)/iu.test(sentence) && isPerformedObjectiveFinding(sentence)) {
      const procedure = await searchPerformedProcedureCode(feeCalculator, {
        name: "CA125",
        categoryLabel: "検体検査",
        queries: ["CA125", "CA 125", "CA-125", "ＣＡ１２５", "癌抗原125", "癌抗原１２５"],
        unresolvedMessage: "CA125は実施済みの検体検査として検出しましたが、標準コードを自動確定できませんでした。検査項目をマスター検索で確認してください。",
        resolvedMessage: "CA125を実施済み検体検査としてマスター候補に反映しました。検査項目と算定条件を確認してください。"
      });
      procedureCodes.push(...procedure.procedureCodes);
      commentInputs.push(...procedure.commentInputs);
      collectionFeeInputs.push(...procedure.collectionFeeInputs);
      reviewWarnings.push(...procedure.reviewWarnings);
    }
  }
  return {
    procedureCodes: uniqueStrings(procedureCodes),
    commentInputs: dedupeObjects(commentInputs, (item) => item?.code || item?.text || JSON.stringify(item)),
    collectionFeeInputs: uniqueStrings(collectionFeeInputs),
    reviewWarnings
  };
}

function isPerformedObjectiveFinding(sentence) {
  return /(:|：|所見|結果|高値|低値|基準値|貯留|病変|あり|認める|施行|実施|検査|撮影)/u.test(sentence);
}

function isPerformedOrClaimedProcedureContext(sentence) {
  return isPerformedObjectiveFinding(sentence)
    || /(算定|管理料|療養計画書|署名取得|説明・署名|署名)/u.test(sentence);
}

function inferTreatmentOrders(text, orders = []) {
  const treatmentOrders = [];
  const reviewWarnings = [];
  if (hasSpecificProcedureCode(orders)) {
    return { orders: treatmentOrders, reviewWarnings };
  }
  for (const sentence of splitClinicalSentences(text)) {
    if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence)) {
      continue;
    }
    if (/(熱傷|やけど)/u.test(sentence)) {
      treatmentOrders.push({
        kind: "burn",
        area_size: inferTreatmentAreaSize(sentence)
      });
    } else if (/(創傷|創部|裂創|擦過傷|洗浄|ガーゼ)/u.test(sentence)) {
      treatmentOrders.push({
        kind: "wound",
        area_size: inferTreatmentAreaSize(sentence)
      });
    }
  }
  for (const order of treatmentOrders) {
    if (!order.area_size) {
      reviewWarnings.push("処置面積がカルテ本文から確定できないため、処置料は要確認です。面積区分を確認してください。");
    }
  }
  return {
    orders: dedupeObjects(treatmentOrders),
    reviewWarnings
  };
}

function inferTreatmentAreaSize(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*cm/iu);
  if (match) {
    const area = Number(match[1]) * Number(match[2]);
    if (Number.isFinite(area)) {
      if (area < 100) return "lt_100_cm2";
      if (area < 500) return "ge_100_lt_500_cm2";
      if (area < 3000) return "ge_500_lt_3000_cm2";
      if (area < 6000) return "ge_3000_lt_6000_cm2";
      return "ge_6000_cm2";
    }
  }
  if (/(100\s*cm2\s*未満|100\s*cm²\s*未満|１００ｃｍ２未満)/u.test(text)) {
    return "lt_100_cm2";
  }
  return null;
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
    if (!/(材料|特定器材|使用|装着|保護|固定|交換|ガーゼ|コルセット|シーネ|包帯|カテーテル|ドレーン|フィルム|パッド)/u.test(sentence)) {
      continue;
    }
    const matches = sentence.matchAll(/([一-龥ァ-ヶーA-Za-z0-9]+(?:ガーゼ|コルセット|シーネ|包帯|カテーテル|ドレーン|チューブ|フィルム|パッド))/gu);
    for (const match of matches) {
      const query = String(match[1] || "").trim();
      if (!query || /ロコア|湿布|貼付薬/u.test(query)) {
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
  if (/(?:CA\s*[-]?\s*125|CA125|ＣＡ１２５|CEA|CRP|HbA1c|AST|ALT|血糖|尿酸|Dダイマー)/iu.test(text)
    && /(高値|低値|陽性|陰性|基準値|U\/?mL|mg\/?dL|軽度|結果)/iu.test(text)) {
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
  return String(event?.status || "unclear").trim();
}

function isBillableClinicalEventStatus(status) {
  return ["performed", "prescribed", "administered"].includes(status);
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
  const name = clinicalEventName(event) || clinicalImagingDisplayName(event) || "項目";
  const reason = String(event?.reason || event?.review_reason || "").trim();

  if (type === "medication" && isMedicationNameNoise(name)) {
    return "";
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
    reviewWarnings.push("MRI検査は機器区分がカルテ本文から確定できないため、旧入力契約の既定値（その他）で候補化しています。請求前に機器区分を確認してください。");
    return {
      order: {
        kind: "mri",
        mri_equipment_kind: "other",
        contrast: hasLocalContrastContext(evidence, "mri"),
        electronic_image_management: true
      },
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
      reviewWarnings
    };
  }
  if (kind === "ct") {
    reviewWarnings.push("CT検査は機器区分がカルテ本文から確定できないため、旧入力契約の既定値（その他）で候補化しています。請求前に機器区分を確認してください。");
    return {
      order: {
        kind: "ct",
        ct_equipment_kind: "other",
        contrast: hasLocalContrastContext(evidence, "ct"),
        electronic_image_management: true
      },
      procedureCodes,
      commentInputs: [],
      collectionFeeInputs: [],
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
      reviewWarnings
    };
  }

  if (kind === "ultrasound") {
    const procedure = await procedureCodesFromPerformedClinicalEvent(event, feeCalculator, {
      categoryLabel: "超音波検査",
      queries: ultrasoundMasterQueries(clinicalEventEvidence(event) || clinicalEventName(event)),
      unresolvedMessage: `${clinicalEventName(event) || "超音波検査"}は超音波検査として抽出しましたが、標準コードを自動確定できませんでした。部位と検査内容をマスター検索で確認してください。`,
      resolvedMessage: `${clinicalEventName(event) || "超音波検査"}を実施済みとしてマスター候補に反映しました。部位・検査方法・算定条件を確認してください。`
    });
    return {
      order: null,
      procedureCodes: procedure.procedureCodes,
      commentInputs: procedure.commentInputs,
      collectionFeeInputs: procedure.collectionFeeInputs,
      reviewWarnings: procedure.reviewWarnings
    };
  }

  if (kind) {
    reviewWarnings.push(`${clinicalEventName(event) || clinicalImagingDisplayName(event)}は現在の算定ルールで直接候補化できないため、要確認です。`);
  }
  return { order: null, procedureCodes, commentInputs: [], collectionFeeInputs: [], reviewWarnings };
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
  if (/(超音波|エコー|経腟|経膣)/u.test(text)) return "ultrasound";
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
    return { order: null, reviewWarnings };
  }
  const name = canonicalMedicationName(rawName);
  if (!name) {
    reviewWarnings.push("薬剤名がカルテ本文から確定できないため、薬剤算定候補には入れていません。");
    return { order: null, reviewWarnings };
  }
  const quantity = medicationQuantityFromClinicalEvent(event);
  if (!hasCalculableMedicationQuantity(quantity)) {
    reviewWarnings.push(`薬剤「${name}」は数量または日数が不足しているため、算定候補には入れていません。`);
    return { order: null, reviewWarnings };
  }
  const item = await searchFirstMasterItem(feeCalculator, "drug", name, "drug");
  if (!item?.code) {
    reviewWarnings.push(`薬剤「${name}」をマスターコードへ解決できませんでした。`);
    return { order: null, reviewWarnings };
  }
  return {
    order: {
      drug_code: String(item.code),
      ...quantity,
      dispensing_kind: "internal_or_prn"
    },
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
  if (/^ロキソプロフェン/u.test(name) || /^ロキソニン/u.test(name)) {
    return "ロキソプロフェン";
  }
  if (/^レバミピド/u.test(name) || /^ムコスタ/u.test(name)) {
    return "レバミピド";
  }
  if (/ルナベル/u.test(name)) {
    return "ルナベル配合錠LD";
  }
  return name;
}

function isMedicationNameNoise(value) {
  const text = String(value || "")
    .replace(/\s+/gu, "")
    .trim();
  if (!text) {
    return true;
  }
  return /^(?:塗布再指導|再指導|本日で終了|終了|継続|増量検討|切り替え|説明|指導)$/u.test(text)
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
    return { input: null, reviewWarnings };
  }
  const item = await searchFirstMasterItem(feeCalculator, "material", name, "material");
  if (!item?.code) {
    reviewWarnings.push(`特定器材・材料「${name}」をマスターコードへ解決できませんでした。`);
    return { input: null, reviewWarnings };
  }
  return {
    input: {
      code: String(item.code),
      quantity: numericText(event?.total_quantity) || numericText(event?.quantity_per_day) || "1"
    },
    reviewWarnings
  };
}

function treatmentOrderFromClinicalEvent(event = {}, orders = []) {
  const reviewWarnings = [];
  if (hasSpecificProcedureCode(orders)) {
    return { order: null, reviewWarnings };
  }
  const text = clinicalEventEvidence(event);
  let kind = "";
  if (/(熱傷|やけど)/u.test(text)) {
    kind = "burn";
  } else if (/(創傷|創部|裂創|擦過傷|洗浄|ガーゼ)/u.test(text)) {
    kind = "wound";
  }
  if (!kind) {
    return { order: null, reviewWarnings };
  }
  const areaSize = treatmentAreaSizeFromClinicalEvent(event) || inferTreatmentAreaSize(text);
  if (!areaSize) {
    reviewWarnings.push("処置面積がカルテ本文から確定できないため、処置料は要確認です。面積区分を確認してください。");
  }
  return {
    order: {
      kind,
      area_size: areaSize
    },
    reviewWarnings
  };
}

function treatmentAreaSizeFromClinicalEvent(event = {}) {
  const area = Number(String(event?.area_size_cm2 || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(area) || area <= 0) {
    return null;
  }
  if (area < 100) return "lt_100_cm2";
  if (area < 500) return "ge_100_lt_500_cm2";
  if (area < 3000) return "ge_500_lt_3000_cm2";
  if (area < 6000) return "ge_3000_lt_6000_cm2";
  return "ge_6000_cm2";
}

async function procedureCodesFromPerformedClinicalEvent(event = {}, feeCalculator, options = {}) {
  const status = normalizeClinicalEventStatus(event);
  if (!isBillableClinicalEventStatus(status)) {
    const warning = excludedClinicalEventWarning(event);
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      reviewWarnings: warning ? [warning] : []
    };
  }

  const name = clinicalEventName(event);
  const categoryLabel = options.categoryLabel || "診療行為";
  const resolverText = [name, categoryLabel, clinicalEventEvidence(event)].filter(Boolean).join(" ");
  const hinted = resolveClinicalProcedureHints(resolverText);
  if (hinted.procedureCodes.length) {
    return hinted;
  }
  const alias = procedureAliasFromText(resolverText);
  if (alias) {
    return alias;
  }
  const queries = uniqueStrings([
    ...(Array.isArray(options.queries) ? options.queries : []),
    name,
    ...procedureMasterQueriesFromEvidence(clinicalEventEvidence(event))
  ]);
  return searchPerformedProcedureCode(feeCalculator, {
    name,
    categoryLabel,
    queries,
    resolvedMessage: options.resolvedMessage || `${name || categoryLabel}を実施済みの${categoryLabel}としてマスター候補に反映しました。算定条件を確認してください。`,
    unresolvedMessage: options.unresolvedMessage || `${name || categoryLabel}は実施済みの${categoryLabel}として抽出しましたが、標準コードを自動確定できませんでした。マスター検索で確認してください。`
  });
}

async function searchPerformedProcedureCode(feeCalculator, {
  name = "",
  categoryLabel = "診療行為",
  queries = [],
  resolvedMessage = "",
  unresolvedMessage = ""
} = {}) {
  const hinted = resolveClinicalProcedureHints([name, categoryLabel, ...queries].filter(Boolean).join(" "));
  if (hinted.procedureCodes.length) {
    return hinted;
  }

  if (typeof feeCalculator?.searchMaster !== "function") {
    const alias = procedureAliasFromText([name, categoryLabel, ...queries].filter(Boolean).join(" "));
    if (alias) {
      return alias;
    }
    return {
      procedureCodes: [],
      commentInputs: [],
      collectionFeeInputs: [],
      reviewWarnings: [unresolvedMessage || `${name || categoryLabel}は実施済みとして検出しましたが、マスター検索を利用できません。`]
    };
  }

  const alias = procedureAliasFromText([name, categoryLabel, ...queries].filter(Boolean).join(" "));
  if (alias) {
    return alias;
  }

  const normalizedQueries = uniqueStrings(queries).filter((query) => query.length >= 2);
  for (const query of normalizedQueries) {
    const item = await searchProcedureMasterItem(feeCalculator, query, { name, categoryLabel });
    if (item?.code) {
      return {
        procedureCodes: [String(item.code)],
        commentInputs: [],
        collectionFeeInputs: [],
        reviewWarnings: []
      };
    }
  }

  return {
    procedureCodes: [],
    commentInputs: [],
    collectionFeeInputs: [],
    reviewWarnings: [unresolvedMessage || `${name || categoryLabel}は実施済みとして検出しましたが、標準コードを自動確定できませんでした。`]
  };
}

function procedureAliasFromText(value) {
  const text = String(value || "");
  const normalizedText = normalizeProcedureMatchText(text);
  if (isCa125Context(normalizedText)) {
    return {
      procedureCodes: [CLINICAL_PROCEDURE_ALIASES.ca125.code],
      commentInputs: [],
      collectionFeeInputs: [CLINICAL_PROCEDURE_ALIASES.ca125.collectionFeeInput],
      reviewWarnings: []
    };
  }
  if (isUltrasoundContext(normalizedText) && isTransvaginalUltrasoundContext(normalizedText)) {
    return {
      procedureCodes: [CLINICAL_PROCEDURE_ALIASES.transvaginalUltrasound.code],
      commentInputs: [CLINICAL_PROCEDURE_ALIASES.transvaginalUltrasound.commentInput],
      collectionFeeInputs: [],
      reviewWarnings: []
    };
  }
  return null;
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
    ));
    return candidates.find((item) => isHighConfidenceProcedureMasterItem(item, { ...context, query }))
      || null;
  } catch {
    return null;
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

  if (isCa125Context(contextText)) {
    return isCa125MasterName(itemText);
  }

  if (isUltrasoundContext(contextText)) {
    if (!/超音波|エコー/u.test(itemText)) {
      return false;
    }
    if (/aモード|mモード|ドプラ|心臓|頸動脈|甲状腺|乳腺/u.test(itemText) && isTransvaginalUltrasoundContext(contextText)) {
      return false;
    }
    if (/aモード/u.test(itemText)) {
      return false;
    }
    if (isTransvaginalUltrasoundContext(contextText)) {
      return /(経腟|経膣|腟|膣|断層|子宮|卵巣|骨盤)/u.test(itemText);
    }
    return /(断層|胸腹部|体表|腹部|骨盤|経腟|経膣|子宮|卵巣)/u.test(itemText);
  }

  const queryKey = normalizeProcedureMatchText(query);
  const nameKey = normalizeProcedureMatchText(name);
  return Boolean(
    (queryKey && itemText.includes(queryKey))
    || (nameKey && itemText.includes(nameKey))
  );
}

function normalizeProcedureMatchText(value) {
  return String(value || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, "")
    .replace(/[（）()・、,，.\-－ー]/gu, "")
    .toLowerCase();
}

function isCa125Context(text) {
  return /ca125|ca一二五|癌抗原125/u.test(text);
}

function isCa125MasterName(text) {
  return /ca125|癌抗原125/u.test(text);
}

function isUltrasoundContext(text) {
  return /超音波|エコー|経腟|経膣/u.test(text);
}

function isTransvaginalUltrasoundContext(text) {
  return /経腟|経膣|腟|膣/u.test(text);
}

function procedureMasterQueriesFromEvidence(evidence) {
  const text = String(evidence || "");
  const queries = [...procedureHintQueries(text)];
  if (/(?:CA\s*125|CA125)/iu.test(text)) {
    queries.push("CA125", "CA 125", "CA-125", "ＣＡ１２５", "癌抗原125", "癌抗原１２５");
  }
  if (/(経腟超音波|経膣超音波|経腟エコー|経膣エコー)/u.test(text)) {
    queries.push("経腟超音波", "経膣超音波", "経腟エコー", "経膣エコー", "子宮 超音波", "卵巣 超音波", "超音波検査");
  } else if (/(超音波|エコー)/u.test(text)) {
    queries.push("超音波検査", "超音波");
  }
  return queries;
}

function ultrasoundMasterQueries(value) {
  const text = String(value || "");
  if (/(経腟|経膣)/u.test(text)) {
    return ["経腟超音波", "経膣超音波", "経腟エコー", "経膣エコー", "子宮 超音波", "卵巣 超音波", "超音波検査"];
  }
  return ["超音波検査", "超音波"];
}

function ultrasoundDisplayName(value) {
  return /(経腟|経膣)/u.test(String(value || "")) ? "経腟超音波" : "超音波検査";
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

function hasSpecificProcedureCode(orders = []) {
  return Array.isArray(orders) && orders.some((order) => {
    if (!order || typeof order !== "object") return false;
    const type = String(order.orderType || order.order_type || "").trim();
    return ["procedure", "treatment"].includes(type) && orderHasCode(order);
  });
}

function orderHasCode(order = {}) {
  return ["standardCode", "standard_code", "localCode", "local_code", "code"].some((key) => {
    const value = order[key];
    return typeof value === "string" && value.trim();
  });
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
  if (/(?:CA\s*125|CA125)/iu.test(warning)) {
    return `lab:ca125:${reviewWarningReasonKey(warning)}`;
  }
  if (/(経腟|経膣|超音波|エコー)/u.test(warning)) {
    return `procedure:ultrasound:${reviewWarningReasonKey(warning)}`;
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
