import {
  isFutureOrOrderOnlyClinicalServiceContext,
  isNegatedClinicalServiceContext,
  isPastOrExternalClinicalServiceContext,
  normalizeClinicalPredicateText,
  splitClinicalEvidenceClauses
} from "../../../packages/fee-contracts/src/index.js";
import {
  encounterBasicFeeMetadata,
  encounterBasicFeeRule
} from "./facility-service-schedule.js";

const REPLACED_AUTO_BILLING_ROLES = new Set([
  "home_visit_basic",
  "home_visit_baseup"
]);

const SECOND_VISIT_RULE_IDS = Object.freeze([
  "basic_revisit",
  "facility_after_hours_response_1",
  "facility_itemized_statement",
  "revisit_outpatient_management_addon",
  "facility_base_up_revisit"
]);
const SECOND_VISIT_CANDIDATES = Object.freeze(
  SECOND_VISIT_RULE_IDS.map((ruleId) => {
    const rule = encounterBasicFeeRule(ruleId);
    if (!rule) {
      throw new Error(`same-household encounter rule is missing: ${ruleId}`);
    }
    return rule;
  })
);

export function hasSameHouseholdSameDayVisitEvidence(value = "") {
  const clauses = splitClinicalEvidenceClauses(value);
  const hasHouseholdIdentity = clauses.some((clause) => {
    const text = normalizeClinicalPredicateText(clause?.text || "");
    if (
      !text
      || isPastOrExternalClinicalServiceContext(text)
      || isNegatedClinicalServiceContext(text)
    ) {
      return false;
    }
    if (
      isFutureOrOrderOnlyClinicalServiceContext(text)
      && !/(?:次回|次月|今後)[^。]*(?:も|引き続き|継続)/u.test(text)
    ) {
      return false;
    }
    return /(?:同一世帯|同じ世帯|同一患家|同じ患家|同住所)/u.test(text);
  });
  if (!hasHouseholdIdentity) {
    return false;
  }
  return clauses.some((clause) => {
    const text = normalizeClinicalPredicateText(clause?.text || "");
    if (
      !text
      || isPastOrExternalClinicalServiceContext(text)
      || isFutureOrOrderOnlyClinicalServiceContext(text)
      || isNegatedClinicalServiceContext(text)
    ) {
      return false;
    }
    return /同日/u.test(text)
      && /(?:訪問|診療)/u.test(text)
      && /(?:同一世帯|同じ世帯|同一患家|同じ患家|同住所|夫|妻|配偶者|家族|同居者)/u.test(text);
  });
}

export function buildSameHouseholdVisitContext({
  currentDraft = {},
  siblingDrafts = []
} = {}) {
  if (String(currentDraft.setting || "") !== "home_visit") {
    return context("not_applicable", currentDraft);
  }
  if (!hasSameHouseholdSameDayVisitEvidence(currentDraft.clinicalText)) {
    return context("no_explicit_evidence", currentDraft);
  }
  if (!Array.isArray(siblingDrafts)) {
    return context("lookup_unavailable", currentDraft);
  }
  const currentIdentity = draftIdentity(currentDraft);
  const siblings = asArray(siblingDrafts)
    .filter((draft) => String(draft.setting || "") === "home_visit")
    .filter((draft) => String(draft.serviceDate || "") === String(currentDraft.serviceDate || ""))
    .filter((draft) => sameFacility(currentDraft, draft))
    .filter((draft) => draftIdentity(draft) !== currentIdentity)
    .filter((draft) => hasSameHouseholdSameDayVisitEvidence(draft.clinicalText));
  if (!siblings.length) {
    return context("awaiting_counterpart", currentDraft);
  }
  if (siblings.length > 1) {
    return context("ambiguous_multiple_counterparts", currentDraft, {
      counterpartCount: siblings.length
    });
  }
  const sibling = siblings[0];
  const currentTime = normalizedReceptionTime(currentDraft.receptionTime);
  const siblingTime = normalizedReceptionTime(sibling.receptionTime);
  if (!currentTime || !siblingTime || currentTime === siblingTime) {
    return context("ambiguous_visit_order", currentDraft, {
      counterpartCount: 1,
      counterpartDraftId: String(sibling.sidecarDraftId || sibling.feeSessionId || ""),
      counterpartReceptionTime: siblingTime
    });
  }
  return context(
    currentTime > siblingTime ? "second_visit" : "first_visit",
    currentDraft,
    {
      counterpartCount: 1,
      counterpartDraftId: String(sibling.sidecarDraftId || sibling.feeSessionId || ""),
      counterpartReceptionTime: siblingTime
    }
  );
}

export function applySameHouseholdVisitGovernance(prepared = {}, {
  session = {}
} = {}) {
  const visitContext = session.sameHouseholdVisitContext;
  if (!visitContext || ["not_applicable", "no_explicit_evidence"].includes(visitContext.status)) {
    return prepared;
  }
  const reviewIssue = sameHouseholdReviewIssue(visitContext);
  if (visitContext.status !== "second_visit") {
    return appendReview(prepared, reviewIssue, visitContext, {
      replacementCandidateCount: 0,
      suppressedCodeCount: 0
    });
  }

  const appliedRules = asArray(prepared?.metrics?.autoBillingRules?.applied);
  const replacedRules = appliedRules.filter((entry) => (
    REPLACED_AUTO_BILLING_ROLES.has(String(entry?.billingRole || ""))
  ));
  const suppressedCodes = new Set(replacedRules.map((entry) => String(entry.code || "")).filter(Boolean));
  const currentOptions = isPlainObject(prepared.calculationOptions)
    ? prepared.calculationOptions
    : {};
  const procedureCodes = asArray(currentOptions.procedure_codes)
    .map((code) => String(code || "").trim())
    .filter((code) => code && !suppressedCodes.has(code));
  const candidateProposals = SECOND_VISIT_CANDIDATES.map((candidate) => ({
    proposalId: `same_household_second_visit_${candidate.code}`,
    title: `${candidate.name}の差替え確認`,
    reason: "同一患家を同日に訪問した2人目の可能性があります。",
    conditionText: "同一患家であること、当日の訪問順、各項目の算定要件と施設基準を確認してください。訪問診療料からの差替えは人が確認した場合のみ行います。",
    basis: "same_household_second_visit_review_candidate",
    code: candidate.code,
    potentialPoints: candidate.points,
    requiredFacilityStandardKeys: candidate.requiredFacilityStandardKey
      ? [candidate.requiredFacilityStandardKey]
      : [],
    ruleArtifact: encounterBasicFeeMetadata(),
    orderType: "procedure",
    source: "same_household_visit_governance",
    actionType: "confirm_required",
    candidateOnly: true,
    reviewRequired: true,
    adoptionBlocked: true,
    adoptionBlockReason: "same_household_visit_order_unconfirmed",
    candidateLine: null
  }));
  const filteredWarnings = asArray(prepared.reviewWarnings).filter((warning) => (
    ![...suppressedCodes].some((code) => (
      String(warning || "").startsWith("施設恒常算定ルール:")
      && String(warning || "").includes(`(${code})`)
    ))
  ));
  return appendReview({
    ...prepared,
    calculationOptions: {
      ...currentOptions,
      procedure_codes: procedureCodes
    },
    candidateProposals: [
      ...asArray(prepared.candidateProposals),
      ...candidateProposals
    ],
    reviewWarnings: filteredWarnings,
    metrics: {
      ...(prepared.metrics || {}),
      autoBillingRules: {
        ...(prepared?.metrics?.autoBillingRules || {}),
        applied: appliedRules.filter((entry) => !suppressedCodes.has(String(entry?.code || ""))),
        appliedCount: Math.max(0, Number(prepared?.metrics?.autoBillingRules?.appliedCount || 0) - replacedRules.length)
      }
    }
  }, reviewIssue, visitContext, {
    replacementCandidateCount: candidateProposals.length,
    suppressedCodeCount: suppressedCodes.size
  });
}

function appendReview(prepared, reviewIssue, visitContext, metrics) {
  return {
    ...prepared,
    reviewIssues: [
      ...asArray(prepared.reviewIssues),
      reviewIssue
    ],
    reviewWarnings: uniqueStrings([
      ...asArray(prepared.reviewWarnings),
      reviewIssue.messageForStaff
    ]),
    clinicalExtraction: appendTrace(prepared.clinicalExtraction, {
      traceId: `trace_same_household_visit_${visitContext.status}`,
      stage: "same_household_visit_governance",
      outcome: visitContext.status === "second_visit" ? "candidate_proposed" : "needs_review",
      status: visitContext.status,
      counterpartCount: visitContext.counterpartCount,
      receptionTime: visitContext.receptionTime,
      counterpartReceptionTime: visitContext.counterpartReceptionTime
    }),
    metrics: {
      ...(prepared.metrics || {}),
      sameHouseholdVisit: {
        status: visitContext.status,
        ...metrics
      }
    }
  };
}

function sameHouseholdReviewIssue(visitContext) {
  const second = visitContext.status === "second_visit";
  const first = visitContext.status === "first_visit";
  return {
    reviewIssueId: `same_household_visit_${visitContext.status}`,
    issueCode: second
      ? "same_household_second_visit_review_required"
      : "same_household_visit_order_review_required",
    severity: second ? "warning" : "info",
    title: second
      ? "同一患家2人目の算定差替え確認"
      : "同一患家の訪問順確認",
    topicCode: "encounter_basic_fee_check",
    topicLabel: "基本診療料の確認",
    messageForStaff: second
      ? "同一患家を同日に訪問した2人目の可能性があります。訪問診療料ではなく再診料等へ差し替えるか確認してください。"
      : first
        ? "同一患家を同日に訪問した1人目と判定しました。訪問順を確認してください。"
        : visitContext.status === "awaiting_counterpart"
          ? "同一患家・同日訪問の記載があります。対となる患者のドラフト作成後に訪問順を確認してください。"
          : "同一患家・同日訪問の順序を確定できません。受付時刻と対象患者を確認してください。",
    requiredInput: "同一患家であること、当日の訪問順、受付時刻",
    source: "same_household_visit_governance",
    metadata: visitContext
  };
}

function appendTrace(clinicalExtraction, event) {
  if (!isPlainObject(clinicalExtraction)) {
    return clinicalExtraction || null;
  }
  return {
    ...clinicalExtraction,
    trace: [
      ...asArray(clinicalExtraction.trace),
      event
    ]
  };
}

function context(status, draft, extra = {}) {
  return {
    contractVersion: "same-household-visit-v1",
    status,
    serviceDate: String(draft.serviceDate || ""),
    facilityId: String(draft.facilityId || ""),
    receptionTime: normalizedReceptionTime(draft.receptionTime),
    counterpartCount: 0,
    ...extra
  };
}

function draftIdentity(draft) {
  return String(
    draft.externalPatientId
    || draft.canonicalPatientId
    || draft.patientId
    || draft.sidecarPatientKey
    || draft.sidecarDraftId
    || draft.feeSessionId
    || ""
  ).trim();
}

function sameFacility(left, right) {
  const leftId = String(left.facilityId || "").trim();
  const rightId = String(right.facilityId || "").trim();
  return Boolean(leftId && rightId && leftId === rightId);
}

function normalizedReceptionTime(value) {
  const text = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/u.test(text) ? text : null;
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
