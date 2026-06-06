import { extractFeeClinicalFactsWithOpenAi } from "../../../packages/medical-core/src/fee/openai-fee-clinical-facts.js";

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

const CLINICAL_DRUG_TERMS = [
  { query: "ロキソプロフェン", patterns: [/ロキソプロフェン/u, /ロキソニン/u] },
  { query: "レバミピド", patterns: [/レバミピド/u, /ムコスタ/u] },
  { query: "ロコアテープ", patterns: [/ロコア/u, /ロコアテープ/u] },
  { query: "ゲーベンクリーム", patterns: [/ゲーベン/u, /ゲーベンクリーム/u] },
  { query: "アムロジピン", patterns: [/アムロジピン/u] },
  { query: "カルボシステイン", patterns: [/カルボシステイン/u] }
];

const CLINICAL_MATERIAL_TERMS = [
  { query: "コルセット", patterns: [/コルセット/u] },
  { query: "非固着性シリコンガーゼ", patterns: [/ノンスティックガーゼ/u, /非固着性.*ガーゼ/u] }
];

const CLINICAL_AUTO_OPTION_KEYS = new Set([
  "outpatient_basic",
  "imaging_orders",
  "treatment_orders",
  "medication_orders",
  "medication",
  "material_inputs"
]);

export async function buildClinicalCalculationPreparation({
  session = {},
  calculationInput = {},
  feeCalculator,
  openAiApiKey = "",
  openAiModel = "gpt-5.4-nano",
  openAiReasoningEffort = "low",
  openAiTimeoutMs = 0,
  clinicalFactsExtractor = null
} = {}) {
  const manualOptions = manualCalculationOptions(session, calculationInput);
  if (isPlainObject(session.claimContext) || isPlainObject(calculationInput.claimContext)) {
    return {
      calculationOptions: Object.keys(manualOptions).length ? manualOptions : null,
      calculationOptionsAutoKeys: [],
      calculationOptionsSource: Object.keys(manualOptions).length ? "manual" : null,
      diagnoses: [],
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
    const ruleBased = await inferRuleBasedClinicalCalculationOptions({
      text,
      session,
      feeCalculator: ruleMetrics.calculator
    });
    metrics.ruleBasedClinicalInference = {
      durationMs: Date.now() - ruleStartedAt,
      ...ruleMetrics.snapshot()
    };

    if (structured.used) {
      Object.assign(inferred, normalizeClinicalInferredOptions(
        mergeCalculationOptions(structured.inferred, ruleBased.inferred)
      ));
      inferredDiagnoses.push(...asArray(structured.diagnoses));
      reviewWarnings.push(...structured.reviewWarnings, ...ruleBased.reviewWarnings);
    } else {
      Object.assign(inferred, ruleBased.inferred);
      reviewWarnings.push(...structured.reviewWarnings, ...ruleBased.reviewWarnings);
    }
  }

  const normalizedInferred = normalizeClinicalInferredOptions(inferred);
  const autoKeys = Object.keys(normalizedInferred).filter((key) => (
    CLINICAL_AUTO_OPTION_KEYS.has(key) && !hasOwn(manualOptions, key)
  ));
  const merged = normalizeClinicalInferredOptions(mergeCalculationOptions(manualOptions, normalizedInferred));
  return {
    calculationOptions: Object.keys(merged).length ? merged : null,
    calculationOptionsAutoKeys: autoKeys,
    calculationOptionsSource: calculationOptionsSource(manualOptions, autoKeys),
    diagnoses: normalizeClinicalDiagnoses(inferredDiagnoses),
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

async function clinicalFactsToCalculationOptions(facts = {}, { text = "", session = {}, feeCalculator } = {}) {
  const inferred = {};
  const diagnoses = diagnosesFromClinicalFacts(facts);
  const reviewWarnings = [];
  const imagingOrders = [];
  const treatmentOrders = [];
  const medicationOrders = [];
  const materialInputs = [];

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
      const imaging = imagingOrderFromClinicalEvent(event);
      if (imaging.order) imagingOrders.push(imaging.order);
      reviewWarnings.push(...imaging.reviewWarnings);
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

    const warning = unsupportedClinicalEventWarning(event);
    if (warning) reviewWarnings.push(warning);
  }

  if (imagingOrders.length) {
    inferred.imaging_orders = dedupeObjects(imagingOrders);
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
    reviewWarnings: normalizeReviewWarnings(reviewWarnings)
  };
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

function inferImagingOrders(text) {
  const orders = [];
  const reviewWarnings = [];
  const sentences = splitClinicalSentences(text);

  for (const sentence of sentences) {
    if (isNegatedContext(sentence)) {
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

  for (const term of CLINICAL_DRUG_TERMS) {
    const sentence = findSentenceForTerm(text, term);
    if (!sentence) {
      continue;
    }
    if (isHistoricalMedicationContext(sentence)) {
      continue;
    }
    if (!isCurrentPrescriptionContext(sentence)) {
      reviewWarnings.push(`薬剤「${term.query}」は今回処方として確定できないため、算定候補には入れていません。`);
      continue;
    }
    const quantity = inferMedicationQuantity(sentence, term.query);
    if (!hasCalculableMedicationQuantity(quantity)) {
      reviewWarnings.push(`薬剤「${term.query}」は数量または日数が不足しているため、算定候補には入れていません。`);
      continue;
    }
    const item = await searchFirstMasterItem(feeCalculator, "drug", term.query, "drug");
    if (!item?.code) {
      reviewWarnings.push(`薬剤「${term.query}」をマスターコードへ解決できませんでした。`);
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

function inferMedicationQuantity(text, query) {
  const escaped = escapeRegExp(query);
  const nearby = text.match(new RegExp(`.{0,30}${escaped}.{0,80}`, "u"))?.[0] || text;
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
  for (const term of CLINICAL_MATERIAL_TERMS) {
    const sentence = findSentenceForTerm(text, term);
    if (!sentence) {
      continue;
    }
    if (!isCurrentMaterialUseContext(sentence)) {
      reviewWarnings.push(`特定器材・材料「${term.query}」は今回使用として確定できないため、算定候補には入れていません。`);
      continue;
    }
    const item = await searchFirstMasterItem(feeCalculator, "material", term.query, "material");
    if (!item?.code) {
      reviewWarnings.push(`特定器材・材料「${term.query}」をマスターコードへ解決できませんでした。`);
      continue;
    }
    inputs.push({ code: String(item.code), quantity: "1" });
  }
  return {
    inputs: dedupeObjects(inputs, (item) => item.code),
    reviewWarnings
  };
}

function buildFeeSessionContext(session = {}) {
  return {
    patientDisplayName: session.patientSnapshot?.displayName || "",
    facilityName: session.facilitySnapshot?.displayName || "",
    departmentName: session.departmentSnapshot?.displayName || "",
    serviceDate: session.serviceDate || "",
    billingMonth: session.billingMonth || "",
    visitType: session.visitType || "",
    diagnoses: asArray(session.diagnoses)
      .map((diagnosis) => diagnosis?.name || diagnosis?.displayName || diagnosis)
      .map((name) => String(name || "").trim())
      .filter(Boolean)
      .slice(0, 20)
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
  return String(value || "")
    .replace(/^\s*(?:病名|診断名)\s*[:：]\s*/u, "")
    .trim()
    .slice(0, 120);
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

  if (type === "imaging" && ["planned", "ordered"].includes(status)) {
    return `${name}は予定・依頼として記載されているため、今回算定候補には入れていません。実施済みの場合は内容を確認してください。`;
  }
  if (type === "medication" && status === "history") {
    return `薬剤「${name}」は既往薬・内服中として記載されているため、今回処方の算定候補には入れていません。`;
  }
  if (type === "medication" && ["planned", "ordered", "instruction_only", "unclear"].includes(status)) {
    return `薬剤「${name}」は今回処方として確定できないため、算定候補には入れていません。`;
  }
  if (type === "material" && status === "instruction_only") {
    return `特定器材・材料「${name}」は指導・説明のみとして記載されているため、算定候補には入れていません。`;
  }
  if (type === "material" && ["planned", "ordered", "unclear"].includes(status)) {
    return `特定器材・材料「${name}」は今回使用として確定できないため、算定候補には入れていません。`;
  }
  if (reason && ["planned", "ordered", "instruction_only", "history", "negated", "unclear"].includes(status)) {
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
    .filter(Boolean);
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

function imagingOrderFromClinicalEvent(event = {}) {
  const reviewWarnings = [];
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
      reviewWarnings
    };
  }

  if (kind === "ultrasound") {
    reviewWarnings.push(`${clinicalEventName(event) || "超音波検査"}は超音波検査として抽出しましたが、現在の自動算定では超音波検査コード確定が未対応です。実施内容をマスター検索で確認してください。`);
    return { order: null, reviewWarnings };
  }

  if (kind) {
    reviewWarnings.push(`${clinicalEventName(event) || clinicalImagingDisplayName(event)}は現在の算定ルールで直接候補化できないため、要確認です。`);
  }
  return { order: null, reviewWarnings };
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
  const name = clinicalEventName(event);
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

function findSentenceForTerm(text, term) {
  return splitClinicalSentences(text).find((sentence) => term.patterns.some((pattern) => pattern.test(sentence))) || "";
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
  return uniqueStrings(values)
    .filter((warning) => !isLowValueClinicalReviewWarning(warning))
    .slice(0, 20);
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
