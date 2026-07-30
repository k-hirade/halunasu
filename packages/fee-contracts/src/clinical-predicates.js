export function normalizeClinicalPredicateText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "");
}

const CLINICAL_SENTENCE_BOUNDARY_PATTERN = /[。．.!！?？；;\n\r]/u;
const CLINICAL_CLAUSE_BOUNDARY_PATTERN = /[、，,]/u;
const CLINICAL_OPEN_PAREN_PATTERN = /[（(【［\[]/u;
const CLINICAL_CLOSE_PAREN_PATTERN = /[）)】］\]]/u;
const CLINICAL_PERFORMED_ACT_PATTERN = /(?:実施|施行|行(?:った|いました|い)|した|採取|提出|測定|撮影|交換|交付|発行|投与|処置|指導|説明|装着|抜去|留置|吸引|洗浄|縫合|切開|算定)/u;
const CLINICAL_GOVERNING_SCOPE_PATTERN = /(?:前回|先月|以前|過去|他院|前医|他科|紹介元|持参|健診|検診|外部資料|次回|後日|今後|予定)/u;
const CLINICAL_GOVERNING_PREFIX_ONLY_PATTERN = /^(?:本日|今回|当日|前回|先月|以前|過去|他院|前医|他科|紹介元|持参|健診|検診|外部資料|次回|後日|今後)(?:は|も|で|では|について)?[、，,]?$/u;

export function splitClinicalEvidenceClauses(value = "", options = {}) {
  const text = String(value || "");
  const clauses = [];
  let start = 0;
  let sentenceIndex = 0;
  let parentheticalDepth = 0;
  const append = (rawStart, rawEnd, separatorAfter = "") => {
    const raw = text.slice(rawStart, rawEnd);
    const leading = raw.search(/\S/u);
    if (leading < 0) {
      return;
    }
    const trimmedRight = raw.trimEnd();
    if (/^[、，,。．.!！?？；;（）()【】［］\[\]]+$/u.test(trimmedRight.trim())) {
      return;
    }
    const startUtf16 = rawStart + leading;
    const endUtf16 = rawStart + trimmedRight.length;
    clauses.push({
      clauseId: `${String(options.lineId || "L")}:C${String(clauses.length + 1).padStart(3, "0")}`,
      text: text.slice(startUtf16, endUtf16),
      charStart: codePointLength(text.slice(0, startUtf16)),
      charEnd: codePointLength(text.slice(0, endUtf16)),
      startUtf16,
      endUtf16,
      sentenceIndex,
      parentheticalDepth,
      separatorAfter
    });
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (CLINICAL_OPEN_PAREN_PATTERN.test(char)) {
      append(start, index, char);
      start = index + 1;
      parentheticalDepth += 1;
      continue;
    }
    if (CLINICAL_CLOSE_PAREN_PATTERN.test(char) && parentheticalDepth > 0) {
      append(start, index, char);
      start = index + 1;
      parentheticalDepth = Math.max(0, parentheticalDepth - 1);
      continue;
    }
    if (
      CLINICAL_SENTENCE_BOUNDARY_PATTERN.test(char)
      && !isDecimalPoint(text, index)
    ) {
      append(start, index + 1, char);
      start = index + 1;
      sentenceIndex += 1;
      continue;
    }
    if (CLINICAL_CLAUSE_BOUNDARY_PATTERN.test(char)) {
      append(start, index + 1, char);
      start = index + 1;
    }
  }
  append(start, text.length);
  if (!clauses.length && text.trim()) {
    append(0, text.length);
  }
  return mergeGoverningPrefixClauses(clauses, text, options.lineId);
}

export function hasPerformedClinicalServiceEvidence(value = "") {
  const normalized = normalizeClinicalPredicateText(value);
  return Boolean(
    normalized
    && CLINICAL_PERFORMED_ACT_PATTERN.test(normalized)
    && !isNegatedClinicalServiceContext(normalized)
  );
}

export function resolveClinicalServiceMentionScope(value = "", mentions = []) {
  const text = String(value || "").trim();
  const mentionValues = (Array.isArray(mentions) ? mentions : [mentions])
    .map(normalizeClinicalPredicateText)
    .filter((mention) => mention.length >= 2);
  const clauses = splitClinicalEvidenceClauses(text);
  if (!text || !mentionValues.length || !clauses.length) {
    return {
      scopedText: text,
      strategy: !text ? "empty_context" : "no_scope_mentions",
      matchedClauses: [],
      clauses
    };
  }
  const matchedClauses = clauses.filter((clause) => {
    const normalizedClause = normalizeClinicalPredicateText(clause.text);
    return mentionValues.some((mention) => (
      normalizedClause.includes(mention) || mention.includes(normalizedClause)
    ));
  });
  if (!matchedClauses.length) {
    return {
      scopedText: text,
      strategy: "fallback_full_context_no_matched_clause",
      matchedClauses: [],
      clauses
    };
  }

  const performedClauses = matchedClauses.filter((clause) => (
    hasPerformedClinicalServiceEvidence(clause.text)
  ));
  const selected = performedClauses.length ? performedClauses : matchedClauses;
  const withGovernors = selected.flatMap((clause) => {
    const previous = nearestGoverningClause(clauses, clause);
    return previous ? [previous, clause] : [clause];
  });
  const unique = uniqueClauses(withGovernors);
  return {
    scopedText: unique.map((clause) => clause.text).join(""),
    strategy: performedClauses.length ? "performed_mention_clauses" : "matched_mention_clauses",
    matchedClauses: selected,
    clauses: unique
  };
}

export function clinicalServiceContextCuesForMention(value = "", mentions = []) {
  const scope = resolveClinicalServiceMentionScope(value, mentions);
  return {
    ...clinicalServiceContextCues(scope.scopedText),
    performedEvidence: hasPerformedClinicalServiceEvidence(scope.scopedText),
    scopedText: scope.scopedText,
    scopeStrategy: scope.strategy,
    matchedClauses: scope.matchedClauses
  };
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
  return /(未実施|未施行|行わず|行っていない|行っていません|施行せず|施行していない|実施せず|実施していない|実施しなかった|撮影せず|撮影していない|検査せず|検査していない|撮影なし|検査なし|中止)/u.test(normalized);
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
  const context = clinicalServiceContextCuesForMention(text, [
    "静脈採血",
    "採血",
    "血液検体",
    "血液検査",
    "静脈血",
    "末梢血",
    "血清",
    "血漿"
  ]);
  const normalized = normalizeClinicalPredicateText(context.scopedText);
  if (
    !normalized
    || context.negatedService
    || context.futureOrOrderOnly
    || context.pastOrExternal
    || hasBloodCollectionNegationOrPlanningContext(context.scopedText)
  ) {
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
  const context = clinicalServiceContextCuesForMention(text, [
    "静脈採血",
    "採血",
    "血液検体",
    "血液検査"
  ]);
  const normalized = normalizeClinicalPredicateText(context.scopedText);
  return context.negatedService
    || context.futureOrOrderOnly
    || /(?:採血|静脈採血|血液検体|血液検査).*(?:必要性|必要|検討|判断|同意|不要)|(?:必要性|必要|検討|判断|同意).*(?:採血|静脈採血|血液検体|血液検査)/u.test(normalized);
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

function nearestGoverningClause(clauses, clause) {
  const index = clauses.indexOf(clause);
  if (index <= 0) {
    return null;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = clauses[cursor];
    if (previous.sentenceIndex !== clause.sentenceIndex) {
      break;
    }
    const normalized = normalizeClinicalPredicateText(previous.text);
    if (hasCurrentVisitClinicalServiceContext(normalized)) {
      return previous;
    }
    if (CLINICAL_GOVERNING_SCOPE_PATTERN.test(normalized)) {
      return previous;
    }
  }
  return null;
}

function uniqueClauses(clauses) {
  const seen = new Set();
  return clauses
    .filter((clause) => {
      const key = `${clause.startUtf16}:${clause.endUtf16}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.startUtf16 - right.startUtf16);
}

function codePointLength(value = "") {
  return Array.from(String(value || "")).length;
}

function isDecimalPoint(text, index) {
  const char = text[index];
  if (char !== "." && char !== "．") {
    return false;
  }
  return /\d/u.test(text[index - 1] || "") && /\d/u.test(text[index + 1] || "");
}

function mergeGoverningPrefixClauses(clauses, text, lineId = "L") {
  const merged = [];
  for (let index = 0; index < clauses.length; index += 1) {
    const current = clauses[index];
    const next = clauses[index + 1];
    const normalized = normalizeClinicalPredicateText(current.text);
    if (
      next
      && current.sentenceIndex === next.sentenceIndex
      && current.parentheticalDepth === next.parentheticalDepth
      && CLINICAL_GOVERNING_PREFIX_ONLY_PATTERN.test(normalized)
    ) {
      merged.push({
        ...current,
        text: text.slice(current.startUtf16, next.endUtf16),
        charEnd: next.charEnd,
        endUtf16: next.endUtf16,
        separatorAfter: next.separatorAfter
      });
      index += 1;
    } else {
      merged.push(current);
    }
  }
  return merged.map((clause, index) => ({
    ...clause,
    clauseId: `${String(lineId || "L")}:C${String(index + 1).padStart(3, "0")}`
  }));
}
