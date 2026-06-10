import crypto from "node:crypto";

const AGE_BANDS = [
  ["infant", (age) => age < 6],
  ["child", (age) => age < 15],
  ["young_adult", (age) => age < 40],
  ["adult", (age) => age < 65],
  ["elderly_65", (age) => age < 75],
  ["elderly_75", () => true]
];

const CLINICAL_VARIANTS = [
  {
    key: "family_supplemented_history",
    s: "本人の訴えに加えて同席家族から経過を確認し、日常生活への影響も聴取した。",
    o: "診察時は会話可能で、当日の診察所見と家族からの補足情報を分けて記録した。",
    a: "主病態の評価に加え、生活背景による受診判断への影響を確認する。",
    p: "説明内容は本人と家族の双方に伝え、当日実施した内容と今後の予定を区別した。"
  },
  {
    key: "patient_brought_symptom_memo",
    s: "患者は症状の推移をメモにして持参し、発症時期、悪化因子、改善因子を順に説明した。",
    o: "持参メモは参考情報として扱い、当日診察で確認した所見と混在しないように記録した。",
    a: "時系列の情報は明確だが、算定対象は当日の診療行為に限定して確認する。",
    p: "次回までの観察項目を整理し、予定事項と当日実施事項を分けて説明した。"
  },
  {
    key: "work_or_school_impact",
    s: "症状により仕事または学校生活への影響があり、休養や復帰時期について相談があった。",
    o: "全身状態は安定しており、生活への影響は問診情報として記録した。",
    a: "医学的評価に加え、生活上の制限と復帰目安の説明が必要な状態。",
    p: "復帰目安、悪化時の受診、予定される確認事項を文書化して説明した。"
  },
  {
    key: "self_care_reviewed",
    s: "自宅で行ったセルフケア、服薬状況、受診までの対応について具体的に確認した。",
    o: "セルフケアの内容は患者申告として記録し、当院で当日実施した行為とは区別した。",
    a: "自己管理内容を踏まえて当日の診療内容を評価する必要がある。",
    p: "自宅管理の継続可否、受診目安、予定事項を説明し、当日算定対象外の行為は分けて扱う。"
  },
  {
    key: "medication_allergy_checked",
    s: "薬剤アレルギー、過去の副作用、現在の内服薬を確認し、処方や処置の安全性を確認した。",
    o: "アレルギー確認は安全確認として記録し、薬剤の新規処方や投与とは区別した。",
    a: "安全確認を行ったうえで、当日実施した診療行為を評価する。",
    p: "副作用時の対応、連絡方法、今後の予定を説明した。"
  },
  {
    key: "prior_outside_information_separated",
    s: "患者は以前の他院受診内容にも触れたため、当日症状と過去情報を分けて確認した。",
    o: "他院情報は参考資料として扱い、当院で当日実施した検査・処置とは区別して記録した。",
    a: "過去情報を踏まえるが、算定対象は当日の実施内容に限定する。",
    p: "他院情報の扱い、当日の説明、次回確認事項を分けて案内した。"
  },
  {
    key: "caregiver_instruction_needed",
    s: "本人だけでは管理が不安なため、介助者にも症状変化と受診目安の説明を希望した。",
    o: "介助者への説明は診療録上で明確にし、当日実施した医学的行為と分けて記録した。",
    a: "介助者の理解を含めた安全な経過観察が必要な状態。",
    p: "介助者へ観察項目、連絡基準、予定事項を説明した。"
  },
  {
    key: "stable_general_condition",
    s: "症状はあるが、食事・水分摂取や睡眠状況を含めて全身状態を確認した。",
    o: "診察時の全身状態は安定しており、緊急性の高い所見は本文上明確に認めなかった。",
    a: "全身状態を踏まえて当日の診療内容を整理する。",
    p: "症状悪化時の対応と通常の経過観察の目安を説明した。"
  },
  {
    key: "followup_plan_distinguished",
    s: "患者は次回以降の検査や処置の必要性を心配しており、当日実施内容との違いを確認した。",
    o: "今後の予定は計画として記録し、当日実施済みの診療行為とは区別した。",
    a: "予定事項を当日算定候補へ混入させない確認が必要。",
    p: "次回予定、当日実施済み内容、未実施項目を分けて説明した。"
  },
  {
    key: "documentation_clarity_focus",
    s: "症状の訴えが複数あり、主訴、随伴症状、患者の不安を整理して聴取した。",
    o: "記録上、問診、身体所見、説明、予定を分けて記載した。",
    a: "複数情報を整理し、算定対象となる当日実施内容を明確にする必要がある。",
    p: "患者に説明した内容と、今後確認する事項を分けて記録した。"
  },
  {
    key: "chronic_condition_background",
    s: "基礎疾患の通院歴があり、今回症状との関連、服薬継続状況、生活上の変化を確認した。",
    o: "基礎疾患情報は背景として記録し、当日の主たる診療行為とは区別した。",
    a: "背景疾患を踏まえるが、当日実施した診療内容を中心に評価する。",
    p: "基礎疾患の悪化徴候、連絡基準、予定事項を説明した。"
  },
  {
    key: "patient_preference_documented",
    s: "患者は検査や処置への希望と不安を表明し、説明を受けてから方針を決めたいと話した。",
    o: "希望や不安は意思決定支援として記録し、実施済み行為とは区別した。",
    a: "患者希望を踏まえつつ、当日の医学的必要性と実施内容を確認する。",
    p: "説明後の方針、未実施項目、次回確認事項を分けて案内した。"
  }
];

export function decorateDatasetCaseTypes(dataset) {
  const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
  const groups = new Map();
  for (const item of cases) {
    const base = baseCaseTypeSignature(item);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(item);
  }

  for (const [baseSignature, group] of groups.entries()) {
    const sorted = [...group].sort((a, b) => String(a.caseId || "").localeCompare(String(b.caseId || "")));
    sorted.forEach((item, index) => {
      const axes = caseTypeAxes(item, {
        baseSignature,
        duplicateIndex: index,
        duplicateCount: sorted.length
      });
      item.caseTypeAxes = axes;
      item.caseTypeSignature = caseTypeSignature(item, axes);
      applyCaseTypeAxesToChart(item, axes);
    });
  }

  dataset.caseTypePolicy = {
    schemaVersion: "fee-soap-e2e.case-type-policy.v1",
    definition: "caseTypeSignature は、診療区分、患者属性、期待算定/レビュー、安全観点、臨床文脈軸を組み合わせた重複禁止キー。caseId、日付、ランダム文字列だけでは種類として扱わない。",
    requiredUniqueCount: cases.length,
    generatedBy: "scripts/fee_soap_case_type_signature.mjs"
  };

  return dataset;
}

export function caseTypeSignature(item, axes = item.caseTypeAxes || {}) {
  const signatureInput = [
    baseCaseTypeSignature(item),
    `age=${ageBand(item.patient?.age)}`,
    `sex=${normalizeValue(item.patient?.sex || "unknown")}`,
    `presentation=${normalizeValue(axes.presentationContext || "standard")}`,
    `documentation=${normalizeValue(axes.documentationContext || "standard")}`,
    `background=${normalizeValue(axes.patientBackground || "standard")}`,
    `workflow=${normalizeValue(axes.workflowContext || "standard")}`,
    `risk=${normalizeValue(axes.riskContext || "standard")}`
  ].join("|");
  return `fee-soap-e2e.case-type.v1:${sha256(signatureInput).slice(0, 32)}`;
}

export function baseCaseTypeSignature(item) {
  const extraction = item.expectedExtraction || {};
  const calculation = item.expectedCalculation || {};
  const encounter = item.encounter || {};
  const targets = Array.isArray(item.billingTargets) ? item.billingTargets : [];
  return [
    `assertion=${normalizeValue(calculation.assertionLevel)}`,
    `setting=${normalizeValue(encounter.setting)}`,
    `visit=${normalizeValue(encounter.visitType || encounter.visit_type)}`,
    `department=${normalizeValue(encounter.department)}`,
    `engine=${normalizeValue(calculation.engineStatus)}`,
    `total=${calculation.totalPoints ?? ""}`,
    `codes=${normalizeList(calculation.candidateCodes)}`,
    `targets=${normalizeList(targets.map((target) => [
      target.code || "",
      target.name || "",
      target.type || target.source || "",
      target.points ?? ""
    ].join(":")))}`,
    `diagnoses=${normalizeList(extraction.requiredDiagnoses)}`,
    `signals=${normalizeList(extraction.requiredBillingSignals)}`,
    `procedures=${normalizeList(extraction.requiredProcedureCandidates)}`,
    `reviews=${normalizeList(extraction.requiredReviewTopics)}`,
    `forbidden=${normalizeList(extraction.forbiddenCandidates)}`
  ].join("|");
}

export function caseTypeAudit(cases) {
  const signatureMap = new Map();
  const baseMap = new Map();
  for (const item of cases || []) {
    addToMap(signatureMap, item.caseTypeSignature || caseTypeSignature(item), item.caseId);
    addToMap(baseMap, baseCaseTypeSignature(item), item.caseId);
  }
  const duplicateSignatures = duplicateRows(signatureMap);
  const duplicateBaseSignatures = duplicateRows(baseMap);
  return {
    totalCases: (cases || []).length,
    uniqueCaseTypeSignatures: signatureMap.size,
    duplicateCaseTypeSignatureGroups: duplicateSignatures.length,
    duplicateCaseTypeSignatures: duplicateSignatures,
    uniqueBaseSignatures: baseMap.size,
    duplicateBaseSignatureGroups: duplicateBaseSignatures.length,
    duplicateBaseSignatures: duplicateBaseSignatures.slice(0, 25)
  };
}

function caseTypeAxes(item, { baseSignature, duplicateIndex, duplicateCount }) {
  const hash = numericHash(baseSignature);
  const variant = CLINICAL_VARIANTS[(hash + duplicateIndex) % CLINICAL_VARIANTS.length];
  const documentation = [
    "current_visit_only",
    "patient_report_separated",
    "outside_information_separated",
    "planned_items_separated",
    "same_day_findings_explicit",
    "followup_context_explicit"
  ][(hash + duplicateIndex * 3) % 6];
  const background = [
    "no_known_drug_allergy",
    "medication_history_reviewed",
    "caregiver_support_present",
    "work_school_impact_present",
    "self_care_reviewed",
    "chronic_condition_background"
  ][(hash + duplicateIndex * 5) % 6];
  const workflow = [
    "explanation_given",
    "return_precautions_given",
    "next_visit_plan_separated",
    "shared_decision_documented",
    "home_observation_plan",
    "records_reviewed_without_same_day_billing"
  ][(hash + duplicateIndex * 7) % 6];
  const risk = [
    "stable_general_condition",
    "worsening_signs_explained",
    "no_emergency_red_flags",
    "safety_netting_documented",
    "monitoring_points_defined",
    "billing_scope_guarded"
  ][(hash + duplicateIndex * 11) % 6];

  return {
    duplicateGroupSize: duplicateCount,
    duplicateIndex: duplicateIndex + 1,
    baseSignatureHash: sha256(baseSignature).slice(0, 12),
    presentationContext: variant.key,
    documentationContext: documentation,
    patientBackground: background,
    workflowContext: workflow,
    riskContext: risk,
    ageBand: ageBand(item.patient?.age),
    sex: normalizeValue(item.patient?.sex || "unknown")
  };
}

function applyCaseTypeAxesToChart(item, axes) {
  const soap = item.chart?.soap;
  if (!soap || typeof soap !== "object") return;
  const variant = CLINICAL_VARIANTS.find((entry) => entry.key === axes.presentationContext) || CLINICAL_VARIANTS[0];
  const additions = {
    S: variant.s,
    O: variant.o,
    A: variant.a,
    P: variant.p
  };
  for (const section of ["S", "O", "A", "P"]) {
    const rows = Array.isArray(soap[section]) ? soap[section] : [];
    const cleaned = rows.filter((row) => !CLINICAL_VARIANTS.some((variantRow) => (
      row === variantRow.s || row === variantRow.o || row === variantRow.a || row === variantRow.p
    )));
    soap[section] = [...cleaned, additions[section]];
  }
  item.chart.standard = standardNote(soap);
}

function standardNote(soap) {
  return ["S", "O", "A", "P"]
    .map((section) => `${section}（${sectionName(section)}）\n${(soap[section] || []).join("\n")}`)
    .join("\n\n");
}

function sectionName(section) {
  return {
    S: "Subjective：主観的情報",
    O: "Objective：客観的情報",
    A: "Assessment：評価",
    P: "Plan：計画"
  }[section] || section;
}

function ageBand(rawAge) {
  const age = Number(rawAge);
  if (!Number.isFinite(age)) return "unknown";
  for (const [label, predicate] of AGE_BANDS) {
    if (predicate(age)) return label;
  }
  return "unknown";
}

function normalizeList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => normalizeValue(value))
    .filter(Boolean)
    .sort()
    .join("+");
}

function normalizeValue(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[、。，．・]/g, "")
    .trim();
}

function addToMap(map, key, caseId) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(caseId);
}

function duplicateRows(map) {
  return [...map.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([signature, caseIds]) => ({
      signatureHash: sha256(signature).slice(0, 16),
      count: caseIds.length,
      caseIds
    }));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function numericHash(value) {
  return Number.parseInt(sha256(value).slice(0, 8), 16);
}
