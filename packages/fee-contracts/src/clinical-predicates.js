export function normalizeClinicalPredicateText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "");
}

export function isPastOrExternalClinicalServiceContext(value = "") {
  const normalized = normalizeClinicalPredicateText(value);
  return /(前回|先月|以前|過去|過去値|既知値|持参|他院|前医|他科|紹介元|かかりつけ|健診|検診|外部資料|院外|外部|前に|過去に)/u.test(normalized);
}

export function hasPerformedBloodCollectionEvidence(input = {}) {
  if (typeof input === "string") {
    return hasPerformedBloodCollectionEvidenceInText(input);
  }

  if (hasStructuredBloodCollectionEvidence(input)) {
    return true;
  }

  return hasPerformedBloodCollectionEvidenceInText([
    input?.name,
    input?.eventName,
    input?.evidence,
    input?.text
  ].filter(Boolean).join("\n"));
}

export function hasPerformedBloodCollectionEvidenceInText(text = "") {
  const normalized = normalizeClinicalPredicateText(text);
  if (!normalized || hasBloodCollectionNegationOrPlanningContext(normalized)) {
    return false;
  }

  if (/(?:静脈採血|採血)(?:を|も|は)?(?:実施|施行|行(?:った|い)|した|あり)/u.test(normalized)) {
    return true;
  }
  if (/(?:静脈採血|採血)(?:後|の後)?(?:に)?(?:血液)?検体(?:を)?提出/u.test(normalized)) {
    return true;
  }
  if (/(?:静脈採血|採血)で(?![^。\n]{0,30}(?:必要性|必要|検討|判断|予定|同意|未実施|実施なし))[^。\n]{0,80}(?:測定|提出|検査|評価|確認)/u.test(normalized)) {
    return true;
  }
  if (/血液検体(?:を)?(?:採取|提出)/u.test(normalized)) {
    return true;
  }
  if (/(?:血清|血漿|末梢血|静脈血)(?:を|で)?(?:採取|提出)/u.test(normalized)) {
    return true;
  }

  return false;
}

export function hasBloodCollectionNegationOrPlanningContext(text = "") {
  const normalized = normalizeClinicalPredicateText(text);
  return /(?:採血|静脈採血|血液検体|血液検査).{0,18}(?:必要性|必要|検討|判断|予定|同意|未実施|実施なし|行わず|不要)|(?:必要性|必要|検討|判断|予定|同意).{0,18}(?:採血|静脈採血|血液検体|血液検査)/u.test(normalized);
}

export function hasStructuredBloodCollectionEvidence(input = {}) {
  const structuredText = normalizeClinicalPredicateText([
    input?.specimen,
    input?.sample,
    input?.collectionMethod,
    input?.collection_method,
    input?.payload?.specimen,
    input?.payload?.sample,
    input?.payload?.collectionMethod,
    input?.payload?.collection_method
  ].filter(Boolean).join("\n"));

  if (!structuredText) {
    return false;
  }

  return /blood|serum|plasma|venous|血液|血清|血漿|末梢血|静脈血|静脈採血|採血|血液検体|blood_venous/iu.test(structuredText);
}

export function isClinicalDateRatioFalsePositiveContext(text = "") {
  return /(血圧|BP|mmHg|脈拍|HR|SpO2|SPO2|酸素飽和度|体温|BT|BMI|身長|体重|回\/分|\/分|mg\/dL|g\/dL|mL\/min|μL|mm3|前回比|比率|割合|%|％|NRS|VAS|疼痛|痛み|ペイン|スケール|score|スコア|10点満点)/iu.test(text);
}
