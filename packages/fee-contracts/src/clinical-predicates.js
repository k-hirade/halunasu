export function normalizeClinicalPredicateText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "");
}

export function isPastOrExternalClinicalServiceContext(value = "") {
  const normalized = normalizeClinicalPredicateText(value)
    // "院外処方" is this clinic's delivery method, not another provider.
    .replace(/院外(?:で(?:の)?)?処方(?:箋|せん)?/gu, "処方箋")
    .replace(/処方(?:箋|せん)?(?:は|を)?院外/gu, "処方箋");
  return /(前回|先月|以前|過去|過去値|既知値|持参|他院|前医|他科|紹介元|かかりつけ|健診|検診|外部資料|院外|外部|前に|過去に)/u.test(normalized);
}

export function isFutureOrOrderOnlyClinicalServiceContext(value = "") {
  const normalized = normalizeClinicalPredicateText(value);
  return /(\d+\s*(?:日|週間|週|か月|カ月|ヶ月|ケ月|月)後|予定|次回|後日|紹介|持参|検討|依頼|オーダー|予約|後で|今後)/u.test(normalized);
}

export function isNegatedClinicalServiceContext(value = "") {
  const normalized = normalizeClinicalPredicateText(value);
  return /(未実施|未施行|行わず|行っていない|行っていません|施行せず|施行していない|実施していない|撮影せず|撮影していない|検査せず|検査していない|撮影なし|検査なし|中止)/u.test(normalized);
}

export function hasCurrentVisitClinicalServiceContext(value = "") {
  const normalized = normalizeClinicalPredicateText(value);
  return /(本日|今回|当日|外来|来院|受診|診察|診療|継続診療|定期受診|再来)/u.test(normalized);
}

export function clinicalServiceContextCues(value = "") {
  return {
    futureOrOrderOnly: isFutureOrOrderOnlyClinicalServiceContext(value),
    negatedService: isNegatedClinicalServiceContext(value),
    pastOrExternal: isPastOrExternalClinicalServiceContext(value),
    currentVisit: hasCurrentVisitClinicalServiceContext(value)
  };
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
