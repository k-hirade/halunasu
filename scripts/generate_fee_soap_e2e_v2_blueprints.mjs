#!/usr/bin/env node
// v2 1000ケースの算定ゴールドblueprint生成器。
// SOAP本文は生成しない。手書きSOAPの前に、期待コード/点数/レビューtopic/施設fixture/根拠アンカーを固定する。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/coverage-matrix-v2.json");
const casesPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/fee-soap-e2e-v2-cases.json");
const outPath = path.join(repoRoot, "data/tests/fee-soap-e2e-v2/gold-blueprints.json");

const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const authoredDataset = fs.existsSync(casesPath) ? JSON.parse(fs.readFileSync(casesPath, "utf8")) : { cases: [] };

const TOTAL = matrix.totalCases || 1000;
const assertionTargets = matrix.assertionMix || {
  exact: 360,
  review_required: 390,
  safety: 90,
  unsupported_expected: 120,
  split_required: 40
};

const departmentPool = weightedPool(matrix.departments || [], "targetCases", TOTAL);
const domainPool = weightedPool(matrix.billingDomains || [], "targetCases", TOTAL);

const exactArchetypes = [
  {
    key: "lab.urine.revisit.basic",
    domains: ["lab", "facility_standards"],
    facilityFixtureKey: "clinic_basic",
    expectedCalculation: { totalPoints: 142, candidateCodes: ["160000310", "160000410", "112007410", "160061710"] },
    requiredBillingSignals: ["尿一般", "尿蛋白", "尿・糞便等検査判断料"],
    requiredClinicalAnchors: ["当日に尿定性または尿一般を実施", "尿蛋白を当日実施", "予定・前回結果ではないこと"],
    forbiddenCandidates: ["検体検査管理加算"]
  },
  {
    key: "lab.urine.blood.collection.management",
    domains: ["lab", "facility_standards"],
    facilityFixtureKey: "clinic_lab",
    expectedCalculation: { totalPoints: 282, candidateCodes: ["160000310", "160000410", "112007410", "160061710", "160182770", "160095710"] },
    requiredBillingSignals: ["尿一般", "尿蛋白", "Ｂ－Ｖ", "検体検査管理加算"],
    requiredClinicalAnchors: ["当日に尿定性または尿一般を実施", "同日に静脈採血を実施", "施設fixtureで検体検査管理加算2届出"],
    forbiddenCandidates: []
  },
  {
    key: "lab.cbc.crp.revisit.blood",
    domains: ["lab"],
    facilityFixtureKey: "clinic_basic",
    expectedCalculation: { totalPoints: 421, candidateCodes: ["160054710", "160008010", "112007410", "160061810", "160062110", "160095710"] },
    requiredBillingSignals: ["CRP", "末梢血液一般", "血液学的検査判断料", "免疫学的検査判断料", "Ｂ－Ｖ"],
    requiredClinicalAnchors: ["当日に血算またはCBCを実施", "当日にCRPを測定", "静脈採血を実施"],
    forbiddenCandidates: []
  },
  {
    key: "lab.flu.revisit.management",
    domains: ["lab"],
    facilityFixtureKey: "clinic_lab",
    expectedCalculation: { totalPoints: 491, candidateCodes: ["160169450", "112007410", "160062110", "160182770"] },
    requiredBillingSignals: ["インフルエンザ迅速", "免疫学的検査判断料", "検体検査管理加算"],
    requiredClinicalAnchors: ["当日にインフルエンザ迅速または抗原検査を実施", "施設fixtureで検体検査管理加算2届出"],
    forbiddenCandidates: []
  },
  {
    key: "lab.strep.initial.blood",
    domains: ["lab", "pediatric_addons"],
    facilityFixtureKey: "clinic_basic",
    expectedCalculation: { totalPoints: 596, candidateCodes: ["160044110", "111000110", "160062110", "160095710"] },
    requiredBillingSignals: ["溶連菌迅速", "免疫学的検査判断料", "Ｂ－Ｖ"],
    requiredClinicalAnchors: ["当日に溶連菌迅速を実施", "静脈採血を実施"],
    forbiddenCandidates: []
  },
  {
    key: "lab.covid_flu.initial.blood",
    domains: ["lab"],
    facilityFixtureKey: "clinic_basic",
    expectedCalculation: { totalPoints: 700, candidateCodes: ["160230050", "111000110", "160062110", "160095710"] },
    requiredBillingSignals: ["コロナ・インフル同時抗原", "免疫学的検査判断料", "Ｂ－Ｖ"],
    requiredClinicalAnchors: ["当日にコロナ・インフル同時抗原または迅速を実施", "静脈採血を実施"],
    forbiddenCandidates: []
  },
  {
    key: "medication.outside.generic.initial",
    domains: ["medication"],
    facilityFixtureKey: "clinic_basic",
    expectedCalculation: { totalPoints: 361, candidateCodes: ["111000110", "120002910", "120004270"] },
    requiredBillingSignals: ["処方箋料", "一般名処方"],
    requiredClinicalAnchors: ["当日に院外処方箋を交付", "一般名処方であること", "院内処方ではないこと"],
    forbiddenCandidates: ["調剤料", "処方料"]
  },
  {
    key: "medication.inhouse.external.burn",
    domains: ["medication", "procedure"],
    facilityFixtureKey: "clinic_basic",
    expectedCalculation: { totalPoints: 273, candidateCodes: ["620008991", "112007410", "120001010", "120001210", "140032010"] },
    requiredBillingSignals: ["熱傷処置", "外用薬院内処方", "調剤料", "処方料"],
    requiredClinicalAnchors: ["100cm2未満の熱傷処置を当日実施", "ゲーベンクリーム等の外用薬を院内処方", "院外処方箋ではないこと"],
    forbiddenCandidates: ["処方箋料"]
  },
  {
    key: "imaging.simple_xray.revisit",
    domains: ["imaging"],
    facilityFixtureKey: "clinic_basic",
    expectedCalculation: { totalPoints: 228, candidateCodes: ["112007410", "170000410", "170027910"] },
    requiredBillingSignals: ["単純X線", "写真診断"],
    requiredClinicalAnchors: ["当日にX線またはレントゲン撮影を実施", "撮影部位を臨床語で記録"],
    forbiddenCandidates: ["CT撮影", "MRI撮影"]
  },
  {
    key: "imaging.simple_xray.e_management",
    domains: ["imaging", "facility_standards"],
    facilityFixtureKey: "clinic_imaging",
    expectedCalculation: { totalPoints: 285, candidateCodes: ["112007410", "170000410", "170027910", "170000210"] },
    requiredBillingSignals: ["単純X線", "写真診断", "電子画像管理"],
    requiredClinicalAnchors: ["当日にX線またはレントゲン撮影を実施", "電子保存はfacility fixtureで評価"],
    forbiddenCandidates: ["CT撮影", "MRI撮影"]
  },
  {
    key: "imaging.ct.revisit.e_management",
    domains: ["imaging"],
    facilityFixtureKey: "clinic_imaging",
    expectedCalculation: { totalPoints: 1095, candidateCodes: ["112007410", "170011810", "170028810"] },
    requiredBillingSignals: ["CT", "電子画像管理"],
    requiredClinicalAnchors: ["当日にCTを実施", "部位は臨床語で記録", "機器区分と電子保存はfixtureで評価"],
    forbiddenCandidates: ["単純X線", "MRI撮影"]
  },
  {
    key: "imaging.ct.initial.e_management",
    domains: ["imaging"],
    facilityFixtureKey: "clinic_imaging",
    expectedCalculation: { totalPoints: 1311, candidateCodes: ["111000110", "170011810", "170028810"] },
    requiredBillingSignals: ["CT", "電子画像管理"],
    requiredClinicalAnchors: ["当日にCTを実施", "初診として評価", "機器区分と電子保存はfixtureで評価"],
    forbiddenCandidates: ["単純X線", "MRI撮影"]
  }
];

const reviewArchetypes = [
  ["lab.ambiguous_code", "lab", ["検査コード確認"], ["検査名は本文にあるが、標準コード・方法・検体の確定が必要"]],
  ["lab.same_month", "lab", ["同月内検査確認"], ["同月内に類似検査がある前提で、重複算定確認が必要"]],
  ["imaging.contrast_unknown", "imaging", ["造影確認", "電子保存確認"], ["画像実施はあるが造影有無または電子保存条件が未確定"]],
  ["imaging.equipment_unknown", "imaging", ["機器区分確認"], ["CT/MRIの実施はあるが機器区分がfixtureまたは入力から確定しない"]],
  ["medication.missing_days", "medication", ["薬剤日数不足"], ["処方薬名・用法はあるが日数または総量が不足"]],
  ["medication.missing_total", "medication", ["総量不足"], ["外用/点眼/吸入などで総量が不足"]],
  ["management.target_disease", "medical_management", ["対象疾患確認", "療養計画確認", "同月履歴確認"], ["管理料は対象疾患・管理主体・同月履歴の確認が必要"]],
  ["procedure.same_day_duplicate", "procedure", ["同日重複確認", "手技内容確認"], ["処置実施はあるが同日重複・手技内容の確認が必要"]],
  ["materials.quantity", "materials", ["材料確認", "数量確認"], ["材料使用はあるが種類または数量が未確定"]],
  ["injection.route_dose", "injection", ["注射経路確認", "薬剤量確認"], ["注射実施または予定があるが経路・用量の確認が必要"]],
  ["emergency.time", "emergency_time_addons", ["救急加算確認", "受付時刻確認"], ["時間外/休日/夜間の可能性があるが受付時刻と条件確認が必要"]],
  ["pediatric.addon", "pediatric_addons", ["小児加算確認", "受付時刻確認"], ["小児加算の年齢・時刻・受診条件確認が必要"]],
  ["facility.notification", "facility_standards", ["届出確認", "施設基準確認"], ["施設基準の有無が点数に影響する"]]
].map(([key, domain, topics, anchors]) => ({ key, domains: [domain], requiredReviewTopics: topics, requiredClinicalAnchors: anchors }));

const unsupportedArchetypes = [
  ["surgery.unsupported", "surgery", ["手術未対応", "手技内容確認"]],
  ["anesthesia.unsupported", "anesthesia", ["麻酔未対応", "面接時間確認"]],
  ["psychiatry.unsupported", "psychiatry", ["精神科専門療法未対応", "診療時間確認"]],
  ["rehab.unsupported", "rehab", ["リハビリ未対応", "実施単位確認"]],
  ["homecare.unsupported", "homecare", ["在宅医療未対応", "訪問診療確認"]],
  ["pathology.unsupported", "pathology", ["病理診断未対応", "検体提出確認"]],
  ["endoscopy.unsupported", "endoscopy", ["内視鏡未対応", "生検有無確認"]],
  ["dialysis.unsupported", "dialysis", ["透析未対応", "実施時間確認"]],
  ["transfusion.unsupported", "transfusion", ["輸血未対応", "製剤量確認"]],
  ["radiation.unsupported", "radiation_therapy", ["放射線治療未対応", "照射条件確認"]]
].map(([key, domain, topics]) => ({ key, domains: [domain], requiredReviewTopics: topics, requiredClinicalAnchors: [`${topics[0].replace("未対応", "")}領域の記載が自然な臨床文から読める`] }));

const safetyArchetypes = [
  ["negated.lab", "safety_negation", ["実施確認"], ["検査名はあるが未実施・見送りが明記される"], ["検査実施料"]],
  ["planned.imaging", "imaging", ["実施確認"], ["画像は予定または予約で、当日実施ではない"], ["画像診断料"]],
  ["external.result", "lab", ["他科・他院情報"], ["他院/健診/持参結果として記載される"], ["検査実施料"]],
  ["otc.medication", "medication", ["薬剤情報"], ["市販薬または持参薬で、今回処方ではない"], ["薬剤料", "処方料"]],
  ["considered.procedure", "procedure", ["実施確認"], ["処置は検討または説明のみで、実施されていない"], ["処置料"]]
].map(([key, domain, topics, anchors, forbidden]) => ({ key, domains: [domain], requiredReviewTopics: topics, requiredClinicalAnchors: anchors, forbiddenCandidates: forbidden }));

const splitArchetypes = [
  {
    key: "split.multi_day.single_note",
    domains: ["split_multi_day"],
    requiredReviewTopics: ["複数日記録分割"],
    requiredClinicalAnchors: ["1つのSOAPに複数診療日が混在し、日付ごとに算定分割が必要"]
  },
  {
    key: "split.inpatient_daily_actions",
    domains: ["split_multi_day", "inpatient_basic"],
    requiredReviewTopics: ["複数日記録分割", "入院日数確認"],
    requiredClinicalAnchors: ["入院中の複数日経過と当日算定対象が混在し、対象日の確認が必要"]
  }
];

function weightedPool(items, countKey, target) {
  const pool = [];
  for (const item of items) {
    const n = Number(item[countKey] || 0);
    for (let i = 0; i < n; i += 1) pool.push(item.key);
  }
  if (!pool.length) return Array.from({ length: target }, (_, i) => `unknown_${i}`);
  while (pool.length < target) pool.push(pool[pool.length % items.length]);
  return pool.slice(0, target);
}

function assertionPoolFromTargets(targets) {
  const entries = Object.entries(targets).map(([key, count]) => ({ key, remaining: Number(count), total: Number(count) }));
  const out = [];
  while (out.length < TOTAL && entries.some((e) => e.remaining > 0)) {
    entries.sort((a, b) => (b.remaining / b.total) - (a.remaining / a.total));
    const next = entries.find((e) => e.remaining > 0);
    out.push(next.key);
    next.remaining -= 1;
  }
  return out;
}

function makeExistingBlueprint(sourceCase, index) {
  const assertion = sourceCase.expectedCalculation?.assertionLevel || "review_required";
  const domains = inferDomainsFromSourceCase(sourceCase);
  const requiredAnchors = [
    ...(sourceCase.expectedExtraction?.requiredBillingSignals || []).map((signal) => `${signal}に対応する自然な臨床根拠が本文にある`),
    ...(sourceCase.expectedExtraction?.requiredReviewTopics || []).map((topic) => `${topic}を本文から自然に導ける記載がある`),
    ...(sourceCase.expectedExtraction?.requiredDiagnoses || []).map((diagnosis) => `${diagnosis}に対応する病名・評価が本文にある`)
  ];
  return {
    blueprintId: serial(index),
    authoredCaseId: sourceCase.caseId,
    status: "chart_authored",
    caseTypeKey: `authored.${domains.join("_")}.${sourceCase.encounter?.department || "unknown"}.${assertion}.${slug(sourceCase.title || sourceCase.caseId)}`,
    title: sourceCase.title,
    department: sourceCase.encounter?.department || "unknown",
    billingDomains: domains,
    assertionLevel: assertion,
    facilityFixtureKey: sourceCase.facilityFixtureKey,
    patientProfile: sourceCase.patient,
    encounter: sourceCase.encounter,
    expectedExtraction: sourceCase.expectedExtraction,
    expectedClaimContext: sourceCase.expectedClaimContext,
    expectedCalculation: assertion === "exact"
      ? sourceCase.expectedCalculation
      : {
          assertionLevel: assertion,
          totalPoints: null,
          candidateCodes: [],
          engineStatus: "needs_review"
        },
    requiredClinicalAnchors: requiredAnchors.length ? requiredAnchors : [`${sourceCase.title || sourceCase.caseId}のreview/safety根拠が本文から自然に読める`],
    distractorRequirements: (sourceCase.distractors || []).map((d) => `${d.type}: ${d.name}`),
    chartAuthoringState: "done",
    reviewPolicy: baseReviewPolicy()
  };
}

function inferDomainsFromSourceCase(sourceCase) {
  const signals = [
    ...(sourceCase.expectedExtraction?.requiredBillingSignals || []),
    ...(sourceCase.expectedExtraction?.requiredReviewTopics || [])
  ].join(" ");
  const codes = (sourceCase.expectedCalculation?.candidateCodes || []).join(" ");
  const domains = new Set();
  if (/尿|CRP|血算|インフル|溶連菌|HbA1c|IgE|検査|判断料|160/.test(signals + codes)) domains.add("lab");
  if (/CT|MRI|X線|画像|撮影|170/.test(signals + codes)) domains.add("imaging");
  if (/処方|薬|ゲーベン|120|620/.test(signals + codes)) domains.add("medication");
  if (/処置|熱傷|創傷|140/.test(signals + codes)) domains.add("procedure");
  if (/管理料|対象疾患|療養/.test(signals)) domains.add("medical_management");
  if (/病理|細胞診/.test(signals)) domains.add("pathology");
  if (/在宅|訪問/.test(signals)) domains.add("homecare");
  if (/リハ/.test(signals)) domains.add("rehab");
  if (!domains.size) domains.add("basic");
  return [...domains];
}

function makePlannedBlueprint(serialIndex, assertion, poolIndex, counters) {
  const department = departmentPool[poolIndex % departmentPool.length];
  const preferredDomain = domainPool[poolIndex % domainPool.length];
  const archetype = pickArchetype(assertion, preferredDomain, counters[assertion] || 0);
  counters[assertion] = (counters[assertion] || 0) + 1;
  const domains = archetype.domains?.length ? archetype.domains : [preferredDomain];
  const key = [
    assertion,
    department,
    domains.join("_"),
    archetype.key,
    archetype.facilityFixtureKey || fixtureForAssertion(assertion),
    contextTrapForIndex(poolIndex),
    `v${counters[assertion]}`
  ].join(".");

  return {
    blueprintId: serial(serialIndex),
    status: "blueprint_ready_chart_pending",
    caseTypeKey: key,
    title: `${department} ${archetype.key} ${assertion}`,
    department,
    billingDomains: domains,
    assertionLevel: assertion,
    facilityFixtureKey: archetype.facilityFixtureKey || fixtureForAssertion(assertion),
    patientProfile: patientProfileFor(department, poolIndex),
    encounter: encounterFor(assertion, poolIndex),
    expectedExtraction: {
      requiredDiagnoses: diagnosisHintsFor(department, domains, poolIndex),
      requiredBillingSignals: archetype.requiredBillingSignals || [],
      requiredReviewTopics: archetype.requiredReviewTopics || [],
      forbiddenCandidates: archetype.forbiddenCandidates || []
    },
    expectedClaimContext: expectedClaimContextFor(archetype, assertion, poolIndex),
    expectedCalculation: expectedCalculationFor(archetype, assertion),
    requiredClinicalAnchors: archetype.requiredClinicalAnchors || [],
    distractorRequirements: distractorsFor(poolIndex),
    chartAuthoringState: "not_started",
    chartAuthoringNotes: [
      "SOAP本文は手書きする。採点用メタ文・正式マスター名・施設属性は書かない。",
      "requiredClinicalAnchorsを自然な臨床文としてS/O/A/Pへ分散して入れる。",
      "distractorRequirementsは予定・過去・他院・否定・市販などの文脈を明示する。"
    ],
    reviewPolicy: baseReviewPolicy()
  };
}

function pickArchetype(assertion, preferredDomain, n) {
  if (assertion === "exact") {
    const matching = exactArchetypes.filter((a) => a.domains.includes(preferredDomain));
    const list = matching.length ? matching : exactArchetypes;
    return list[n % list.length];
  }
  if (assertion === "review_required") {
    const matching = reviewArchetypes.filter((a) => a.domains.includes(preferredDomain));
    const list = matching.length ? matching : reviewArchetypes;
    return list[n % list.length];
  }
  if (assertion === "safety") {
    const matching = safetyArchetypes.filter((a) => a.domains.includes(preferredDomain));
    const list = matching.length ? matching : safetyArchetypes;
    return list[n % list.length];
  }
  if (assertion === "unsupported_expected") {
    const matching = unsupportedArchetypes.filter((a) => a.domains.includes(preferredDomain));
    const list = matching.length ? matching : unsupportedArchetypes;
    return list[n % list.length];
  }
  return splitArchetypes[n % splitArchetypes.length];
}

function expectedCalculationFor(archetype, assertion) {
  if (assertion === "exact") {
    return {
      assertionLevel: "exact",
      totalPoints: archetype.expectedCalculation.totalPoints,
      candidateCodes: archetype.expectedCalculation.candidateCodes,
      engineStatus: "completed"
    };
  }
  return {
    assertionLevel: assertion,
    totalPoints: null,
    candidateCodes: [],
    engineStatus: "needs_review"
  };
}

function expectedClaimContextFor(archetype, assertion, index) {
  const serviceDate = `2026-08-${String((index % 24) + 1).padStart(2, "0")}`;
  const context = {
    encounter: {
      service_date: serviceDate,
      is_outpatient: assertion !== "split_required",
      regional_bureau: "kanto-shinetsu",
      medical_institution_code: "1312345"
    }
  };
  if (assertion === "exact") {
    context.procedure_codes = (archetype.expectedCalculation.candidateCodes || []).filter((code) => /^1[467]/.test(code));
    if ((archetype.expectedCalculation.candidateCodes || []).includes("111000110")) {
      context.outpatient_basic = { fee_kind: "initial" };
    } else if ((archetype.expectedCalculation.candidateCodes || []).includes("112007410")) {
      context.outpatient_basic = { fee_kind: "revisit" };
    }
    if ((archetype.expectedCalculation.candidateCodes || []).includes("160095710")) {
      context.lab_options = { collection_fee_inputs: ["blood_venous"] };
    }
    if ((archetype.expectedCalculation.candidateCodes || []).some((code) => code.startsWith("620"))) {
      context.drug_inputs = [{ code: "620008991", quantity: "10" }];
    }
    if ((archetype.expectedCalculation.candidateCodes || []).includes("120001010")) {
      context.medication = { delivery_kind: "in_house", prescription_category: "other", dispensing_kinds: ["external"] };
    }
    if ((archetype.expectedCalculation.candidateCodes || []).includes("140032010")) {
      context.treatment_orders = [{ kind: "burn", area_size: "lt_100_cm2" }];
    }
    if (archetype.facilityFixtureKey === "clinic_lab" || archetype.facilityFixtureKey === "clinic_full") {
      context.facility_standard_keys = ["検体検査管理加算2"];
    }
  }
  return context;
}

function fixtureForAssertion(assertion) {
  if (assertion === "exact") return "clinic_basic";
  if (assertion === "split_required") return "hospital_acute";
  return "clinic_basic";
}

function encounterFor(assertion, index) {
  const visitType = index % 3 === 0 ? "initial" : "revisit";
  return {
    setting: assertion === "split_required" ? "mixed_or_inpatient" : "outpatient",
    visitType,
    serviceDate: `2026-08-${String((index % 24) + 1).padStart(2, "0")}`
  };
}

function patientProfileFor(department, index) {
  if (department === "pediatrics") return { age: 3 + (index % 10), sex: index % 2 ? "female" : "male" };
  if (department === "geriatrics") return { age: 75 + (index % 18), sex: index % 2 ? "female" : "male" };
  if (department === "obgyn") return { age: 24 + (index % 38), sex: "female" };
  return { age: 18 + (index % 70), sex: index % 2 ? "female" : "male" };
}

function diagnosisHintsFor(department, domains, index) {
  if (domains.includes("lab")) return ["検査対象疾患"];
  if (domains.includes("imaging")) return ["画像評価対象疾患"];
  if (domains.includes("medication")) return ["処方対象疾患"];
  if (domains.includes("medical_management")) return ["慢性疾患"];
  if (department === "dermatology") return ["皮膚疾患"];
  if (department === "otolaryngology") return ["耳鼻咽喉科疾患"];
  return ["主病名候補"];
}

function contextTrapForIndex(index) {
  return ["past_value", "external_result", "planned_order", "negated_action", "otc_or_home_med", "family_history", "normal_negative_result", "quantity_missing"][index % 8];
}

function distractorsFor(index) {
  const all = [
    "前回値または過去検査を混ぜる",
    "他院/健診/持参結果を混ぜる",
    "次回予定または検討のみの行為を混ぜる",
    "未実施・見送りを明記する",
    "市販薬または持参薬を混ぜる",
    "家族歴・職業・生活背景を混ぜる",
    "陰性/正常結果を混ぜる",
    "数量不足の処方または材料を混ぜる"
  ];
  return [all[index % all.length], all[(index + 3) % all.length]];
}

function baseReviewPolicy() {
  return {
    productionGoldAllowed: false,
    medicalOfficeReviewed: false,
    purpose: "synthetic_v2_technical_evaluation"
  };
}

function serial(n) {
  return `V2BP-${String(n).padStart(4, "0")}`;
}

function slug(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9一-龠ぁ-んァ-ン]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "case";
}

const authoredCases = authoredDataset.cases || [];
const authoredBlueprints = authoredCases.slice(0, TOTAL).map((sourceCase, index) => makeExistingBlueprint(sourceCase, index + 1));
const remainingTargets = { ...assertionTargets };
for (const blueprint of authoredBlueprints) {
  if (remainingTargets[blueprint.assertionLevel] > 0) remainingTargets[blueprint.assertionLevel] -= 1;
}

const assertionPool = assertionPoolFromTargets(remainingTargets);
const generatedBlueprints = [];
const counters = {};
for (let i = 0; authoredBlueprints.length + generatedBlueprints.length < TOTAL; i += 1) {
  const assertion = assertionPool[i] || "review_required";
  generatedBlueprints.push(makePlannedBlueprint(authoredBlueprints.length + generatedBlueprints.length + 1, assertion, i, counters));
}

const blueprints = [...authoredBlueprints, ...generatedBlueprints];

const output = {
  schemaVersion: "fee-soap-e2e-v2.gold-blueprints.v1",
  datasetId: "fee-soap-e2e-v2",
  generatedAt: "2026-06-12",
  intent: "SOAP本文を手書きする前に、1000種類の算定ゴールドblueprintを固定する。",
  claudeV2Principles: [
    "採点用メタ文をカルテ本文に入れない",
    "正式な診療報酬名をカルテ本文に書かない",
    "施設情報はfacility fixtureへ分離する",
    "臨床アンカーを必ず置く",
    "過去・他院・予定・見送り・市販薬などの邪魔情報を入れる",
    "同じ算定文脈を複数の書き方で揺らす",
    "医療事務レビュー前のsynthetic goldとして扱う"
  ],
  targetMix: assertionTargets,
  sourceAuthoredCases: authoredBlueprints.length,
  blueprints
};

fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

const byAssertion = {};
const byStatus = {};
for (const item of blueprints) {
  byAssertion[item.assertionLevel] = (byAssertion[item.assertionLevel] || 0) + 1;
  byStatus[item.status] = (byStatus[item.status] || 0) + 1;
}
console.log(`wrote ${blueprints.length} blueprints`);
console.log(`assertions: ${JSON.stringify(byAssertion)}`);
console.log(`status: ${JSON.stringify(byStatus)}`);
