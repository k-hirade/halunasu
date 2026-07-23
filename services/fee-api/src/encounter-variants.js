const TELEPHONE_REVISIT_CODE = "112007950";
const TELEPHONE_REVISIT_KIND = "telephone_revisit";

const TELEPHONE_VISIT_PATTERN = /(?:電話(?:等)?再診|電話相談|電話(?:で|にて|による).{0,20}(?:診療|相談|指示)|(?:患者|家族|看護者).{0,20}電話.{0,20}(?:相談|指示))/u;

export function deriveEstablishedPatient({
  session = {},
  priorSessions = [],
  historyCompleteness = "unknown"
} = {}) {
  if (historyCompleteness === "unavailable") {
    return null;
  }
  const facilityId = String(session.facilityId || "").trim();
  const hasPriorVisitAtFacility = asArray(priorSessions).some((prior) => {
    const priorFacilityId = String(prior?.facilityId || "").trim();
    const priorServiceDate = String(prior?.serviceDate || prior?.claimMonth || "").trim();
    return Boolean(facilityId && priorFacilityId === facilityId && priorServiceDate);
  });
  if (hasPriorVisitAtFacility) {
    return true;
  }
  return historyCompleteness === "complete" ? false : null;
}

export function hasTelephoneVisitWording(value) {
  const text = String(value || "")
    .replace(/[\s\u3000]+/gu, "")
    .trim();
  return TELEPHONE_VISIT_PATTERN.test(text);
}

export function applyEncounterVariantToPreparation(prepared = {}, {
  session = {},
  priorSessions = [],
  historyCompleteness = "unknown"
} = {}) {
  const encounterDetails = isPlainObject(session.encounterDetails)
    ? session.encounterDetails
    : {};
  const visitKind = String(encounterDetails.visitKind || "").trim() || null;
  const telephoneWording = hasTelephoneVisitWording(session.clinicalText);

  if (visitKind !== TELEPHONE_REVISIT_KIND && !telephoneWording) {
    return withEncounterVariantMetrics(prepared, {
      visitKind,
      outcome: "not_applicable",
      establishedPatient: null
    });
  }

  const withoutBasicFee = withoutOutpatientBasicFee(prepared);
  if (visitKind !== TELEPHONE_REVISIT_KIND) {
    const message = "電話等再診の可能性があります。受診方法を選択してください。";
    return appendEncounterVariantReview(withoutBasicFee, {
      outcome: "visit_kind_unknown",
      establishedPatient: null,
      reviewIssue: telephoneReviewIssue({
        issueCode: "telephone_visit_kind_unconfirmed",
        title: "電話等再診の受診方法確認",
        message,
        requiredInput: "受診方法（対面外来または電話等再診）"
      }),
      warning: message
    });
  }

  const establishedPatient = deriveEstablishedPatient({
    session,
    priorSessions,
    historyCompleteness
  });
  const suppliedEligibility = isPlainObject(encounterDetails.telephoneEligibility)
    ? encounterDetails.telephoneEligibility
    : {};
  const eligibility = {
    establishedPatient,
    patientInitiated: nullableBoolean(suppliedEligibility.patientInitiated),
    instructionGiven: nullableBoolean(suppliedEligibility.instructionGiven),
    scheduledManagement: nullableBoolean(suppliedEligibility.scheduledManagement)
  };
  const settingValid = session.setting === "outpatient";
  const hasDisqualifyingFact = (
    !settingValid
    || eligibility.establishedPatient === false
    || eligibility.patientInitiated === false
    || eligibility.instructionGiven === false
    || eligibility.scheduledManagement === true
  );
  const eligible = (
    settingValid
    && eligibility.establishedPatient === true
    && eligibility.patientInitiated === true
    && eligibility.instructionGiven === true
    && eligibility.scheduledManagement === false
  );

  if (eligible) {
    const calculationOptions = {
      ...(isPlainObject(withoutBasicFee.calculationOptions)
        ? withoutBasicFee.calculationOptions
        : {}),
      outpatient_basic: {
        fee_kind: "revisit",
        visit_kind: TELEPHONE_REVISIT_KIND,
        telephone_eligibility: {
          established_patient: true,
          patient_initiated: true,
          instruction_given: true,
          scheduled_management: false
        }
      }
    };
    return withEncounterVariantMetrics({
      ...withoutBasicFee,
      calculationOptions,
      calculationOptionsAutoKeys: uniqueStrings([
        ...asArray(withoutBasicFee.calculationOptionsAutoKeys),
        "outpatient_basic"
      ])
    }, {
      visitKind,
      outcome: "eligible",
      establishedPatient,
      eligibility
    });
  }

  if (hasDisqualifyingFact) {
    const message = "電話等再診の算定要件を満たさない入力があるため、再診料には入れていません。入力内容を確認してください。";
    return appendEncounterVariantReview(withoutBasicFee, {
      outcome: "ineligible",
      establishedPatient,
      eligibility,
      reviewIssue: telephoneReviewIssue({
        issueCode: "telephone_revisit_ineligible",
        title: "電話等再診の算定対象外確認",
        message,
        requiredInput: "既診関係、相談起点、必要な指示、定期的医学管理への該当性"
      }),
      warning: message
    });
  }

  const missing = [
    ["establishedPatient", "当該施設での既診関係"],
    ["patientInitiated", "患者・家族からの相談起点"],
    ["instructionGiven", "治療上必要な指示"],
    ["scheduledManagement", "定期的な医学管理への該当性"]
  ].filter(([key]) => eligibility[key] === null).map(([, label]) => label);
  const message = `電話等再診の算定要件（${missing.join("、")}）を確認してください。`;
  return appendEncounterVariantReview(withoutBasicFee, {
    outcome: "eligibility_unknown",
    establishedPatient,
    eligibility,
    candidateProposal: telephoneCandidateProposal(message),
    reviewIssue: telephoneReviewIssue({
      issueCode: "telephone_revisit_eligibility_unconfirmed",
      title: "電話等再診の算定要件確認",
      message,
      requiredInput: "既診関係、相談起点、必要な指示、定期的医学管理への該当性"
    }),
    warning: message
  });
}

function withoutOutpatientBasicFee(prepared = {}) {
  const calculationOptions = isPlainObject(prepared.calculationOptions)
    ? { ...prepared.calculationOptions }
    : prepared.calculationOptions;
  if (isPlainObject(calculationOptions)) {
    delete calculationOptions.outpatient_basic;
    delete calculationOptions.outpatientBasic;
  }
  return {
    ...prepared,
    calculationOptions,
    calculationOptionsAutoKeys: asArray(prepared.calculationOptionsAutoKeys)
      .filter((key) => key !== "outpatient_basic" && key !== "outpatientBasic"),
    candidateProposals: asArray(prepared.candidateProposals)
      .filter((proposal) => proposal?.proposalId !== "outpatient_management_addon")
  };
}

function appendEncounterVariantReview(prepared, {
  outcome,
  establishedPatient,
  eligibility = null,
  candidateProposal = null,
  reviewIssue,
  warning
}) {
  return withEncounterVariantMetrics({
    ...prepared,
    candidateProposals: candidateProposal
      ? [...asArray(prepared.candidateProposals), candidateProposal]
      : asArray(prepared.candidateProposals),
    reviewIssues: [...asArray(prepared.reviewIssues), reviewIssue],
    reviewWarnings: uniqueStrings([...asArray(prepared.reviewWarnings), warning])
  }, {
    visitKind: TELEPHONE_REVISIT_KIND,
    outcome,
    establishedPatient,
    eligibility
  });
}

function telephoneCandidateProposal(reason) {
  return {
    proposalId: "encounter_variant_telephone_revisit",
    title: "電話等再診料の算定確認",
    reason,
    conditionText: "相談起点・必要な指示・非定期管理・当該施設での既診関係を確認後に採用してください。",
    basis: "encounter_variant_candidate",
    actionType: "confirm_required",
    potentialPoints: 0,
    code: TELEPHONE_REVISIT_CODE,
    orderType: "basic",
    source: "encounter_variant",
    sortOrder: 15,
    candidateOnly: true
  };
}

function telephoneReviewIssue({ issueCode, title, message, requiredInput }) {
  return {
    reviewIssueId: `encounter_variant_${issueCode}`,
    issueCode,
    severity: "warning",
    title,
    topicCode: "encounter_variant_check",
    topicLabel: "受診方法の確認",
    messageForStaff: message,
    evidence: "",
    requiredInput,
    source: "encounter_variant"
  };
}

function withEncounterVariantMetrics(prepared = {}, detail = {}) {
  const trace = {
    stage: "encounter_variant",
    categoryLabel: "受診バリアント",
    outcome: detail.outcome,
    selected: {
      visitKind: detail.visitKind || null,
      establishedPatient: detail.establishedPatient ?? null,
      eligibility: detail.eligibility || null
    },
    message: "encounter_variant_evaluated"
  };
  const clinicalExtraction = isPlainObject(prepared.clinicalExtraction)
    ? {
        ...prepared.clinicalExtraction,
        trace: [...asArray(prepared.clinicalExtraction.trace), trace]
      }
    : prepared.clinicalExtraction || null;
  return {
    ...prepared,
    clinicalExtraction,
    metrics: {
      ...(prepared.metrics || {}),
      encounterVariant: {
        visitKind: detail.visitKind || null,
        outcome: detail.outcome,
        establishedPatient: detail.establishedPatient ?? null
      }
    }
  };
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
