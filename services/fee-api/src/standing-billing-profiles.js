import crypto from "node:crypto";

const PROFILE_FACT_TYPE = "monthly_management_fee";
const ACTIVE_STATUS = "active";
const STOPPED_STATUSES = new Set(["suspended", "ended"]);
const STOP_WORDS = /(?:中止|終了|離脱|抜去|退院|死亡)/u;
const CONTINUATION_WORDS = /(?:継続|維持|続行|使用中|管理中)/u;
const NON_FINAL_STOP_CONTEXT = /(?:中止|終了|離脱|抜去).{0,16}(?:検討|考慮|予定|相談|可能性|見送り).{0,24}(?:継続|維持|続行|使用中|管理中)/u;

export function standingBillingProfileId({
  orgId,
  facilityId,
  canonicalPatientId,
  feeFamily
} = {}) {
  const values = [
    requiredValue(orgId, "orgId"),
    requiredValue(facilityId, "facilityId"),
    requiredValue(canonicalPatientId, "canonicalPatientId"),
    requiredValue(feeFamily, "feeFamily")
  ];
  return `standing_${sha256(values.join("\u001f")).slice(0, 32)}`;
}

export function standingBillingEvidenceKey({
  type,
  ref,
  claimMonth = ""
} = {}) {
  return `evidence_${sha256([
    requiredValue(type, "type"),
    requiredValue(ref, "ref"),
    String(claimMonth || "").trim()
  ].join("\u001f")).slice(0, 32)}`;
}

export function applyStandingBillingEvidence(current, input = {}, { now = new Date() } = {}) {
  const timestamp = isoTimestamp(now);
  const claimMonth = normalizeClaimMonth(input.claimMonth);
  const family = normalizeFamilyReference(input.family);
  const standingFactId = standingBillingProfileId({
    orgId: input.orgId,
    facilityId: input.facilityId,
    canonicalPatientId: input.canonicalPatientId,
    feeFamily: family.familyId
  });
  const evidence = normalizeEvidence({
    ...input.evidence,
    claimMonth,
    observedAt: input.evidence?.observedAt || timestamp
  });
  const codes = normalizeConfirmedCodes(input.codes, claimMonth);
  if (!codes.length) {
    throw new TypeError("codes requires at least one confirmed code");
  }

  const base = current ? structuredClone(current) : {
    standingFactId,
    orgId: requiredValue(input.orgId, "orgId"),
    facilityId: requiredValue(input.facilityId, "facilityId"),
    canonicalPatientId: requiredValue(input.canonicalPatientId, "canonicalPatientId"),
    factType: PROFILE_FACT_TYPE,
    feeFamily: family.familyId,
    feeFamilyName: family.name,
    feeFamilySource: family.source || null,
    lastConfirmedCodes: [],
    confirmedOccurrences: [],
    evidence: [],
    firstConfirmedAt: timestamp,
    lastConfirmedClaimMonth: claimMonth,
    status: ACTIVE_STATUS,
    statusReason: "confirmed_claim",
    manualStop: {
      stopped: false,
      byMemberId: null,
      at: null,
      note: ""
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: 1
  };
  assertProfileIdentity(base, {
    standingFactId,
    orgId: input.orgId,
    facilityId: input.facilityId,
    canonicalPatientId: input.canonicalPatientId,
    feeFamily: family.familyId
  });

  const evidenceByKey = new Map(asArray(base.evidence)
    .filter((entry) => String(entry?.evidenceKey || "").trim())
    .map((entry) => [String(entry.evidenceKey), entry]));
  if (!evidenceByKey.has(evidence.evidenceKey)) {
    evidenceByKey.set(evidence.evidenceKey, evidence);
  }

  const occurrencesByKey = new Map(asArray(base.confirmedOccurrences)
    .filter((entry) => String(entry?.evidenceKey || "").trim())
    .map((entry) => [String(entry.evidenceKey), entry]));
  occurrencesByKey.set(evidence.evidenceKey, {
    claimMonth,
    codes: codes.map((entry) => entry.code),
    evidenceKey: evidence.evidenceKey
  });
  const priorLastConfirmedClaimMonth = base.lastConfirmedClaimMonth
    ? normalizeClaimMonth(base.lastConfirmedClaimMonth)
    : "";
  const lastConfirmedClaimMonth = maxClaimMonth(priorLastConfirmedClaimMonth, claimMonth);
  const lastConfirmedCodes = mergeLatestConfirmedCodes({
    current: base.lastConfirmedCodes,
    currentClaimMonth: priorLastConfirmedClaimMonth,
    incoming: codes,
    incomingClaimMonth: claimMonth
  });
  const maxWindowMonths = Math.max(1, Number(input.maxWindowMonths || family.maxWindowMonths || 1));
  const oldestRetainedMonth = addMonths(lastConfirmedClaimMonth, -(maxWindowMonths - 1));
  const confirmedOccurrences = [...occurrencesByKey.values()]
    .filter((entry) => normalizeClaimMonth(entry.claimMonth) >= oldestRetainedMonth)
    .sort((left, right) => (
      String(left.claimMonth).localeCompare(String(right.claimMonth))
      || String(left.evidenceKey).localeCompare(String(right.evidenceKey))
    ));
  const manualStop = normalizeManualStop(base.manualStop);
  const ended = manualStop.stopped === true || base.status === "ended";

  return {
    ...base,
    feeFamilyName: family.name || base.feeFamilyName || "",
    feeFamilySource: family.source || base.feeFamilySource || null,
    lastConfirmedCodes,
    confirmedOccurrences,
    evidence: [...evidenceByKey.values()].sort((left, right) => (
      String(left.observedAt).localeCompare(String(right.observedAt))
      || String(left.evidenceKey).localeCompare(String(right.evidenceKey))
    )),
    firstConfirmedAt: base.firstConfirmedAt || timestamp,
    lastConfirmedClaimMonth,
    status: ended ? "ended" : ACTIVE_STATUS,
    statusReason: ended ? "manual_stop" : "confirmed_claim",
    manualStop,
    updatedAt: timestamp
  };
}

export function applyStandingBillingStatus(current, input = {}, { now = new Date() } = {}) {
  if (!current) {
    throw new TypeError("standing billing profile is required");
  }
  const timestamp = isoTimestamp(now);
  const manualStop = normalizeManualStop(current.manualStop);
  if (manualStop.stopped || current.status === "ended") {
    return {
      ...current,
      status: "ended",
      statusReason: "manual_stop",
      manualStop,
      updatedAt: timestamp
    };
  }
  const status = String(input.status || "").trim();
  if (!["active", "suspended"].includes(status)) {
    throw new TypeError("status must be active or suspended");
  }
  return {
    ...current,
    status,
    statusReason: String(input.statusReason || input.reason || "").trim() || (
      status === "active" ? "manual_resume" : "standing_fact_suspended"
    ),
    updatedAt: timestamp
  };
}

export function applyStandingBillingManualState(current, input = {}, { now = new Date() } = {}) {
  if (!current) {
    throw new TypeError("standing billing profile is required");
  }
  const timestamp = isoTimestamp(now);
  const stopped = input.stopped === true;
  return {
    ...current,
    status: stopped ? "ended" : "active",
    statusReason: stopped ? "manual_stop" : "manual_resume",
    manualStop: {
      stopped,
      byMemberId: requiredValue(input.byMemberId, "byMemberId"),
      at: timestamp,
      note: String(input.note || "").trim().slice(0, 1000)
    },
    updatedAt: timestamp
  };
}

export function buildStandingBillingLane({
  profiles = [],
  catalog = null,
  serviceDate = "",
  historyCompleteness = "complete",
  standingMentions = [],
  stalenessMonths = 3,
  currentInputs = {}
} = {}) {
  const claimMonth = normalizeClaimMonth(String(serviceDate || "").slice(0, 7));
  const families = asArray(catalog?.families);
  const familyById = new Map(families.map((family) => [String(family?.familyId || ""), family]));
  const normalizedMentions = normalizeStandingMentions(standingMentions);
  const matches = matchStandingMentionsToFamilies(normalizedMentions, families);
  const matchedFamiliesById = groupMatchesByFamily(matches);
  const existingProfileFamilyIds = new Set(asArray(profiles).map((profile) => String(profile?.feeFamily || "")));
  const candidateProposals = [];
  const reviewIssues = [];
  const statusTransitions = [];
  const reasons = {};
  let activeCount = 0;
  let suspendedCount = 0;

  const countReason = (reason) => {
    reasons[reason] = Number(reasons[reason] || 0) + 1;
  };

  for (const profile of asArray(profiles)) {
    const profileAsOfClaimMonth = standingProfileAsOf(profile, claimMonth);
    if (!profileAsOfClaimMonth) {
      countReason("future_only_evidence");
      continue;
    }
    const family = familyById.get(String(profile?.feeFamily || ""));
    if (!family) {
      countReason("family_not_in_current_master");
      reviewIssues.push(standingReviewIssue(profile, {
        code: "standing_family_unavailable",
        title: "恒常算定のマスター確認",
        message: `${profile?.feeFamilyName || "過去の月次管理料"}は現在のマスターで確認できません。改定・廃止・コード変更を確認してください。`
      }));
      continue;
    }
    if (profile?.manualStop?.stopped === true || profile?.status === "ended") {
      countReason("manual_stop");
      continue;
    }

    const familyMatches = matchedFamiliesById.get(family.familyId) || [];
    const stoppedMatch = familyMatches.find((match) => (
      match.mention.status === "stopped"
      && isFinalStandingStopText(match.mention.text || match.mention.target)
    ));
    if (stoppedMatch) {
      suspendedCount += 1;
      countReason("stopped_mention");
      statusTransitions.push({
        standingFactId: profile.standingFactId,
        status: "suspended",
        statusReason: "stopped_mention"
      });
      reviewIssues.push(standingReviewIssue(profile, {
        code: "standing_fact_stopped",
        title: `${family.name}の停止確認`,
        message: `${stoppedMatch.mention.target || family.name}の中止・終了記載があります。恒常算定候補を停止しました。`,
        evidence: stoppedMatch.mention.text || stoppedMatch.mention.target
      }));
      continue;
    }
    if (profile?.status === "suspended") {
      suspendedCount += 1;
      countReason(profile.statusReason || "suspended");
      reviewIssues.push(standingReviewIssue(profile, {
        code: "standing_fact_suspended",
        title: `${family.name}の継続確認`,
        message: `${family.name}は停止中です。再開する場合は内容を確認して明示的に再開してください。`
      }));
      continue;
    }
    if (standingProfileIsStale(profileAsOfClaimMonth, claimMonth, stalenessMonths)) {
      suspendedCount += 1;
      countReason("stale");
      statusTransitions.push({
        standingFactId: profile.standingFactId,
        status: "suspended",
        statusReason: "stale"
      });
      reviewIssues.push(standingReviewIssue(profile, {
        code: "standing_fact_stale",
        title: `${family.name}の継続確認`,
        message: `${family.name}は直近${boundedStalenessMonths(stalenessMonths)}か月に確定実績がありません。今月も対象か確認してください。`
      }));
      continue;
    }
    if (historyCompleteness === "unavailable") {
      countReason("history_unavailable");
      reviewIssues.push(standingReviewIssue(profile, {
        code: "standing_history_unavailable",
        title: `${family.name}の履歴確認`,
        message: "請求履歴を取得できないため、月次・複数月の回数上限を判定できません。履歴を確認してください。"
      }));
      continue;
    }

    activeCount += 1;
    const selected = selectStandingFamilyVariant(family, familyMatches, currentInputs);
    if (!selected.variant) {
      countReason(selected.reason);
      candidateProposals.push(standingFamilyChoiceProposal(profile, family, selected));
      continue;
    }
    const eligibility = standingFrequencyEligibility(profileAsOfClaimMonth, selected.variant, claimMonth);
    if (!eligibility.allowed) {
      countReason(eligibility.reason);
      continue;
    }
    candidateProposals.push(standingVariantProposal(profileAsOfClaimMonth, family, selected.variant, {
      evidence: selected.evidence,
      claimMonth
    }));
    countReason("proposed");
  }

  for (const matchGroup of groupedFirstMonthMatches(matches, existingProfileFamilyIds)) {
    const family = matchGroup.family;
    const selected = selectStandingFamilyVariant(family, matchGroup.matches, currentInputs);
    candidateProposals.push(standingFirstMonthProposal(family, selected, matchGroup.matches[0]?.mention));
    countReason("first_month_candidate");
  }

  const proposedCount = candidateProposals.length;
  return {
    candidateProposals: dedupeBy(candidateProposals, (entry) => entry.proposalId),
    reviewIssues: dedupeBy(reviewIssues, (entry) => entry.reviewIssueId),
    statusTransitions: dedupeBy(statusTransitions, (entry) => entry.standingFactId),
    metrics: {
      activeCount,
      proposedCount,
      suspendedCount,
      reasons
    },
    trace: {
      traceId: `trace_standing_fact_lane_${sha256(`${claimMonth}:${activeCount}:${proposedCount}`).slice(0, 16)}`,
      stage: "standing_fact_lane",
      outcome: proposedCount ? "candidate_proposed" : "no_candidate",
      activeCount,
      proposedCount,
      suspendedCount,
      reasons
    }
  };
}

export function isFinalStandingStopText(value) {
  const text = normalizeText(value);
  if (!text || !STOP_WORDS.test(text)) {
    return false;
  }
  if (NON_FINAL_STOP_CONTEXT.test(text)) {
    return false;
  }
  if (/(?:中止|終了|離脱|抜去).{0,12}(?:しない|せず|なし|不要)/u.test(text)) {
    return false;
  }
  if (/(?:継続|維持|続行).{0,20}(?:中止|終了).{0,12}(?:検討|予定|相談)/u.test(text)) {
    return false;
  }
  return !CONTINUATION_WORDS.test(text)
    || /(?:中止した|終了した|離脱した|抜去した|退院した|死亡した|中止とした|終了とした)/u.test(text);
}

export function standingFrequencyEligibility(profile = {}, variant = {}, claimMonth = "") {
  const month = normalizeClaimMonth(claimMonth);
  const occurrences = asArray(profile.confirmedOccurrences);
  const familyAlreadyConfirmedThisMonth = occurrences.some((entry) => (
    normalizeClaimMonth(entry?.claimMonth) === month
  ));
  if (familyAlreadyConfirmedThisMonth) {
    return { allowed: false, reason: "already_confirmed_current_month" };
  }
  for (const limit of asArray(variant.frequencyLimits)) {
    const windowMonths = Math.max(1, Number(limit?.windowMonths || 1));
    const maxCount = Math.max(1, Number(limit?.maxCount || 1));
    const startMonth = addMonths(month, -(windowMonths - 1));
    const occurrenceCount = occurrences.filter((entry) => {
      const value = normalizeClaimMonth(entry?.claimMonth);
      return value >= startMonth && value <= month;
    }).length;
    if (occurrenceCount >= maxCount) {
      return {
        allowed: false,
        reason: "rolling_limit_reached",
        occurrenceCount,
        maxCount,
        windowMonths
      };
    }
  }
  return { allowed: true, reason: "within_rolling_limit" };
}

function selectStandingFamilyVariant(family = {}, matches = [], currentInputs = {}) {
  const variants = asArray(family.variants);
  if (variants.length === 1) {
    return { variant: variants[0], reason: "single_variant", evidence: matches[0]?.mention?.text || "" };
  }
  const currentProcedureCodes = new Set(asArray(currentInputs?.procedureCodes)
    .map((value) => String(value || "").trim())
    .filter(Boolean));
  const currentCodeMatches = variants.filter((variant) => currentProcedureCodes.has(String(variant?.code || "")));
  if (currentCodeMatches.length === 1) {
    return {
      variant: currentCodeMatches[0],
      reason: "current_deterministic_code",
      evidence: "当月の決定論算定入力"
    };
  }

  let eligibleVariants = [...variants];
  const sameBuilding = currentInputs?.encounterDetails?.sameBuilding;
  if (typeof sameBuilding === "boolean") {
    const classified = eligibleVariants
      .map((variant) => ({ variant, value: sameBuildingVariantValue(variant) }))
      .filter((entry) => entry.value !== null);
    if (classified.length) {
      const matching = classified
        .filter((entry) => entry.value === sameBuilding)
        .map((entry) => entry.variant);
      if (!matching.length) {
        return unresolvedStandingVariant(variants, "same_building_variant_unresolved");
      }
      eligibleVariants = matching;
    }
  }

  const singleBuildingPatientCount = positiveIntegerOrNull(
    currentInputs?.encounterDetails?.singleBuildingPatientCount
  );
  if (singleBuildingPatientCount !== null) {
    const ranged = eligibleVariants
      .map((variant) => ({ variant, range: patientCountRange(variant) }))
      .filter((entry) => entry.range);
    if (ranged.length) {
      const matching = ranged
        .filter((entry) => (
          singleBuildingPatientCount >= entry.range.min
          && singleBuildingPatientCount <= entry.range.max
        ))
        .map((entry) => entry.variant);
      if (!matching.length) {
        return unresolvedStandingVariant(variants, "single_building_patient_count_unresolved");
      }
      eligibleVariants = matching;
    }
  }

  const currentMonthEncounterCount = positiveIntegerOrNull(currentInputs?.currentMonthEncounterCount);
  if (currentMonthEncounterCount !== null) {
    const ranged = eligibleVariants
      .map((variant) => ({ variant, range: monthlyVisitCountRange(variant) }))
      .filter((entry) => entry.range);
    if (ranged.length) {
      const matching = ranged
        .filter((entry) => (
          currentMonthEncounterCount >= entry.range.min
          && currentMonthEncounterCount <= entry.range.max
        ))
        .map((entry) => entry.variant);
      if (!matching.length) {
        return unresolvedStandingVariant(variants, "monthly_visit_count_unresolved");
      }
      eligibleVariants = matching;
    }
  }

  if (Array.isArray(currentInputs?.facilityStandardKeys)) {
    const activeStandards = new Set(currentInputs.facilityStandardKeys
      .map((value) => String(value || "").trim())
      .filter(Boolean));
    const compatible = eligibleVariants.filter((variant) => {
      const required = asArray(variant?.facilityStandardCodes)
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      return !required.length || required.some((code) => activeStandards.has(code));
    });
    if (!compatible.length && eligibleVariants.some((variant) => asArray(variant?.facilityStandardCodes).length)) {
      return unresolvedStandingVariant(variants, "facility_standard_unresolved");
    }
    eligibleVariants = compatible;
  }

  if (eligibleVariants.length === 1) {
    return {
      variant: eligibleVariants[0],
      reason: "current_encounter_variant",
      evidence: "当月の受診条件"
    };
  }

  const currentText = normalizeText(matches
    .filter((match) => match.mention.status !== "stopped")
    .map((match) => `${match.mention.target} ${match.mention.text}`)
    .join(" "));
  if (currentText) {
    const scored = eligibleVariants
      .map((variant) => ({
        variant,
        score: Math.max(0, ...asArray(variant.aliases).map((alias) => (
          currentText.includes(normalizeText(alias)) ? normalizeText(alias).length : 0
        )))
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || String(left.variant.code).localeCompare(String(right.variant.code)));
    if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) {
      return {
        variant: scored[0].variant,
        reason: "current_mention_variant_match",
        evidence: matches[0]?.mention?.text || matches[0]?.mention?.target || ""
      };
    }
  }
  return unresolvedStandingVariant(eligibleVariants.length ? eligibleVariants : variants, "variant_input_required");
}

function unresolvedStandingVariant(variants = [], reason = "variant_input_required") {
  return {
    variant: null,
    reason,
    codeCandidates: asArray(variants).map((variant) => variant.code)
  };
}

function sameBuildingVariantValue(variant = {}) {
  const text = normalizeText(`${variant.name || ""} ${variant.baseName || ""}`);
  if (!text.includes("同一建物")) {
    return null;
  }
  return !text.includes("同一建物居住者以外");
}

function patientCountRange(variant = {}) {
  const text = normalizedNumericText(`${variant.name || ""} ${variant.baseName || ""}`);
  const between = text.match(/(\d+)\s*(?:~|-|～|〜)\s*(\d+)\s*人/u);
  if (between) {
    return { min: Number(between[1]), max: Number(between[2]) };
  }
  const atLeast = text.match(/(\d+)\s*人以上/u);
  if (atLeast) {
    return { min: Number(atLeast[1]), max: Number.POSITIVE_INFINITY };
  }
  const exact = text.match(/(?:単一建物(?:診療)?患者(?:数)?[はが:]*)?(\d+)\s*人(?:の場合|$|\D)/u);
  if (exact) {
    return { min: Number(exact[1]), max: Number(exact[1]) };
  }
  return null;
}

function monthlyVisitCountRange(variant = {}) {
  const text = normalizedNumericText(`${variant.name || ""} ${variant.baseName || ""}`);
  const atLeast = text.match(/月\s*(\d+)\s*回以上/u);
  if (atLeast) {
    return { min: Number(atLeast[1]), max: Number.POSITIVE_INFINITY };
  }
  const exact = text.match(/月\s*(\d+)\s*回/u);
  if (exact) {
    return { min: Number(exact[1]), max: Number(exact[1]) };
  }
  return null;
}

function normalizedNumericText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‐‑–—―−]/gu, "-")
    .replace(/［/gu, "[")
    .replace(/］/gu, "]");
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function matchStandingMentionsToFamilies(mentions = [], families = []) {
  const results = [];
  for (const mention of mentions) {
    const mentionText = normalizeText(`${mention.target} ${mention.text}`);
    if (!mentionText) continue;
    for (const family of families) {
      const matchingAliases = asArray(family.aliases)
        .map((alias) => normalizeText(alias))
        .filter((alias) => alias.length >= 4 && (
          mentionText.includes(alias)
          || alias.includes(normalizeText(mention.target))
          || standingAliasSimilarity(alias, normalizeText(mention.target)) >= 0.4
        ))
        .sort((left, right) => right.length - left.length);
      if (matchingAliases.length) {
        results.push({ family, mention, alias: matchingAliases[0] });
      }
    }
  }
  return dedupeBy(results, (entry) => `${entry.family.familyId}:${entry.mention.lineId}:${entry.mention.target}:${entry.mention.status}`);
}

function standingAliasSimilarity(left = "", right = "") {
  const leftBigrams = characterBigrams(left);
  const rightBigrams = characterBigrams(right);
  if (!leftBigrams.size || !rightBigrams.size) {
    return 0;
  }
  const intersection = [...leftBigrams].filter((token) => rightBigrams.has(token)).length;
  const union = new Set([...leftBigrams, ...rightBigrams]).size;
  return union ? intersection / union : 0;
}

function characterBigrams(value = "") {
  const text = normalizeText(value)
    .replace(/(?:在宅|指導|療養|患者|管理料|加算)/gu, "");
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
}

function groupedFirstMonthMatches(matches = [], existingProfileFamilyIds = new Set()) {
  const groups = new Map();
  for (const match of matches) {
    if (match.mention.status === "stopped" || existingProfileFamilyIds.has(match.family.familyId)) {
      continue;
    }
    const current = groups.get(match.family.familyId) || { family: match.family, matches: [] };
    current.matches.push(match);
    groups.set(match.family.familyId, current);
  }
  return [...groups.values()];
}

function groupMatchesByFamily(matches = []) {
  const groups = new Map();
  for (const match of matches) {
    const current = groups.get(match.family.familyId) || [];
    current.push(match);
    groups.set(match.family.familyId, current);
  }
  return groups;
}

function standingVariantProposal(profile, family, variant, { evidence = "", claimMonth = "" } = {}) {
  const previousMonth = profile.lastConfirmedClaimMonth || "過去";
  const reason = `${previousMonth}に確定済みの月次管理料です。${claimMonth}も算定対象か確認してください。`;
  return {
    proposalId: `standing_${profile.standingFactId}_${variant.code}`,
    title: `${variant.name}の継続算定確認`,
    reason,
    conditionText: "当月の実施・管理内容、施設基準、対象病名、回数上限を確認してから採用してください。",
    basis: "standing_confirmed_history_candidate",
    evidence: String(evidence || "").slice(0, 160),
    actionType: "adoptable",
    potentialPoints: Number(variant.points || 0),
    code: String(variant.code || ""),
    orderType: "procedure",
    source: "standing_fact_lane",
    sortOrder: 35,
    candidateOnly: true,
    candidateLine: standingCandidateLine({
      proposalId: `standing_${profile.standingFactId}_${variant.code}`,
      variant,
      reason
    })
  };
}

function standingFamilyChoiceProposal(profile, family, selected) {
  return {
    proposalId: `standing_choice_${profile.standingFactId}`,
    title: `${family.name}の算定区分確認`,
    reason: `${profile.lastConfirmedClaimMonth || "過去"}に${family.name}の確定実績があります。当月条件に一致する区分を選択してください。`,
    conditionText: "先月のコードをそのまま使用せず、当月の訪問回数・単一建物人数・重症度・機器区分等を確認してください。",
    basis: "standing_confirmed_history_candidate",
    evidence: "",
    actionType: "confirm_required",
    potentialPoints: 0,
    code: "",
    codeCandidates: selected.codeCandidates || asArray(family.variants).map((variant) => variant.code),
    orderType: "procedure",
    source: "standing_fact_lane",
    sortOrder: 35,
    candidateOnly: true,
    candidateLine: null
  };
}

function standingFirstMonthProposal(family, selected, mention = {}) {
  const variant = selected.variant;
  const target = mention?.target || family.name;
  const reason = `${target}の継続管理記載があります。${family.name}の算定対象か確認してください。`;
  const proposalId = `standing_first_${family.familyId}${variant ? `_${variant.code}` : ""}`;
  return {
    proposalId,
    title: `${family.name}の初回算定確認`,
    reason,
    conditionText: "履歴のない初月候補です。実施事実・対象病名・施設基準・回数上限を確認し、人が承認した場合のみ以後の恒常算定履歴に登録します。",
    basis: "standing_mention_first_month_candidate",
    evidence: String(mention?.text || mention?.target || "").slice(0, 160),
    actionType: variant && Number(variant.points || 0) > 0 ? "adoptable" : "confirm_required",
    potentialPoints: variant ? Number(variant.points || 0) : 0,
    code: variant ? String(variant.code || "") : "",
    codeCandidates: variant ? undefined : asArray(family.variants).map((entry) => entry.code),
    orderType: "procedure",
    source: "standing_fact_lane",
    sortOrder: 36,
    candidateOnly: true,
    candidateLine: variant ? standingCandidateLine({ proposalId, variant, reason }) : null
  };
}

function standingCandidateLine({ proposalId, variant = {}, reason = "" } = {}) {
  const points = Number(variant.points || 0);
  return {
    lineId: `proposal_line_${String(proposalId || variant.code || "").replace(/[^\w-]/gu, "_")}`,
    code: String(variant.code || ""),
    name: String(variant.name || ""),
    orderType: "procedure",
    points,
    quantity: 1,
    totalPoints: points,
    status: "candidate",
    reason,
    source: "standing_fact_lane",
    coverage: {
      scope: "confirmed_history_and_current_master",
      chapter: "standing_management_fee",
      supportLevel: "review_required",
      reviewRequired: true
    },
    supportLevel: "review_required",
    reviewRequired: true
  };
}

function standingReviewIssue(profile = {}, {
  code,
  title,
  message,
  evidence = ""
} = {}) {
  return {
    reviewIssueId: `standing_${String(profile.standingFactId || "")}_${code}`,
    issueCode: code,
    severity: "warning",
    title,
    topicCode: "standing_fee_check",
    topicLabel: "恒常算定の確認",
    messageForStaff: message,
    evidence: String(evidence || "").slice(0, 200),
    requiredInput: "当月の管理継続・中止状況、施設基準、対象病名、回数上限",
    source: "standing_fact_lane"
  };
}

function standingProfileIsStale(profile = {}, claimMonth = "", stalenessMonths = 3) {
  const latestValue = String(profile.lastConfirmedClaimMonth || "").trim();
  if (!latestValue) {
    return true;
  }
  const latest = normalizeClaimMonth(latestValue);
  return monthDistance(latest, normalizeClaimMonth(claimMonth)) >= boundedStalenessMonths(stalenessMonths);
}

function standingProfileAsOf(profile = {}, claimMonth = "") {
  const month = normalizeClaimMonth(claimMonth);
  const eligibleOccurrences = asArray(profile.confirmedOccurrences)
    .filter((entry) => normalizeClaimMonth(entry?.claimMonth) <= month);
  if (eligibleOccurrences.length) {
    const latestMonth = eligibleOccurrences
      .map((entry) => normalizeClaimMonth(entry.claimMonth))
      .sort()
      .at(-1);
    return {
      ...profile,
      confirmedOccurrences: eligibleOccurrences,
      lastConfirmedClaimMonth: latestMonth
    };
  }
  const lastConfirmedClaimMonth = String(profile.lastConfirmedClaimMonth || "").trim();
  if (lastConfirmedClaimMonth && normalizeClaimMonth(lastConfirmedClaimMonth) <= month) {
    return profile;
  }
  return null;
}

function boundedStalenessMonths(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(6, Math.max(1, Number.isFinite(parsed) ? parsed : 3));
}

function normalizeFamilyReference(family = {}) {
  const variants = asArray(family.variants);
  const maxWindowMonths = Math.max(1, ...variants.flatMap((variant) => (
    asArray(variant.frequencyLimits).map((limit) => Number(limit?.windowMonths || 1))
  )));
  return {
    familyId: requiredValue(family.familyId, "family.familyId"),
    name: String(family.name || "").trim(),
    source: family.source || null,
    maxWindowMonths
  };
}

function normalizeEvidence(input = {}) {
  const type = requiredValue(input.type, "evidence.type");
  const ref = requiredValue(input.ref, "evidence.ref");
  const claimMonth = input.claimMonth ? normalizeClaimMonth(input.claimMonth) : "";
  return {
    evidenceKey: input.evidenceKey || standingBillingEvidenceKey({ type, ref, claimMonth }),
    type,
    ref,
    ...(claimMonth ? { claimMonth } : {}),
    observedAt: isoTimestamp(input.observedAt || new Date())
  };
}

function normalizeConfirmedCodes(values = [], claimMonth = "") {
  return dedupeBy(asArray(values).map((entry) => {
    if (typeof entry === "string") {
      return { code: entry.trim(), name: "", claimMonth };
    }
    return {
      code: String(entry?.code || "").trim(),
      name: String(entry?.name || "").trim(),
      claimMonth: normalizeClaimMonth(entry?.claimMonth || claimMonth)
    };
  }).filter((entry) => entry.code), (entry) => entry.code);
}

function mergeLatestConfirmedCodes({
  current = [],
  currentClaimMonth = "",
  incoming = [],
  incomingClaimMonth = ""
} = {}) {
  if (!currentClaimMonth || incomingClaimMonth > currentClaimMonth) {
    return normalizeConfirmedCodes(incoming, incomingClaimMonth)
      .sort((left, right) => left.code.localeCompare(right.code));
  }
  if (incomingClaimMonth < currentClaimMonth) {
    return normalizeConfirmedCodes(current, currentClaimMonth)
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  const byCode = new Map();
  for (const entry of [
    ...normalizeConfirmedCodes(current, currentClaimMonth),
    ...normalizeConfirmedCodes(incoming, incomingClaimMonth)
  ]) {
    const existing = byCode.get(entry.code);
    const names = [existing?.name, entry.name].filter(Boolean).sort();
    byCode.set(entry.code, {
      code: entry.code,
      name: names[0] || "",
      claimMonth: incomingClaimMonth
    });
  }
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

function normalizeManualStop(value = {}) {
  return {
    stopped: value?.stopped === true,
    byMemberId: value?.byMemberId || null,
    at: value?.at || null,
    note: String(value?.note || "")
  };
}

function normalizeStandingMentions(values = []) {
  return asArray(values).map((mention) => ({
    lineId: String(mention?.lineId || mention?.line_id || "").trim(),
    target: String(mention?.target || "").trim(),
    status: ["continued", "changed", "stopped"].includes(String(mention?.status || ""))
      ? String(mention.status)
      : "continued",
    text: String(mention?.text || mention?.evidence || "").trim()
  })).filter((mention) => mention.target);
}

function assertProfileIdentity(profile, expected) {
  const pairs = [
    ["standingFactId", expected.standingFactId],
    ["orgId", expected.orgId],
    ["facilityId", expected.facilityId],
    ["canonicalPatientId", expected.canonicalPatientId],
    ["feeFamily", expected.feeFamily]
  ];
  for (const [key, value] of pairs) {
    if (String(profile?.[key] || "") !== String(value || "")) {
      throw new TypeError(`standing billing profile ${key} cannot change`);
    }
  }
}

function normalizeClaimMonth(value) {
  const month = String(value || "").trim().slice(0, 7);
  if (!/^\d{4}-\d{2}$/u.test(month)) {
    throw new TypeError("claimMonth must use YYYY-MM");
  }
  const numericMonth = Number(month.slice(5, 7));
  if (numericMonth < 1 || numericMonth > 12) {
    throw new TypeError("claimMonth must use YYYY-MM");
  }
  return month;
}

function addMonths(claimMonth, offset) {
  const month = normalizeClaimMonth(claimMonth);
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}

function monthDistance(fromMonth, toMonth) {
  const from = normalizeClaimMonth(fromMonth);
  const to = normalizeClaimMonth(toMonth);
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12
    + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

function maxClaimMonth(left, right) {
  const values = [left, right].filter(Boolean).map(normalizeClaimMonth);
  return values.sort().at(-1) || "";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

function dedupeBy(values = [], keyOf = (value) => JSON.stringify(value)) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values)) {
    const key = String(keyOf(value) || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requiredValue(value, label) {
  const text = String(value || "").trim();
  if (!text) {
    throw new TypeError(`${label} is required`);
  }
  return text;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("timestamp is invalid");
  }
  return date.toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export const standingBillingProfileStatuses = Object.freeze([
  ACTIVE_STATUS,
  ...STOPPED_STATUSES
]);
