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
  feeCalculator
} = {}) {
  const manualOptions = manualCalculationOptions(session, calculationInput);
  if (isPlainObject(session.claimContext) || isPlainObject(calculationInput.claimContext)) {
    return {
      calculationOptions: Object.keys(manualOptions).length ? manualOptions : null,
      calculationOptionsAutoKeys: [],
      calculationOptionsSource: Object.keys(manualOptions).length ? "manual" : null,
      reviewWarnings: []
    };
  }

  const text = normalizeClinicalText(calculationInput.clinicalText || session.clinicalText || "");
  const inferred = {};
  const reviewWarnings = [];

  if (text) {
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
  }

  const autoKeys = Object.keys(inferred).filter((key) => (
    CLINICAL_AUTO_OPTION_KEYS.has(key) && !hasOwn(manualOptions, key)
  ));
  const merged = mergeCalculationOptions(manualOptions, inferred);
  return {
    calculationOptions: Object.keys(merged).length ? merged : null,
    calculationOptionsAutoKeys: autoKeys,
    calculationOptionsSource: calculationOptionsSource(manualOptions, autoKeys),
    reviewWarnings
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

function inferOutpatientBasicOptions(text) {
  for (const sentence of splitClinicalSentences(text)) {
    if (isNegatedContext(sentence) || isFutureOrOrderOnlyContext(sentence)) {
      continue;
    }
    if (/(初診|初回受診|初めて|初来院)/u.test(sentence)) {
      return { fee_kind: "initial" };
    }
    if (/(再診|再来|フォロー|経過観察|再評価)/u.test(sentence)) {
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
  return /(\d+\s*(?:日|週間|週|月)後|予定|次回|後日|紹介|持参|検討|依頼|オーダー|予約|後で|今後)/u.test(sentence);
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

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(Object(object), key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
