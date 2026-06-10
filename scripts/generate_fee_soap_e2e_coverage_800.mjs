#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { decorateDatasetCaseTypes } from "./fee_soap_case_type_signature.mjs";

const repoRoot = process.cwd();
const datasetPath = path.join(repoRoot, "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json");
const outputPath = datasetPath;
const verifiedAt = "2026-06-08";
const targetTotal = 800;

function main() {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const originalCases = (dataset.cases || [])
    .filter((item) => !String(item.caseId || "").startsWith("COV-"))
    .map((item) => normalizeCaseForbiddenCandidates(item));
  const existingById = new Map(originalCases.map((item) => [item.caseId, item]));
  const exactPrototypes = loadExactPrototypes(existingById);
  const additions = [
    ...buildExactCoverageCases(exactPrototypes),
    ...buildReviewCoverageCases(),
    ...buildUnsupportedCoverageCases(),
    ...buildSafetyCoverageCases(),
    ...buildSplitCoverageCases()
  ];

  if (additions.length !== 500) {
    throw new Error(`expected 500 additions, got ${additions.length}`);
  }

  dataset.version = "2026-06-08.1";
  dataset.purpose = "fee-chart-gold-seed-300由来の既存300件に、全診療科・主要算定章・安全/未対応領域の網羅性を高める500件を追加したSOAP E2E正本。exact/review_required/safety/unsupported_expected/split_requiredを同じファイルで管理する。";
  dataset.coverageExpansion = {
    generatedAt: verifiedAt,
    targetTotal,
    additions: additions.length,
    policy: "追加500件は合成SOAPのみ。exactは既存の検証済みclaim contextを再利用し、review/safety/unsupportedは医療事務レビュー前の確認用草案として扱う。",
    status: "needs_office_review"
  };
  dataset.evaluationPolicy = {
    ...(dataset.evaluationPolicy || {}),
    forbiddenCandidatePolicy: "forbiddenCandidates は抽出器/算定器が確定候補にしてはいけない正規化済みコードまたは候補ラベル。状態語は使わず、禁止理由は requiredReviewTopics に持たせる。"
  };
  dataset.cases = [...originalCases, ...additions].sort((a, b) => a.caseId.localeCompare(b.caseId));

  if (dataset.cases.length !== targetTotal) {
    throw new Error(`expected ${targetTotal} cases, got ${dataset.cases.length}`);
  }

  decorateDatasetCaseTypes(dataset);

  fs.writeFileSync(outputPath, `${JSON.stringify(dataset, null, 2)}\n`);

  const assertionCounts = countBy(dataset.cases, (item) => item.expectedCalculation?.assertionLevel);
  const departmentCounts = countBy(dataset.cases, (item) => item.encounter?.department);
  console.log(JSON.stringify({
    datasetId: dataset.datasetId,
    version: dataset.version,
    cases: dataset.cases.length,
    additions: additions.length,
    assertionCounts,
    departmentCounts,
    output: path.relative(repoRoot, outputPath)
  }, null, 2));
}

function loadExactPrototypes(casesById) {
  const ids = [
    "L1-001-pediatric-fever-flu-strep-revisit",
    "L1-003-adult-uri-covid-flu-initial",
    "L1-004-urine-lab-revisit-management-fee",
    "L1-005-burn-revisit-small-area",
    "L1-006-burn-revisit-gebenkream-inhouse",
    "L1-007-ct-head-revisit",
    "L1-008-outside-prescription-generic-addon-revisit",
    "L1-009-inpatient-basic-acute-general-two-days",
    "L1-010-simple-xray-revisit-explicit-codes"
  ];
  const result = {};
  for (const id of ids) {
    const item = casesById.get(id);
    if (!item) {
      throw new Error(`missing exact prototype: ${id}`);
    }
    result[id] = item;
  }
  return result;
}

function buildExactCoverageCases(prototypes) {
  const plan = [
    ["pediatrics", "pediatric_addons", 10, prototypes["L1-001-pediatric-fever-flu-strep-revisit"]],
    ["otolaryngology", "lab", 4, prototypes["L1-001-pediatric-fever-flu-strep-revisit"]],
    ["otolaryngology", "medication", 4, prototypes["L1-008-outside-prescription-generic-addon-revisit"]],
    ["ophthalmology", "imaging", 6, prototypes["L1-010-simple-xray-revisit-explicit-codes"]],
    ["ophthalmology", "medication", 2, prototypes["L1-008-outside-prescription-generic-addon-revisit"]],
    ["orthopedics", "imaging", 6, prototypes["L1-010-simple-xray-revisit-explicit-codes"]],
    ["orthopedics", "procedure", 4, prototypes["L1-005-burn-revisit-small-area"]],
    ["surgery", "procedure", 8, prototypes["L1-005-burn-revisit-small-area"]],
    ["obgyn", "lab", 4, prototypes["L1-004-urine-lab-revisit-management-fee"]],
    ["obgyn", "imaging", 4, prototypes["L1-007-ct-head-revisit"]],
    ["urology", "lab", 7, prototypes["L1-004-urine-lab-revisit-management-fee"]],
    ["urology", "procedure", 3, prototypes["L1-005-burn-revisit-small-area"]],
    ["cardiology", "lab", 4, prototypes["L1-004-urine-lab-revisit-management-fee"]],
    ["cardiology", "imaging", 4, prototypes["L1-010-simple-xray-revisit-explicit-codes"]],
    ["gastroenterology", "lab", 4, prototypes["L1-004-urine-lab-revisit-management-fee"]],
    ["gastroenterology", "imaging", 4, prototypes["L1-007-ct-head-revisit"]],
    ["respiratory", "lab", 6, prototypes["L1-003-adult-uri-covid-flu-initial"]],
    ["respiratory", "imaging", 6, prototypes["L1-010-simple-xray-revisit-explicit-codes"]],
    ["neurology", "imaging", 5, prototypes["L1-007-ct-head-revisit"]],
    ["emergency", "lab", 2, prototypes["L1-003-adult-uri-covid-flu-initial"]],
    ["emergency", "imaging", 5, prototypes["L1-010-simple-xray-revisit-explicit-codes"]],
    ["nephrology_dialysis", "lab", 7, prototypes["L1-004-urine-lab-revisit-management-fee"]],
    ["radiology", "imaging", 6, prototypes["L1-007-ct-head-revisit"]],
    ["internal_medicine", "inpatient_basic", 3, prototypes["L1-009-inpatient-basic-acute-general-two-days"]]
  ];
  const cases = [];
  let sequence = 301;
  for (const [department, domain, count, prototype] of plan) {
    for (let index = 0; index < count; index += 1) {
      cases.push(makeExactCase({
        source: prototype,
        caseId: `COV-L1-${pad(sequence++)}-${department}-${domain}-exact`,
        department,
        domain,
        index
      }));
    }
  }
  return cases;
}

function buildReviewCoverageCases() {
  const plan = [
    ["pathology", "pathology", 8],
    ["internal_medicine", "materials", 7],
    ["orthopedics", "materials", 8],
    ["internal_medicine", "injection", 8],
    ["nephrology_dialysis", "injection", 4],
    ["obgyn", "injection", 4],
    ["otolaryngology", "injection", 2],
    ["pediatrics", "injection", 2],
    ["nephrology_dialysis", "dialysis_transfusion", 17],
    ["gastroenterology", "endoscopy", 14],
    ["radiology", "radiation_therapy", 5],
    ["respiratory", "medical_management", 8],
    ["respiratory", "imaging", 8],
    ["respiratory", "lab", 4],
    ["neurology", "imaging", 6],
    ["neurology", "rehab", 5],
    ["emergency", "emergency_time_addons", 6],
    ["emergency", "imaging", 6],
    ["emergency", "procedure", 6],
    ["pediatrics", "medication", 4],
    ["pediatrics", "lab", 2],
    ["otolaryngology", "procedure", 4],
    ["otolaryngology", "lab", 4],
    ["otolaryngology", "medication", 4],
    ["ophthalmology", "procedure", 4],
    ["ophthalmology", "imaging", 4],
    ["ophthalmology", "medication", 2],
    ["ophthalmology", "facility_standards", 2],
    ["orthopedics", "rehab", 8],
    ["orthopedics", "surgery", 6],
    ["surgery", "pathology", 6],
    ["surgery", "anesthesia", 5],
    ["surgery", "surgery", 5],
    ["surgery", "procedure", 0],
    ["obgyn", "lab", 4],
    ["obgyn", "imaging", 6],
    ["urology", "surgery", 6],
    ["urology", "procedure", 2],
    ["urology", "lab", 2],
    ["cardiology", "medical_management", 6],
    ["cardiology", "lab", 2],
    ["cardiology", "imaging", 2],
    ["dermatology", "pathology", 5],
    ["dermatology", "surgery", 5],
    ["internal_medicine", "facility_standards", 0],
    ["internal_medicine", "inpatient_variants", 4],
    ["gastroenterology", "lab", 4],
    ["gastroenterology", "imaging", 4],
    ["radiology", "imaging", 8],
    ["cardiology", "facility_standards", 0],
    ["obgyn", "medical_management", 6],
    ["psychiatry", "inpatient_variants", 2],
    ["rehabilitation", "inpatient_variants", 2],
    ["pathology", "pathology", 2]
  ];
  const cases = [];
  let sequence = 401;
  for (const [department, domain, count] of plan) {
    for (let index = 0; index < count; index += 1) {
      cases.push(makeNonExactCase({
        caseId: `COV-L2-${pad(sequence++)}-${department}-${domain}-review`,
        assertionLevel: "review_required",
        department,
        domain,
        index
      }));
    }
  }
  return cases.slice(0, 260);
}

function buildUnsupportedCoverageCases() {
  const plan = [
    ["homecare", "homecare", 16],
    ["rehabilitation", "rehab", 16],
    ["psychiatry", "psychiatry", 16],
    ["surgery", "surgery", 14],
    ["surgery", "anesthesia", 8],
    ["pathology", "pathology", 10],
    ["nephrology_dialysis", "dialysis_transfusion", 10],
    ["gastroenterology", "endoscopy", 8],
    ["radiology", "radiation_therapy", 6],
    ["internal_medicine", "dpc_inpatient", 6],
    ["urology", "surgery", 4],
    ["dermatology", "pathology", 2],
    ["dermatology", "surgery", 2]
  ];
  const cases = [];
  let sequence = 651;
  for (const [department, domain, count] of plan) {
    for (let index = 0; index < count; index += 1) {
      cases.push(makeNonExactCase({
        caseId: `COV-L3-${pad(sequence++)}-${department}-${domain}-unsupported`,
        assertionLevel: "unsupported_expected",
        department,
        domain,
        index
      }));
    }
  }
  return cases.slice(0, 72);
}

function buildSafetyCoverageCases() {
  const plan = [
    ["pediatrics", "facility_standards", 2],
    ["dermatology", "materials", 1],
    ["otolaryngology", "injection", 2],
    ["ophthalmology", "facility_standards", 2],
    ["orthopedics", "materials", 1],
    ["obgyn", "injection", 2],
    ["urology", "surgery", 1],
    ["cardiology", "facility_standards", 1],
    ["respiratory", "homecare", 2],
    ["neurology", "rehab", 2],
    ["emergency", "emergency_time_addons", 3],
    ["internal_medicine", "facility_standards", 5],
    ["pediatrics", "emergency_time_addons", 3],
    ["radiology", "radiation_therapy", 3],
    ["nephrology_dialysis", "injection", 2],
    ["homecare", "homecare", 3],
    ["surgery", "anesthesia", 2],
    ["pathology", "pathology", 2],
    ["rehabilitation", "rehab", 1]
  ];
  const cases = [];
  let sequence = 751;
  for (const [department, domain, count] of plan) {
    for (let index = 0; index < count; index += 1) {
      cases.push(makeNonExactCase({
        caseId: `COV-L3-${pad(sequence++)}-${department}-${domain}-safety`,
        assertionLevel: "safety",
        department,
        domain,
        index
      }));
    }
  }
  return cases.slice(0, 40);
}

function buildSplitCoverageCases() {
  const departments = ["internal_medicine", "pediatrics", "orthopedics", "surgery", "cardiology", "gastroenterology", "respiratory", "homecare", "rehabilitation", "urology"];
  const cases = [];
  let sequence = 791;
  for (let index = 0; index < 10; index += 1) {
    cases.push(makeNonExactCase({
      caseId: `COV-L3-${pad(sequence++)}-${departments[index]}-split-multiday`,
      assertionLevel: "split_required",
      department: departments[index],
      domain: "split_multi_day",
      index
    }));
  }
  return cases;
}

function makeExactCase({ source, caseId, department, domain, index }) {
  const scenario = scenarioFor(department, domain, index, "exact");
  const clone = structuredClone(source);
  const serviceDate = serviceDateFor(index + 1);
  clone.caseId = caseId;
  clone.sourceCaseId = caseId;
  clone.sourceTitle = scenario.title;
  clone.title = scenario.title;
  clone.difficultyLevel = "L2";
  clone.calculationDifficulty = clone.calculationDifficulty || 1;
  clone.patient = patientFor(department, index);
  const expectedVisitType = clone.expectedClaimContext?.outpatient_basic?.fee_kind;
  clone.encounter = {
    setting: clone.expectedClaimContext?.encounter?.is_outpatient === false ? "inpatient" : "outpatient",
    visitType: ["initial", "revisit"].includes(expectedVisitType) ? expectedVisitType : visitTypeFor(index),
    department,
    serviceDate
  };
  if (clone.expectedClaimContext?.encounter) {
    clone.expectedClaimContext = structuredClone(clone.expectedClaimContext);
    clone.expectedClaimContext.encounter.service_date = serviceDate;
    clone.expectedClaimContext.encounter.is_outpatient = clone.encounter.setting !== "inpatient";
  }
  const exactScenario = scenarioAlignedToExactContext(scenario, clone);
  clone.chart = {
    format: "soap",
    soap: buildSoap({ scenario: exactScenario, patient: clone.patient, encounter: clone.encounter, assertionLevel: "exact" }),
    standard: ""
  };
  clone.chart.standard = standardNote(clone.chart.soap);
  clone.expectedExtraction = expectedExtractionForExact(clone, exactScenario);
  clone.status = "master_verified";
  clone.qualityLabel = "verified";
  clone.reviewPolicy = reviewPolicy("exact", true);
  clone.sourceReviewPolicy = sourceReviewPolicy("exact", true);
  return clone;
}

function scenarioAlignedToExactContext(scenario, item) {
  const aligned = { ...scenario };
  const billingTargetNames = (item.billingTargets || [])
    .map((target) => String(target.name || "").trim())
    .filter(Boolean);
  if (billingTargetNames.length) {
    aligned.targets = billingTargetNames.map((name) => ({
      name,
      type: targetTypeForName(name)
    }));
  }

  const imagingOrders = item.expectedClaimContext?.imaging_orders || [];
  if (imagingOrders.length) {
    aligned.objective = exactImagingObjective(imagingOrders, scenario.objective);
  }
  const expectedCodes = (item.expectedCalculation?.candidateCodes || []).map(String);
  if (expectedCodes.includes("160095710") && !/採血|血液検査|血液.*検体/u.test(aligned.objective || "")) {
    aligned.objective = `${aligned.objective} 同日に静脈採血を実施し、血液検体を提出した。`;
  }
  if (expectedCodes.includes("120002910")) {
    aligned.chief = `${scenario.chief} 当日は院外処方箋を交付した。`;
    aligned.objective = "当日、院外処方箋を交付した。処方箋料、院内外区分、一般名処方の有無を診療録で確認した。";
  }

  return aligned;
}

function targetTypeForName(name) {
  if (/CT|ＣＴ|MRI|単純撮影|X線|Ｘ線|超音波|画像/u.test(name)) return "imaging_candidate";
  if (/処方|調剤|薬/u.test(name)) return "medication_fee_candidate";
  if (/初診料|再診料|入院料/u.test(name)) return "basic_fee";
  if (/判断料|検査|CRP|ＣＲＰ|HbA1c|ＨｂＡ１ｃ/u.test(name)) return "lab_candidate";
  return "fee_candidate";
}

function exactImagingObjective(imagingOrders, fallback) {
  const order = imagingOrders[0] || {};
  const kind = String(order.kind || "").toLowerCase();
  if (kind === "ct") {
    const equipment = order.ct_equipment_kind === "multislice_16_to_64"
      ? "16列以上64列未満マルチスライス型機器"
      : "機器区分";
    return `CT撮影を実施し、身体所見と照合した。${equipment}、撮影部位、電子保存、造影有無を診療録で確認した。`;
  }
  if (kind === "mri") {
    return "MRI撮影を実施し、身体所見と照合した。機器区分、撮影部位、電子保存、造影有無を診療録で確認した。";
  }
  if (kind === "simple_radiography" || kind === "xray") {
    return "単純X線撮影を実施し、身体所見と照合した。撮影部位、撮影方式、電子保存、写真診断区分を診療録で確認した。";
  }
  if (kind === "ultrasound") {
    return "超音波検査を実施し、身体所見と照合した。検査部位、検査方法、所見を診療録で確認した。";
  }
  return fallback;
}

function makeNonExactCase({ caseId, assertionLevel, department, domain, index }) {
  const scenario = scenarioFor(department, domain, index, assertionLevel);
  const patient = patientFor(department, index);
  const encounter = {
    setting: settingFor(department, domain),
    visitType: visitTypeFor(index),
    department,
    serviceDate: serviceDateFor(index + 101)
  };
  const billingTargets = scenario.targets.map((target) => ({
    name: target.name,
    type: target.type
  }));
  const chart = buildSoap({ scenario, patient, encounter, assertionLevel });
  return {
    caseId,
    sourceCaseId: caseId,
    sourceTitle: scenario.title,
    title: scenario.title,
    difficultyLevel: assertionLevel === "review_required" ? "L2" : "L3",
    calculationDifficulty: assertionLevel === "review_required" ? 2 : 3,
    patient,
    encounter,
    chart: {
      format: "soap",
      soap: chart,
      standard: standardNote(chart)
    },
    status: "draft",
    qualityLabel: qualityLabelFor(assertionLevel),
    expectedExtraction: {
      requiredDiagnoses: scenario.diagnoses,
      requiredProcedureCandidates: [],
      requiredReviewTopics: scenario.reviewTopics,
      forbiddenCandidates: normalizeForbiddenCandidates(scenario.forbidden),
      requiredBillingSignals: scenario.targets.map((target) => target.name),
      signalExpectations: signalExpectations(scenario.targets.map((target) => target.name), domain)
    },
    expectedClaimContext: null,
    expectedCalculation: {
      assertionLevel,
      engineStatus: "needs_review",
      minimumCandidateCodes: [],
      totalPoints: null
    },
    billingTargets,
    evidence: billingTargets.map((target) => unsupportedEvidence(target.name)),
    sourceReviewPolicy: sourceReviewPolicy(assertionLevel, false),
    reviewPolicy: reviewPolicy(assertionLevel, false)
  };
}

function scenarioFor(department, domain, index, assertionLevel) {
  const dept = departmentLabel(department);
  const serial = index + 1;
  const base = scenarioMap[domain] || scenarioMap.lab;
  const title = `${dept} ${base.title} ${serial}`;
  const diagnoses = base.diagnoses(index);
  const targets = base.targets(index);
  const reviewTopics = base.reviewTopics(index);
  const forbidden = normalizeForbiddenCandidates(base.forbidden(index, assertionLevel));
  return {
    department,
    domain,
    title,
    diagnoses,
    chief: base.chief(index, dept),
    objective: base.objective(index, dept),
    assessment: base.assessment(index, dept),
    plan: base.plan(index, dept),
    targets,
    reviewTopics,
    forbidden
  };
}

const scenarioMap = {
  lab: {
    title: "検査条件確認",
    diagnoses: (i) => [pick(["急性上気道炎疑い", "尿路感染症疑い", "貧血疑い", "糖尿病疑い"], i)],
    targets: (i) => [{ name: pick(["CRP", "末梢血液一般検査", "尿一般", "HbA1c"], i), type: "lab_candidate" }],
    reviewTopics: (i) => [pick(["検査コード確認", "検体採取確認", "同月内検査確認", "判断料確認"], i)],
    forbidden: (i) => [pick(["未実施検査", "前回検査結果説明", "他院検査", "検査予定"], i)],
    chief: (i, dept) => `${dept}で症状の評価を希望。発症時期、症状の変化、既往歴、服薬状況、家族が心配している点を確認した。`,
    objective: (i) => `バイタルを確認し、${pick(["採血", "尿検体", "迅速検査", "血糖関連検査"], i)}の必要性を判断した。ただし検査名、検体、実施日、同月履歴の確認が必要。`,
    assessment: (i) => `${pick(["感染症", "炎症反応", "慢性疾患", "尿路疾患"], i)}の評価。検査候補はあるが、標準コードと同月算定条件を確認する。`,
    plan: () => "検査結果に応じて治療方針を見直す。結果説明、追加検査、再診目安を患者に伝え、未確定の条件は確認へ回す。"
  },
  medication: {
    title: "投薬条件確認",
    diagnoses: (i) => [pick(["急性気管支炎疑い", "疼痛", "湿疹", "胃炎"], i)],
    targets: (i) => [{ name: pick(["処方薬", "一般名処方加算", "外用薬", "頓服薬"], i), type: "medication_fee_candidate" }],
    reviewTopics: (i) => [pick(["薬剤日数不足", "総量不足", "一般名処方確認", "院内外処方確認"], i)],
    forbidden: (i) => [pick(["日数不明の処方薬", "抗菌薬処方", "前回処方", "処方予定"], i)],
    chief: () => "症状に対する薬剤希望、残薬、副作用歴、アレルギー、服薬しやすい剤形を確認した。",
    objective: (i) => `診察上は薬剤調整を検討。${pick(["1回量", "1日回数", "日数", "総量"], i)}が不足しており、薬剤料や処方関連の確定には追加確認が必要。`,
    assessment: () => "薬剤候補はあるが、用量、日数、院内外、一般名処方の条件が不足している。",
    plan: () => "服薬方法、悪化時対応、副作用時の連絡方法を説明した。処方条件が確定したら算定候補を再確認する。"
  },
  medical_management: {
    title: "医学管理料確認",
    diagnoses: (i) => [pick(["高血圧症", "糖尿病", "気管支喘息", "脂質異常症"], i)],
    targets: (i) => [{ name: pick(["生活習慣病管理料", "特定疾患療養管理料", "皮膚科特定疾患指導管理料", "喘息管理料"], i), type: "management_candidate" }],
    reviewTopics: (i) => [pick(["管理料確認", "同月履歴確認", "対象疾患確認", "療養計画確認"], i)],
    forbidden: (i) => [pick(["条件未確認の管理料", "同月重複管理料", "対象外疾患の管理料", "説明のみ管理料"], i)],
    chief: () => "慢性疾患の継続管理として、家庭での測定値、服薬状況、生活習慣、治療目標への理解を確認した。",
    objective: () => "診察、測定値、検査結果、服薬状況を確認し、療養指導を行った。ただし対象疾患、計画書、同月履歴の確認が必要。",
    assessment: () => "慢性疾患管理の候補だが、施設基準、同月算定、対象疾患の条件を確認する必要がある。",
    plan: () => "生活指導、服薬指導、次回検査予定、悪化時の受診目安を説明した。管理料は条件確認後に扱う。"
  },
  procedure: {
    title: "処置条件確認",
    diagnoses: (i) => [pick(["創傷", "熱傷", "外耳道炎", "角膜異物疑い"], i)],
    targets: (i) => [{ name: pick(["創傷処置", "熱傷処置", "耳鼻科処置", "眼科処置"], i), type: "treatment_candidate" }],
    reviewTopics: (i) => [pick(["処置面積不足", "処置部位確認", "手技内容確認", "同日重複確認"], i)],
    forbidden: (i) => [pick(["面積不明の処置", "予定処置", "前回処置", "条件未確認の処置"], i)],
    chief: () => "疼痛、受傷機転、処置希望、自宅で行った処置、感染への不安を確認した。",
    objective: (i) => `部位、発赤、腫脹、浸出液を確認し、${pick(["洗浄", "保護", "異物確認", "局所処置"], i)}を行った。面積や手技区分は追加確認が必要。`,
    assessment: () => "処置候補はあるが、部位、面積、手技、同日重複の条件が不足している。",
    plan: () => "自宅管理、清潔保持、悪化時の受診目安を説明した。処置区分は記録を確認してから扱う。"
  },
  imaging: {
    title: "画像診断条件確認",
    diagnoses: (i) => [pick(["頭痛精査", "腹痛精査", "胸痛精査", "外傷精査"], i)],
    targets: (i) => [{ name: pick(["CT撮影", "単純X線撮影", "MRI", "超音波検査"], i), type: "imaging_candidate" }],
    reviewTopics: (i) => [pick(["撮影部位確認", "CT機器区分確認", "施設基準確認", "造影確認"], i)],
    forbidden: (i) => [pick(["前回画像結果説明", "画像検査予定", "他院画像", "施設基準未確認の画像診断管理加算"], i)],
    chief: () => "症状の部位、発症時期、危険徴候、外傷歴、検査への不安、造影剤アレルギーを確認した。",
    objective: (i) => `${pick(["CT", "X線", "MRI", "超音波"], i)}の必要性を検討し、身体所見と照合した。撮影部位、機器区分、電子保存、造影有無の確認が必要。`,
    assessment: () => "画像検査候補はあるが、部位、機器、造影、施設基準が未確定。",
    plan: () => "検査結果の説明、再診目安、悪化時対応、専門科紹介の必要性を説明した。"
  },
  injection: {
    title: "注射条件確認",
    diagnoses: () => ["脱水疑い"],
    targets: () => [{ name: "注射料", type: "injection_candidate" }],
    reviewTopics: () => ["注射経路確認", "薬剤量確認"],
    forbidden: () => ["点滴予定", "経路不明の注射"],
    chief: () => "食事量低下と水分摂取不足を訴え、補液の必要性を相談した。",
    objective: () => "口腔乾燥、尿量、バイタルを確認。補液の記載はあるが、経路、薬剤、量、時間が不足している。",
    assessment: () => "注射・点滴候補だが、経路と薬剤量が不明で確定できない。",
    plan: () => "水分摂取、悪化時対応、補液実施条件を説明した。注射条件は追加記録を確認する。"
  },
  pediatric_addons: {
    title: "小児加算確認",
    diagnoses: () => ["急性上気道炎疑い"],
    targets: () => [{ name: "乳幼児時間外加算", type: "time_based_candidate" }],
    reviewTopics: () => ["小児加算確認", "受付時刻確認"],
    forbidden: () => ["時刻不明の小児加算"],
    chief: () => "保護者から発熱、咳、食事量低下について相談。水分摂取、尿量、けいれん歴を確認した。",
    objective: () => "咽頭発赤、鼻汁、呼吸状態を確認。乳幼児年齢だが、受付時刻と休日/時間外条件の確認が必要。",
    assessment: () => "小児の急性疾患。加算候補はあるが、時間帯と施設体制の確認が必要。",
    plan: () => "解熱後の登園目安、水分摂取、救急受診の目安を保護者へ説明した。"
  },
  emergency_time_addons: {
    title: "救急時間外確認",
    diagnoses: () => ["急性腹症疑い"],
    targets: () => [{ name: "時間外/休日/救急加算", type: "emergency_candidate" }],
    reviewTopics: () => ["救急加算確認", "受付時刻確認"],
    forbidden: () => ["時刻不明の救急加算"],
    chief: () => "急な症状で受診。発症時刻、救急搬送の有無、来院経路、重症感を確認した。",
    objective: () => "バイタルと身体所見を確認。救急・時間外の記載はあるが、受付時刻と算定条件が不足している。",
    assessment: () => "救急加算候補だが、時刻、搬送、診療体制の確認が必要。",
    plan: () => "緊急時の再受診、検査結果説明、専門科紹介の可能性を説明した。"
  },
  homecare: {
    title: "在宅医療確認",
    diagnoses: () => ["慢性心不全"],
    targets: () => [{ name: "在宅医療関連管理料", type: "unsupported_candidate" }],
    reviewTopics: () => ["在宅医療未対応", "訪問診療確認"],
    forbidden: () => ["訪問診療料の自動確定", "在宅医療関連管理料の自動確定"],
    chief: () => "通院困難のため自宅で診療。家族から息切れ、食事量、介護負担について相談があった。",
    objective: () => "自宅でバイタル、浮腫、呼吸状態、服薬状況、家族支援を確認。在宅医療領域として要レビュー。",
    assessment: () => "在宅管理継続中。現行算定では自動確定せず、在宅医療として確認する。",
    plan: () => "体重測定、増悪時連絡、薬剤調整、次回訪問予定を説明した。"
  },
  rehab: {
    title: "リハビリ確認",
    diagnoses: () => ["脳梗塞後遺症"],
    targets: () => [{ name: "リハビリテーション料", type: "unsupported_candidate" }],
    reviewTopics: () => ["リハビリ未対応", "実施単位確認"],
    forbidden: () => ["リハビリテーション料の自動確定"],
    chief: () => "歩行能力低下と日常生活動作の不安を相談。自宅環境、転倒歴、介助量を確認した。",
    objective: () => "関節可動域、筋力、歩行、バランスを確認し訓練を行った。実施単位や疾患別区分は要確認。",
    assessment: () => "リハビリ領域は現行では確定算定せず、実施単位と施設基準を確認する。",
    plan: () => "自主訓練、転倒予防、次回訓練内容を説明した。"
  },
  psychiatry: {
    title: "精神科専門療法確認",
    diagnoses: () => ["うつ病"],
    targets: () => [{ name: "精神科専門療法", type: "unsupported_candidate" }],
    reviewTopics: () => ["精神科専門療法未対応", "面接時間確認"],
    forbidden: () => ["精神科専門療法の自動確定"],
    chief: () => "気分の落ち込み、不眠、食欲低下、仕事への影響について相談。希死念慮の有無も確認した。",
    objective: () => "表情、応答、睡眠状況、服薬状況、生活リズムを確認。面接時間と療法区分は要確認。",
    assessment: () => "精神科専門療法領域は現行では確定算定せず、面接内容と時間を確認する。",
    plan: () => "服薬継続、生活リズム調整、悪化時の連絡先、次回面接予定を説明した。"
  },
  surgery: {
    title: "手術確認",
    diagnoses: () => ["皮膚腫瘍"],
    targets: () => [{ name: "手術料", type: "surgery_candidate" }],
    reviewTopics: () => ["手術未対応", "手技内容確認"],
    forbidden: () => ["手術料の自動確定", "処置だけで確定"],
    chief: () => "腫瘤の増大、疼痛、出血、整容面の不安を相談。手術説明と同意状況を確認した。",
    objective: () => "病変部位、サイズ、局所所見、手技内容、麻酔使用、標本提出の有無を記録した。",
    assessment: () => "手術領域は現行では確定算定せず、術式、部位、病理提出、麻酔の扱いを確認する。",
    plan: () => "創部管理、出血時対応、抜糸予定、病理結果説明の予定を伝えた。"
  },
  anesthesia: {
    title: "麻酔確認",
    diagnoses: () => ["処置時疼痛"],
    targets: () => [{ name: "麻酔料", type: "anesthesia_candidate" }],
    reviewTopics: () => ["麻酔未対応", "薬剤量確認"],
    forbidden: () => ["麻酔料の自動確定"],
    chief: () => "処置時疼痛への不安が強く、鎮静や麻酔について相談した。",
    objective: () => "麻酔方法、薬剤、量、監視、処置との関係を記録したが、算定区分は要確認。",
    assessment: () => "麻酔領域は現行では確定算定せず、方法と薬剤量を確認する。",
    plan: () => "処置後の注意、帰宅基準、眠気や呼吸状態の変化について説明した。"
  },
  pathology: {
    title: "病理診断確認",
    diagnoses: () => ["腫瘍疑い"],
    targets: () => [{ name: "病理診断/細胞診", type: "pathology_candidate" }],
    reviewTopics: () => ["病理未対応", "検体提出確認"],
    forbidden: () => ["病理診断の自動確定"],
    chief: () => "腫瘤や検査異常について相談。悪性疾患への不安、既往歴、家族歴を確認した。",
    objective: () => "検体採取、提出先、標本種類、結果説明予定を記録。病理領域として要レビュー。",
    assessment: () => "病理診断は現行では確定算定せず、検体種別と診断区分を確認する。",
    plan: () => "結果説明日、追加検査、専門科紹介の可能性を説明した。"
  },
  radiation_therapy: {
    title: "放射線治療確認",
    diagnoses: () => ["悪性腫瘍"],
    targets: () => [{ name: "放射線治療料", type: "unsupported_candidate" }],
    reviewTopics: () => ["放射線治療未対応", "照射条件確認"],
    forbidden: () => ["放射線治療料の自動確定"],
    chief: () => "治療計画、照射回数、副作用への不安を相談。既往治療と併用療法を確認した。",
    objective: () => "照射部位、線量、回数、治療計画の記載があるが、放射線治療領域として要レビュー。",
    assessment: () => "放射線治療は現行では確定算定せず、治療計画と照射条件を確認する。",
    plan: () => "副作用、皮膚ケア、次回照射予定、緊急時連絡を説明した。"
  },
  dialysis_transfusion: {
    title: "透析輸血確認",
    diagnoses: () => ["慢性腎不全"],
    targets: () => [{ name: "人工腎臓/輸血", type: "unsupported_candidate" }],
    reviewTopics: () => ["透析未対応", "輸血未対応"],
    forbidden: () => ["人工腎臓の自動確定", "輸血の自動確定"],
    chief: () => "倦怠感、浮腫、透析中の症状、輸血歴や副作用歴を確認した。",
    objective: () => "透析条件または輸血の記載があるが、実施時間、材料、薬剤、施設条件が不足している。",
    assessment: () => "透析・輸血領域は現行では確定算定せず、詳細条件を確認する。",
    plan: () => "食事、水分、シャント管理、発熱や息切れ時の受診目安を説明した。"
  },
  endoscopy: {
    title: "内視鏡確認",
    diagnoses: () => ["胃炎疑い"],
    targets: () => [{ name: "内視鏡検査", type: "unsupported_candidate" }],
    reviewTopics: () => ["内視鏡未対応", "生検有無確認"],
    forbidden: () => ["内視鏡検査の自動確定"],
    chief: () => "心窩部痛、黒色便の有無、食欲、体重変化、検査への不安を確認した。",
    objective: () => "内視鏡実施の記載があるが、部位、生検、鎮静、病理提出の扱いを確認する必要がある。",
    assessment: () => "内視鏡領域は現行では確定算定せず、検査内容と付随手技を確認する。",
    plan: () => "結果説明、食事再開、出血時対応、生検結果の確認予定を説明した。"
  },
  safety_negation: {
    title: "否定文安全確認",
    diagnoses: () => ["経過観察"],
    targets: () => [{ name: "予定/過去/未実施項目", type: "not_performed" }],
    reviewTopics: () => ["未実施検査除外", "過去検査除外"],
    forbidden: () => ["予定検査", "前回検査", "他院実施", "家族歴"],
    chief: () => "患者は検査や処置を相談したが、本日の実施内容、前回結果、次回予定を分けて確認した。",
    objective: () => "本日は診察と説明のみ。前回検査結果、他院資料、次回予定が本文に含まれるが当日実施ではない。",
    assessment: () => "予定、過去、他院、家族歴を当日の算定候補にしないことが重要。",
    plan: () => "必要時は次回実施を検討するが、本日は未実施として説明した。"
  },
  split_multi_day: {
    title: "複数日記録分割確認",
    diagnoses: () => ["経過観察"],
    targets: () => [{ name: "複数日診療", type: "split_required" }],
    reviewTopics: () => ["複数日記録分割"],
    forbidden: () => ["全日分を1日で合算"],
    chief: () => "数日分の経過と受診内容が同じ記録に含まれるため、日付ごとに整理した。",
    objective: () => "初診日、検査日、結果説明日が混在。各日に実施した内容を分けて確認する必要がある。",
    assessment: () => "複数日記録を一つの診療日にまとめると過剰算定になる可能性がある。",
    plan: () => "日付ごとに診療内容を分割し、当日分のみを確認する。"
  },
  dpc_inpatient: {
    title: "DPC入院確認",
    diagnoses: () => ["肺炎"],
    targets: () => [{ name: "DPCレビュー", type: "dpc_candidate" }],
    reviewTopics: () => ["DPC確認", "出来高分離確認"],
    forbidden: () => ["DPC文脈での急性期一般入院料出来高確定", "DPC本算定の自動確定"],
    chief: () => "入院中の経過、食事量、呼吸状態、退院希望、家族支援を確認した。",
    objective: () => "DPC対象病院で管理中。処置や投薬の記載があるが、DPCと出来高の分離は要確認。",
    assessment: () => "DPC入院は現行では確定算定せず、レビューとして扱う。",
    plan: () => "病棟管理継続、退院調整、DPC確認、出来高算定項目の確認を行う。"
  },
  inpatient_basic: {
    title: "出来高入院基本料確認",
    diagnoses: () => ["肺炎"],
    targets: () => [{ name: "急性期一般入院料1", type: "inpatient_basic_fee" }],
    reviewTopics: () => ["入院日数確認", "病棟区分確認", "施設基準確認"],
    forbidden: () => ["DPC包括請求", "病棟区分未確認の入院料"],
    chief: () => "入院中の経過、呼吸状態、食事量、発熱推移、退院希望、家族支援を確認した。",
    objective: () => "急性期一般病棟で管理中。入院日数、病棟区分、施設基準、DPC対象ではない出来高入院料として扱う根拠を確認した。",
    assessment: () => "出来高入院基本料の確認。DPCレビューとは分け、病棟区分と日数を明示して評価する。",
    plan: () => "病棟管理継続、退院調整、入院料区分と日数確認、同日出来高項目の確認を行う。"
  },
  inpatient_variants: {
    title: "入院料種別確認",
    diagnoses: (i) => [pick(["肺炎", "脳梗塞後遺症", "統合失調症", "廃用症候群"], i)],
    targets: (i) => [{ name: pick(["地域一般入院料", "療養病棟入院基本料", "精神病棟入院基本料", "特定機能病院入院基本料"], i), type: "inpatient_basic_variant_candidate" }],
    reviewTopics: (i) => [pick(["入院料種別確認", "病棟区分確認", "DPC対象確認", "入院日数確認"], i)],
    forbidden: () => ["病棟区分未確認の入院料", "DPC文脈での出来高入院料確定"],
    chief: () => "入院中の症状推移、ADL、退院支援、家族の希望、病棟での管理方針を確認した。",
    objective: () => "入院病棟、病棟区分、包括評価の有無、施設基準、入院日数、転棟の有無を確認する必要がある。",
    assessment: () => "急性期一般以外の入院料種別を含む確認ケース。現行では自動確定せず、病棟区分と包括/出来高の扱いを確認する。",
    plan: () => "病棟区分、施設基準、入院日数、DPC対象有無を確認し、必要なら医療事務レビューへ回す。"
  },
  facility_standards: {
    title: "施設基準確認",
    diagnoses: () => ["検査管理確認"],
    targets: () => [{ name: "施設基準が必要な加算", type: "facility_based_candidate" }],
    reviewTopics: () => ["施設基準確認", "届出確認"],
    forbidden: () => ["施設基準未確認加算の自動確定"],
    chief: () => "検査または画像の管理体制について説明を受け、施設基準に関わる項目を確認した。",
    objective: () => "検査・画像管理の記載があるが、地方厚生局への届出有無が未確認。",
    assessment: () => "施設基準が必要な加算は自動確定せず、届出状況を確認する。",
    plan: () => "施設管理情報を確認し、条件を満たす場合のみ候補化する。"
  },
  materials: {
    title: "特定器材確認",
    diagnoses: () => ["処置後管理"],
    targets: () => [{ name: "特定器材/材料", type: "unsupported_candidate" }],
    reviewTopics: () => ["材料確認", "数量確認"],
    forbidden: () => ["材料料の自動確定"],
    chief: () => "処置に使った材料、交換頻度、持ち帰りの有無を確認した。",
    objective: () => "材料使用の記載はあるが、品目、数量、規格が不足している。",
    assessment: () => "特定器材・材料は現行では確定算定せず、品目と数量を確認する。",
    plan: () => "材料名、規格、数量を確認してから扱う。"
  }
};

function expectedExtractionForExact(item, scenario) {
  const targets = item.billingTargets || [];
  const candidateCodes = (item.expectedCalculation?.candidateCodes || [])
    .map(String)
    .filter((code) => !["111000110", "112007410", "160062110", "160061710", "160060810"].includes(code));
  return {
    requiredDiagnoses: scenario.diagnoses,
    requiredProcedureCandidates: candidateCodes,
    requiredReviewTopics: scenario.reviewTopics,
    forbiddenCandidates: normalizeForbiddenCandidates(scenario.forbidden),
    requiredBillingSignals: targets.map((target) => target.name).filter(Boolean),
    signalExpectations: signalExpectations(targets.map((target) => target.name).filter(Boolean), scenario.domain)
  };
}

function signalExpectations(labels, domain) {
  const imageLike = /CT|ＣＴ|単純撮影|写真診断|デジタル撮影|MRI|画像|超音波|エコー/u;
  const derivedLike = /初診料|再診料|判断料|管理料|加算|入院基本料|DPC/u;
  const literalInChart = [];
  const derivedFromContext = [];
  for (const label of labels) {
    const entry = signalExpectationEntry(label, imageLike.test(label) || derivedLike.test(label) ? "derivedFromContext" : "literalInChart");
    if (entry.source === "literalInChart" && domain !== "imaging") {
      literalInChart.push(entry);
    } else {
      derivedFromContext.push({ ...entry, source: "derivedFromContext" });
    }
  }
  return {
    literalInChart,
    derivedFromContext,
    matchPolicy: "本文の逐語出現ではなく、抽出器の正規化済み候補に対して照合する。"
  };
}

function signalExpectationEntry(label, source) {
  return {
    label,
    matchPolicy: "normalized_candidate_match",
    normalizationHints: ["全角半角", "括弧", "スペース", "単位表記", "診療行為名の同義語"],
    source,
    reason: source === "literalInChart"
      ? "SOAP本文中の実施・処方・処置記載を、表記ゆれを正規化して候補化する。"
      : "患者属性、診療区分、施設基準、実施文脈から導出する。"
  };
}

function buildSoap({ scenario, patient, encounter, assertionLevel }) {
  const sex = sexLabel(patient.sex);
  const dept = departmentLabel(encounter.department);
  const setting = settingLabel(encounter.setting);
  const visit = visitLabel(encounter.visitType);
  const targetNames = scenario.targets.map((target) => target.name).join("、") || "確認項目";
  const reviewTopics = scenario.reviewTopics.join("、") || "確認事項";
  const caution = scenario.forbidden.join("、") || "過剰な確定";
  const commonS = [
    `${patient.age}歳${sex}。${dept}で${setting}の${visit}として診療。${scenario.chief}`,
    "症状の始まり、経過、生活への影響、既往歴、薬剤アレルギー、現在の服薬、患者または家族が心配している点を確認した。",
    "食事量、水分摂取、睡眠、仕事や学校生活への影響、前回受診からの変化、自宅で行った対応を確認した。",
    "本人の困りごとだけでなく、付き添い者の観察、服薬できなかった理由、受診が遅れた理由、費用や通院頻度への不安も聞き取った。"
  ];
  const commonO = [
    `${scenario.objective}`,
    `当日確認した主な診療内容は「${targetNames}」。実施済み、予定、過去結果、他院情報、説明のみの内容を分けて記録した。`,
    "バイタル、意識状態、呼吸状態、関連する身体所見、陰性所見を確認し、診療内容の根拠になる所見を残した。",
    "部位、左右、面積、検体、薬剤量、日数、実施時刻、画像や材料の有無など、会計時に確認されやすい情報は分かる範囲で具体的に記録した。"
  ];
  const commonA = [
    `${scenario.assessment}`,
    `${scenario.diagnoses.join("、")}を中心に評価。点数に直結する名称だけでなく、なぜその検査・処置・処方・管理が必要だったかを医学的文脈として記録した。`,
    `確認すべき論点は「${reviewTopics}」。慎重に扱うべき内容は「${caution}」。`,
    "確定できる内容、条件付きで候補にできる内容、現時点では見送る内容を分け、過剰な請求候補にならないように判断した。"
  ];
  const commonP = [
    `${scenario.plan}`,
    "患者または家族に、治療方針、薬の使い方、検査結果の見方、悪化時の対応、再診目安を具体的に説明した。",
    "診療録だけで確定できない条件は、施設情報、同月履歴、実施単位、部位、数量、日数を追加確認してから扱う。",
    "会計前に当日実施した内容と説明のみの内容を分け、患者負担に影響する項目は根拠を確認してから反映する。",
    "次回までに確認する情報、今回の診療だけで完結する情報、医療事務へ確認を依頼する情報を分けて申し送りできるようにした。"
  ];
  if (assertionLevel === "exact") {
    commonA[2] = `確認すべき論点は「${reviewTopics}」。当日実施と予定・過去結果を分け、過剰な候補化を避ける。`;
  }
  return {
    S: commonS,
    O: commonO,
    A: commonA,
    P: commonP
  };
}

function standardNote(soap) {
  return ["S", "O", "A", "P"].map((key) => `${key}: ${(soap[key] || []).join(" ")}`).join("\n");
}

function unsupportedEvidence(name) {
  return {
    type: "unsupported_policy",
    source: "halunasu fee calculation test policy",
    masterVersion: "2026-05-01",
    name,
    verifiedBy: "codex",
    verifiedAt,
    verificationMethod: "case intentionally represents review-only or unsupported behavior"
  };
}

function sourceReviewPolicy(assertionLevel, ciEligible) {
  return {
    officeReviewed: false,
    officeReviewRequired: true,
    calculationAssertion: assertionLevel,
    ciEligible,
    productionGoldAllowed: false,
    notes: ciEligible
      ? "現行マスターと既存検証済みclaim contextを再利用。医療事務レビュー前。"
      : "医療事務レビュー前。抽出品質、安全性、未対応領域確認用の草案。"
  };
}

function reviewPolicy(assertionLevel, ciEligible) {
  return {
    officeReviewed: false,
    officeReviewRequired: true,
    calculationAssertion: `soap_to_claim_context_then_${assertionLevel}`,
    ciEligible,
    productionGoldAllowed: false,
    notes: "SOAP本文からexpectedExtraction相当を確認し、expectedClaimContext/expectedCalculationに接続するE2E用データ。医療事務レビュー前。"
  };
}

function qualityLabelFor(assertionLevel) {
  if (assertionLevel === "unsupported_expected") return "unsupported_expected";
  if (assertionLevel === "safety" || assertionLevel === "split_required") return "regression_only";
  return "needs_office_review";
}

function patientFor(department, index) {
  const pediatric = department === "pediatrics";
  const elderly = ["homecare", "nephrology_dialysis", "cardiology", "rehabilitation"].includes(department);
  const age = pediatric ? pick([2, 4, 5, 8, 12], index) : elderly ? pick([68, 72, 79, 84], index) : pick([28, 35, 42, 51, 63], index);
  return {
    age,
    sex: pick(["female", "male"], index)
  };
}

function settingFor(department, domain) {
  if (department === "homecare" || domain === "homecare") return "home_visit";
  if (["dpc_inpatient", "inpatient_basic", "inpatient_variants"].includes(domain)) return "inpatient";
  return "outpatient";
}

function visitTypeFor(index) {
  return pick(["initial", "revisit", "revisit", "unknown"], index);
}

function serviceDateFor(offset) {
  const day = ((offset - 1) % 24) + 1;
  return `2026-07-${String(day).padStart(2, "0")}`;
}

function departmentLabel(value) {
  return {
    internal_medicine: "総合内科",
    pediatrics: "小児科",
    dermatology: "皮膚科",
    otolaryngology: "耳鼻咽喉科",
    ophthalmology: "眼科",
    orthopedics: "整形外科",
    surgery: "外科",
    psychiatry: "精神科",
    rehabilitation: "リハビリテーション科",
    obgyn: "産婦人科",
    urology: "泌尿器科",
    cardiology: "循環器内科",
    gastroenterology: "消化器内科",
    respiratory: "呼吸器内科",
    neurology: "脳神経内科",
    emergency: "救急",
    nephrology_dialysis: "腎臓内科",
    homecare: "在宅医療",
    radiology: "放射線科",
    pathology: "病理診断"
  }[value] || value;
}

function settingLabel(value) {
  return {
    outpatient: "外来",
    inpatient: "入院",
    home_visit: "在宅"
  }[value] || value;
}

function visitLabel(value) {
  return {
    initial: "初診",
    revisit: "再診",
    unknown: "初診/再診確認が必要な受診"
  }[value] || value;
}

function sexLabel(value) {
  return value === "male" ? "男性" : value === "female" ? "女性" : "性別不詳";
}

function pick(values, index) {
  return values[index % values.length];
}

function pad(value) {
  return String(value).padStart(3, "0");
}

function countBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = String(fn(item) || "(missing)");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeCaseForbiddenCandidates(item) {
  const clone = structuredClone(item);
  if (clone.expectedExtraction) {
    clone.expectedExtraction.forbiddenCandidates = normalizeForbiddenCandidates(clone.expectedExtraction.forbiddenCandidates || []);
  }
  if (clone.chart?.soap) {
    clone.chart.soap = Object.fromEntries(
      Object.entries(clone.chart.soap).map(([section, rows]) => [
        section,
        Array.isArray(rows) ? rows.map((row) => normalizeForbiddenText(String(row))) : rows
      ])
    );
    clone.chart.standard = standardNote(clone.chart.soap);
  }
  return clone;
}

function normalizeForbiddenCandidates(values) {
  return [...new Set((values || []).map((value) => normalizeForbiddenCandidate(value)).filter(Boolean))];
}

function normalizeForbiddenCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutFacility = raw.match(/^(.+?)\s+confirmed without facility context$/i);
  if (withoutFacility) {
    return `${normalizeForbiddenLabel(withoutFacility[1])}の施設基準未確認`;
  }
  const confirmed = raw.match(/^(.+?)\s+confirmed$/i);
  if (confirmed) {
    const label = normalizeForbiddenLabel(confirmed[1]);
    const specific = {
      処置: "条件未確認の処置",
      管理料: "条件未確認の管理料",
      再診料: "在宅または入院文脈での再診料自動確定",
      急性期一般入院料: "DPC文脈での急性期一般入院料出来高確定",
      DPC: "DPC本算定の自動確定"
    }[label];
    return specific || `${label}の自動確定`;
  }
  return raw;
}

function normalizeForbiddenLabel(value) {
  const label = String(value || "").trim();
  if (/^\d{6,}$/.test(label)) return `コード${label}`;
  return label;
}

function normalizeForbiddenText(value) {
  return String(value || "")
    .replace(/([^\s、。]+)\s+confirmed without facility context/gi, (_, label) => `${normalizeForbiddenLabel(label)}の施設基準未確認`)
    .replace(/([^\s、。]+)\s+confirmed/gi, (_, label) => normalizeForbiddenCandidate(`${label} confirmed`));
}

main();
