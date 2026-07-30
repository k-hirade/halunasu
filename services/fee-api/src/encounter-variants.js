import {
  isPastOrExternalClinicalServiceContext,
  normalizeClinicalPredicateText
} from "../../../packages/fee-contracts/src/index.js";
import {
  classifyFacilityServiceTime,
  encounterBasicFeeMetadata,
  encounterBasicFeeRule,
  facilityDerivedAddonRules,
  facilityServiceTimeReviewWarning,
  timeAddonRule
} from "./facility-service-schedule.js";

const INITIAL_FEE_CODE = requiredRule("basic_initial").code;
const REVISIT_FEE_CODE = requiredRule("basic_revisit").code;
const TELEPHONE_REVISIT_CODE = requiredRule("basic_telephone_revisit").code;
const HOUSE_CALL_CODE = requiredRule("house_call").code;
const TELEPHONE_REVISIT_KIND = "telephone_revisit";

const TELEPHONE_VISIT_PATTERN_SOURCE = String.raw`(?:電話(?:等)?再診|電話相談|電話(?:で|にて|による).{0,20}(?:診療|相談|指示)|(?:患者|家族|看護者).{0,20}電話.{0,20}(?:相談|指示))`;
const TELEPHONE_VISIT_PATTERN = new RegExp(TELEPHONE_VISIT_PATTERN_SOURCE, "u");
const TELEPHONE_CONTEXT_CUE_PATTERN = /(?:本日|今回|当日|現在|今朝|前回|先月|先週|先日|昨日|前日|以前|過去|持参|他院|前医|他科|紹介元|かかりつけ|健診|検診|外部資料|院外|外部|前に|過去に)/u;
const TELEPHONE_CURRENT_CONTEXT_TERMS = Object.freeze([
  "本日",
  "今回",
  "当日",
  "現在",
  "今朝"
]);
const TELEPHONE_PAST_OR_EXTERNAL_TERMS = Object.freeze([
  "前回",
  "先月",
  "先週",
  "先日",
  "昨日",
  "前日",
  "以前",
  "過去",
  "過去値",
  "既知値",
  "持参",
  "他院",
  "前医",
  "他科",
  "紹介元",
  "かかりつけ",
  "健診",
  "検診",
  "外部資料",
  "院外",
  "外部",
  "前に",
  "過去に"
]);

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
  const text = normalizeClinicalPredicateText(value);
  if (!text) {
    return false;
  }
  return splitTelephoneSentences(text).some((sentence) => (
    telephoneMatches(sentence).some((match) => {
      const context = telephoneContextAt(sentence, match.index);
      return !telephoneContextIsPastOrExternal(
        context.text,
        context.telephoneIndex + match.value.length
      );
    })
  ));
}

export function applyEncounterVariantToPreparation(prepared = {}, {
  session = {},
  priorSessions = [],
  historyCompleteness = "unknown",
  feeSettings = {},
  facilityStandardKeys = []
} = {}) {
  const encounterDetails = isPlainObject(session.encounterDetails)
    ? session.encounterDetails
    : {};
  const visitKind = String(encounterDetails.visitKind || "").trim() || null;
  const telephoneWording = hasTelephoneVisitWording(session.clinicalText);
  const common = {
    session,
    feeSettings,
    facilityStandardKeys
  };

  if (String(session.setting || "") === "home_visit") {
    const autoKeys = new Set(asArray(prepared.calculationOptionsAutoKeys));
    const result = autoKeys.has("outpatient_basic") || autoKeys.has("outpatientBasic")
      ? withoutOutpatientBasicFee(prepared)
      : prepared;
    return applyEncounterTimeAndFacilityRules(
      withEncounterVariantMetrics(result, {
        visitKind,
        outcome: "home_visit_basic_suppressed",
        establishedPatient: null
      }),
      common
    );
  }

  if (String(session.setting || "") === "house_call") {
    const result = applyHouseCallVariant(prepared, {
      session,
      priorSessions,
      historyCompleteness
    });
    return applyEncounterTimeAndFacilityRules(result, common);
  }

  if (visitKind !== TELEPHONE_REVISIT_KIND && !telephoneWording) {
    const result = withEncounterVariantMetrics(prepared, {
      visitKind,
      outcome: "not_applicable",
      establishedPatient: null
    });
    return applyEncounterTimeAndFacilityRules(result, common);
  }

  const result = applyTelephoneVariant(prepared, {
    session,
    priorSessions,
    historyCompleteness,
    visitKind,
    telephoneWording
  });
  return applyEncounterTimeAndFacilityRules(result, common);
}

function applyTelephoneVariant(prepared, {
  session,
  priorSessions,
  historyCompleteness,
  visitKind
}) {
  const encounterDetails = isPlainObject(session.encounterDetails)
    ? session.encounterDetails
    : {};
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

function applyHouseCallVariant(prepared, {
  session = {},
  priorSessions = [],
  historyCompleteness = "unknown"
} = {}) {
  const establishedPatient = deriveEstablishedPatient({
    session,
    priorSessions,
    historyCompleteness
  });
  const baseOptions = isPlainObject(prepared.calculationOptions)
    ? prepared.calculationOptions
    : {};
  const existingBasicFeeKind = ["initial", "revisit"].includes(
    String(baseOptions.outpatient_basic?.fee_kind || "")
  )
    ? String(baseOptions.outpatient_basic.fee_kind)
    : null;
  const basicFeeIsAutomatic = asArray(prepared.calculationOptionsAutoKeys)
    .includes("outpatient_basic");
  const confirmedBasicFeeKind = existingBasicFeeKind && !basicFeeIsAutomatic
    ? existingBasicFeeKind
    : null;
  let result = appendProcedureCodes(prepared, [HOUSE_CALL_CODE]);
  let outcome = "basic_fee_unknown";
  let basicFeeKind = null;

  if (confirmedBasicFeeKind || establishedPatient !== null) {
    basicFeeKind = confirmedBasicFeeKind || (establishedPatient ? "revisit" : "initial");
    result = {
      ...result,
      calculationOptions: {
        ...(isPlainObject(result.calculationOptions) ? result.calculationOptions : {}),
        outpatient_basic: {
          ...(isPlainObject(baseOptions.outpatient_basic) ? baseOptions.outpatient_basic : {}),
          fee_kind: basicFeeKind
        }
      },
      calculationOptionsAutoKeys: uniqueStrings([
        ...asArray(result.calculationOptionsAutoKeys),
        "outpatient_basic"
      ])
    };
    outcome = confirmedBasicFeeKind
      ? `house_call_manual_${basicFeeKind}`
      : `house_call_${basicFeeKind}`;
  } else {
    result = withoutOutpatientBasicFee(result);
    const message = "往診時の初診料・再診料区分を履歴だけでは確定できません。患者の受診履歴と今回病名との継続性を確認してください。";
    result = {
      ...result,
      candidateProposals: [
        ...asArray(result.candidateProposals),
        houseCallBasicFeeCandidate(message)
      ],
      reviewIssues: [
        ...asArray(result.reviewIssues),
        houseCallBasicFeeReviewIssue(message)
      ],
      reviewWarnings: uniqueStrings([
        ...asArray(result.reviewWarnings),
        message
      ])
    };
  }

  result = {
    ...result,
    reviewWarnings: uniqueStrings([
      ...asArray(result.reviewWarnings),
      "往診交通費は診療報酬点数ではなく患家負担として扱うため、この算定案では自動計上していません。施設の運用に従って別途確認してください。"
    ])
  };
  return withEncounterVariantMetrics(result, {
    visitKind: "house_call",
    outcome,
    establishedPatient,
    eligibility: {
      houseCallCode: HOUSE_CALL_CODE,
      basicFeeKind
    }
  });
}

function applyEncounterTimeAndFacilityRules(prepared, {
  session = {},
  feeSettings = {},
  facilityStandardKeys = []
} = {}) {
  const setting = String(session.setting || "").trim();
  if (!["outpatient", "house_call"].includes(setting)) {
    return {
      ...prepared,
      metrics: {
        ...(prepared.metrics || {}),
        encounterFeeSet: {
          scheduleStatus: "not_applicable",
          scheduleId: null,
          timeClass: null,
          timeAddonCode: null,
          facilityDerivedRuleIds: []
        }
      }
    };
  }
  const classification = classifyFacilityServiceTime({
    receptionTime: session.receptionTime,
    serviceDate: session.serviceDate,
    feeSettings
  });
  const warning = facilityServiceTimeReviewWarning(classification);
  let result = warning
    ? {
        ...prepared,
        reviewWarnings: uniqueStrings([
          ...asArray(prepared.reviewWarnings),
          warning
        ])
      }
    : prepared;
  const basicFeeKind = String(
    result.calculationOptions?.outpatient_basic?.fee_kind || ""
  );
  let selectedTimeRule = null;

  if (
    classification.status === "classified"
    && classification.timeClass !== "within_hours"
  ) {
    selectedTimeRule = timeAddonRule({
      timeClass: classification.timeClass,
      feeKind: basicFeeKind
    });
    if (selectedTimeRule) {
      result = appendProcedureCodes(result, [selectedTimeRule.code]);
    } else {
      result = {
        ...result,
        reviewWarnings: uniqueStrings([
          ...asArray(result.reviewWarnings),
          "初診料・再診料の区分が未確定のため、時間帯加算の請求コードを自動選択していません。"
        ])
      };
    }
  }

  const facilityRules = facilityDerivedAddonRules({
    feeKind: basicFeeKind,
    facilityStandardKeys
  });
  const trace = {
    stage: "encounter_fee_set",
    categoryLabel: "受診別基本診療料セット",
    outcome: selectedTimeRule
      ? "time_addon_applied"
      : classification.status === "classified" ? classification.timeClass : classification.status,
    selected: {
      artifact: encounterBasicFeeMetadata(),
      basicFeeKind: basicFeeKind || null,
      timeClassification: classification,
      timeAddonCode: selectedTimeRule?.code || null,
      facilityDerivedRuleIds: facilityRules.map((rule) => rule.ruleId)
    },
    message: "encounter_fee_set_evaluated"
  };
  const clinicalExtraction = isPlainObject(result.clinicalExtraction)
    ? {
        ...result.clinicalExtraction,
        trace: [...asArray(result.clinicalExtraction.trace), trace]
      }
    : result.clinicalExtraction || null;
  return {
    ...result,
    clinicalExtraction,
    metrics: {
      ...(result.metrics || {}),
      encounterFeeSet: {
        scheduleStatus: classification.status,
        scheduleId: classification.scheduleId || null,
        timeClass: classification.timeClass || null,
        timeAddonCode: selectedTimeRule?.code || null,
        facilityDerivedRuleIds: facilityRules.map((rule) => rule.ruleId)
      }
    }
  };
}

function appendProcedureCodes(prepared, codes = []) {
  const currentOptions = isPlainObject(prepared.calculationOptions)
    ? prepared.calculationOptions
    : {};
  const procedureCodes = uniqueStrings([
    ...asArray(currentOptions.procedure_codes),
    ...codes
  ]);
  return {
    ...prepared,
    calculationOptions: {
      ...currentOptions,
      procedure_codes: procedureCodes
    },
    calculationOptionsAutoKeys: uniqueStrings([
      ...asArray(prepared.calculationOptionsAutoKeys),
      ...(codes.length ? ["procedure_codes"] : [])
    ])
  };
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

function houseCallBasicFeeCandidate(reason) {
  return {
    proposalId: "encounter_variant_house_call_basic_fee",
    title: "往診時の初診料・再診料区分確認",
    reason,
    conditionText: "患者履歴と今回病名との継続性を確認し、初診料または再診料を選択してください。",
    basis: "encounter_variant_candidate",
    actionType: "confirm_required",
    potentialPoints: 0,
    codeCandidates: [INITIAL_FEE_CODE, REVISIT_FEE_CODE],
    orderType: "basic",
    source: "encounter_variant",
    sortOrder: 14,
    candidateOnly: true
  };
}

function houseCallBasicFeeReviewIssue(message) {
  return {
    reviewIssueId: "encounter_variant_house_call_basic_fee_unconfirmed",
    issueCode: "house_call_basic_fee_unconfirmed",
    severity: "warning",
    title: "往診時の初診料・再診料区分確認",
    topicCode: "encounter_variant_check",
    topicLabel: "受診方法の確認",
    messageForStaff: message,
    evidence: "",
    requiredInput: "当該施設での受診履歴と今回病名との継続性",
    codeCandidates: [INITIAL_FEE_CODE, REVISIT_FEE_CODE],
    source: "encounter_variant"
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

function splitTelephoneSentences(value = "") {
  return String(value || "")
    .split(/[\n。．.!！?？]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function telephoneMatches(value = "") {
  return [...String(value || "").matchAll(new RegExp(TELEPHONE_VISIT_PATTERN_SOURCE, "gu"))]
    .map((match) => ({
      index: Number(match.index || 0),
      value: match[0]
    }));
}

function telephoneContextAt(sentence = "", telephoneIndex = 0) {
  const value = String(sentence || "");
  const separators = [...value.matchAll(/[、，；;]/gu)].map((match) => Number(match.index || 0));
  const previousSeparators = separators.filter((index) => index < telephoneIndex);
  const nextSeparator = separators.find((index) => index > telephoneIndex);
  const clauseStart = previousSeparators.length
    ? previousSeparators[previousSeparators.length - 1] + 1
    : 0;
  const clauseEnd = nextSeparator ?? value.length;
  const clause = value.slice(clauseStart, clauseEnd);
  let prefix = "";

  if (!TELEPHONE_CONTEXT_CUE_PATTERN.test(clause) && previousSeparators.length) {
    const previousEnd = previousSeparators[previousSeparators.length - 1];
    const previousStart = previousSeparators.length > 1
      ? previousSeparators[previousSeparators.length - 2] + 1
      : 0;
    const previousClause = value.slice(previousStart, previousEnd);
    if (previousClause.length <= 20 && TELEPHONE_CONTEXT_CUE_PATTERN.test(previousClause)) {
      prefix = previousClause;
    }
  }

  return {
    text: `${prefix}${clause}`,
    telephoneIndex: prefix.length + Math.max(0, telephoneIndex - clauseStart)
  };
}

function telephoneContextIsPastOrExternal(value = "", telephoneEndIndex = 0) {
  const throughTelephone = String(value || "").slice(0, Math.max(0, telephoneEndIndex));
  const hasPastOrExternalContext = (
    isPastOrExternalClinicalServiceContext(throughTelephone)
    || TELEPHONE_PAST_OR_EXTERNAL_TERMS.some((term) => throughTelephone.includes(term))
  );
  if (!hasPastOrExternalContext) {
    return false;
  }
  return lastTermIndex(throughTelephone, TELEPHONE_PAST_OR_EXTERNAL_TERMS)
    >= lastTermIndex(throughTelephone, TELEPHONE_CURRENT_CONTEXT_TERMS);
}

function lastTermIndex(value = "", terms = []) {
  return terms.reduce(
    (latest, term) => Math.max(latest, String(value || "").lastIndexOf(term)),
    -1
  );
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

function requiredRule(ruleId) {
  const rule = encounterBasicFeeRule(ruleId);
  if (!rule) {
    throw new Error(`required encounter basic fee rule is missing: ${ruleId}`);
  }
  return rule;
}
