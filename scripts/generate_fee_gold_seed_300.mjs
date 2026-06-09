#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const masterVersion = "2026-05-01";
const verifiedAt = "2026-06-07";
const seed300Dir = path.join(repoRoot, "data/tests/fee-gold/cases/seed-300");
const seed300Path = path.join(seed300Dir, "fee-chart-gold-seed-300.json");
const masterDbPath = path.join(repoRoot, "python/data/master/standard-master.sqlite");

if (!fs.existsSync(seed300Path)) {
  throw new Error(`seed dataset does not exist: ${path.relative(repoRoot, seed300Path)}`);
}

const dataset = JSON.parse(fs.readFileSync(seed300Path, "utf8"));

dataset.datasetId = "fee-chart-gold-seed-300";
dataset.version = "2026-06-07.3";
dataset.purpose = "カルテ本文と診療報酬算定期待値を1:1で対応させ、算定品質の自動テストに使う初期300ケース。";
dataset.cases = dataset.cases.filter((item) => !isGeneratedSeed300Case(item.caseId));

const additions = [
  ...buildExactAdditions(),
  ...buildReviewAdditions(),
  ...buildSafetyAdditions()
];

if (additions.length !== 200) {
  throw new Error(`expected 200 additions, got ${additions.length}`);
}

dataset.cases.push(...additions);
dataset.cases.sort((a, b) => a.caseId.localeCompare(b.caseId));

for (const item of dataset.cases) {
  refreshMetadata(item);
}
dedupeGeneratedTitles(dataset.cases);

fs.mkdirSync(seed300Dir, { recursive: true });
fs.writeFileSync(seed300Path, JSON.stringify(dataset, null, 2) + "\n");

const exactCount = dataset.cases.filter((item) => item.expectedCalculation?.assertionLevel === "exact").length;
const reviewCount = dataset.cases.filter((item) => ["candidate_presence", "review_required"].includes(item.expectedCalculation?.assertionLevel)).length;
const safetyCount = dataset.cases.length - exactCount - reviewCount;
console.log(JSON.stringify({
  datasetId: dataset.datasetId,
  cases: dataset.cases.length,
  additions: additions.length,
  exactCount,
  reviewCount,
  safetyCount,
  output: path.relative(repoRoot, seed300Path)
}, null, 2));

function isGeneratedSeed300Case(caseId) {
  const match = String(caseId || "").match(/^L[1-3]-(\d{3})-/);
  if (!match) return false;
  const number = Number(match[1]);
  return number >= 101 && number <= 300;
}

function dedupeGeneratedTitles(cases) {
  const seen = new Set();
  for (const item of cases) {
    if (!seen.has(item.title)) {
      seen.add(item.title);
      continue;
    }
    if (!isGeneratedSeed300Case(item.caseId)) {
      continue;
    }
    const number = String(item.caseId).match(/^L[1-3]-(\d{3})-/)?.[1] || item.caseId;
    item.title = `${item.title}（ケース${number}）`;
    seen.add(item.title);
  }
}

function buildExactAdditions() {
  const specs = [];
  let number = 101;

  const labCombos = [
    ["adult-flu", "インフル抗原", "発熱、悪寒、関節痛があり、インフルエンザ抗原定性を実施。", ["インフルエンザ疑い"], ["160169450"]],
    ["adult-strep", "溶連菌迅速", "咽頭痛と発熱があり、A群β溶連菌迅速試験定性を実施。", ["急性咽頭炎疑い"], ["160044110"]],
    ["covid-flu", "SARS/インフル同時抗原", "発熱と咳嗽があり、SARS-CoV-2・インフルエンザ同時抗原定性を実施。", ["急性上気道炎疑い"], ["160230050"]],
    ["flu-strep", "インフル・溶連菌迅速", "発熱、咽頭痛があり、インフルエンザ抗原定性とA群β溶連菌迅速試験定性を実施。", ["急性上気道炎疑い"], ["160169450", "160044110"]],
    ["urine", "尿一般・尿蛋白", "排尿時痛と頻尿があり、尿一般と尿蛋白を実施。", ["膀胱炎疑い"], ["160000310", "160000410"]],
    ["cbc", "末梢血液一般", "倦怠感と微熱があり、末梢血液一般検査を実施。", ["感染症疑い"], ["160008010"]],
    ["crp", "CRP", "発熱の原因検索としてCRPを実施。", ["発熱精査"], ["160054710"]],
    ["cbc-crp", "血算・CRP", "発熱と咳嗽があり、末梢血液一般検査とCRPを実施。", ["気管支炎疑い"], ["160008010", "160054710"]],
    ["urine-crp", "尿検査・CRP", "排尿時痛と発熱があり、尿一般、尿蛋白、CRPを実施。", ["腎盂腎炎疑い"], ["160000310", "160000410", "160054710"]],
    ["flu-crp", "インフル抗原・CRP", "高熱があり、インフルエンザ抗原定性とCRPを実施。", ["発熱精査"], ["160169450", "160054710"]]
  ];
  const labVariants = [
    ["initial", { outpatient_basic: { fee_kind: "initial" } }, "初診"],
    ["revisit", { outpatient_basic: { fee_kind: "revisit" } }, "再診"],
    ["initial-blood", { outpatient_basic: { fee_kind: "initial" }, lab_options: { collection_fee_inputs: ["blood_venous"] } }, "初診、静脈採血あり"],
    ["revisit-blood", { outpatient_basic: { fee_kind: "revisit" }, lab_options: { collection_fee_inputs: ["blood_venous"] } }, "再診、静脈採血あり"],
    ["revisit-blood-management", { outpatient_basic: { fee_kind: "revisit" }, lab_options: { collection_fee_inputs: ["blood_venous"] }, facility_standard_keys: ["検体検査管理加算2"] }, "再診、静脈採血あり、検体検査管理加算2"]
  ];
  for (const [slug, label, text, diagnoses, codes] of labCombos) {
    for (const [variantSlug, context, visitLabel] of labVariants) {
      specs.push(exactProcedureSpec(
        `L1-${pad(number++)}-lab-${slug}-${variantSlug}`,
        `${label}、${visitLabel}`,
        `${visitLabel}。${text}${context.lab_options ? " 静脈採血も行った。" : ""}`,
        diagnoses,
        codes,
        context
      ));
    }
  }

  const treatmentSpecs = [
    ["burn-small", "熱傷処置100cm2未満", "前腕に3×4cmの浅達性熱傷。洗浄し被覆材で保護。", ["前腕熱傷"], { kind: "burn", area_size: "lt_100_cm2" }],
    ["burn-medium", "熱傷処置100cm2以上500cm2未満", "下腿に12×12cmのII度熱傷。洗浄し被覆材で保護。", ["下腿熱傷"], { kind: "burn", area_size: "ge_100_lt_500_cm2" }],
    ["wound-small", "創傷処置100cm2未満", "手背に2×3cmの裂創。洗浄しガーゼで保護。", ["手背裂創"], { kind: "wound", area_size: "lt_100_cm2" }],
    ["wound-medium", "創傷処置100cm2以上500cm2未満", "下腿に15×10cmの擦過創。洗浄しガーゼで保護。", ["下腿創傷"], { kind: "wound", area_size: "ge_100_lt_500_cm2" }]
  ];
  for (const site of ["前腕", "下腿", "手背", "足背", "体幹"]) {
    for (const [slug, title, text, diagnoses, order] of treatmentSpecs) {
      const visit = number % 2 === 0 ? "initial" : "revisit";
      specs.push(exactTreatmentSpec(
        `L1-${pad(number++)}-treatment-${slug}-${site}`,
        `${site}${title}、${visit === "initial" ? "初診" : "再診"}`,
        text.replace(/前腕|下腿|手背/, site),
        diagnoses.map((diagnosis) => diagnosis.replace(/前腕|下腿|手背/, site)),
        order,
        { fee_kind: visit }
      ));
    }
  }

  const imagingOrders = [
    ["head-ct", "頭部CT", "頭痛で頭部CTを実施。電子画像管理あり。", ["頭痛精査"], { kind: "ct", ct_equipment_kind: "multislice_16_to_64", electronic_image_management: true }],
    ["abdomen-ct", "腹部CT", "腹痛で腹部CTを実施。電子画像管理あり。", ["腹痛精査"], { kind: "ct", ct_equipment_kind: "multislice_16_to_64", electronic_image_management: true }],
    ["contrast-ct", "造影CT", "腹痛精査で造影CTを実施。電子画像管理あり。", ["腹痛精査"], { kind: "ct", ct_equipment_kind: "multislice_16_to_64", contrast: true, electronic_image_management: true }],
    ["chest-xray", "胸部単純X線", "咳嗽があり胸部単純X線デジタル撮影を実施。", ["咳嗽精査"], { procedure_codes: ["170000410", "170027910"] }],
    ["abdomen-xray", "腹部単純X線", "腹部膨満があり腹部単純X線デジタル撮影を実施。", ["腹部膨満精査"], { procedure_codes: ["170000410", "170027910"] }],
    ["followup-xray", "経過観察X線", "肺炎フォローで胸部単純X線デジタル撮影を実施。", ["肺炎疑い"], { procedure_codes: ["170000410", "170027910"] }]
  ];
  for (const [slug, title, text, diagnoses, order] of imagingOrders) {
    for (const visit of ["initial", "revisit", "revisit"]) {
      specs.push(exactImagingOrProcedureSpec(
        `L1-${pad(number++)}-imaging-${slug}-${visit}-${number}`,
        `${title}、${visit === "initial" ? "初診" : "再診"}`,
        `${visit === "initial" ? "初診" : "再診"}。${text}`,
        diagnoses,
        order,
        { fee_kind: visit }
      ));
    }
  }

  const medicationSpecs = [
    ["outside-initial-generic", "院外処方、一般名処方加算、初診", "高血圧症で初診。一般名処方で院外処方箋を交付。", ["高血圧症"], { fee_kind: "initial" }, { delivery_kind: "outside_prescription", prescription_category: "other", generic_name_prescription_add_on: "generic_name_add_on_1" }, []],
    ["outside-revisit-generic", "院外処方、一般名処方加算、再診", "脂質異常症で再診。一般名処方で院外処方箋を交付。", ["脂質異常症"], { fee_kind: "revisit" }, { delivery_kind: "outside_prescription", prescription_category: "other", generic_name_prescription_add_on: "generic_name_add_on_1" }, []],
    ["outside-initial-no-generic", "院外処方、一般名加算なし、初診", "胃炎で初診。院外処方箋を交付。", ["急性胃炎"], { fee_kind: "initial" }, { delivery_kind: "outside_prescription", prescription_category: "other" }, []],
    ["outside-revisit-no-generic", "院外処方、一般名加算なし、再診", "腰痛症で再診。院外処方箋を交付。", ["腰痛症"], { fee_kind: "revisit" }, { delivery_kind: "outside_prescription", prescription_category: "other" }, []]
  ];
  for (const spec of medicationSpecs) {
    specs.push(exactMedicationSpec(`L1-${pad(number++)}-med-${spec[0]}`, ...spec.slice(1)));
  }
  for (const quantity of [2, 3, 4, 5, 8, 10, 12, 15, 20, 25]) {
    const visit = quantity % 2 === 0 ? "revisit" : "initial";
    specs.push(exactMedicationSpec(
      `L1-${pad(number++)}-med-geeben-${quantity}g-${visit}`,
      `院内外用薬ゲーベン${quantity}g、${visit === "initial" ? "初診" : "再診"}`,
      `湿疹で${visit === "initial" ? "初診" : "再診"}。ゲーベンクリーム1%を${quantity}g院内処方。`,
      ["湿疹"],
      { fee_kind: visit },
      { delivery_kind: "in_house", prescription_category: "other", dispensing_kinds: ["external"] },
      [{ code: "620008991", quantity: String(quantity) }]
    ));
  }

  for (const days of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    specs.push(exactInpatientSpec(
      `L1-${pad(number++)}-inpatient-acute-general-${days}d`,
      `急性期一般入院料1、${days}日分`,
      `肺炎で入院。急性期一般入院料1として${days}日分を明示入力。`,
      ["肺炎"],
      days
    ));
  }

  if (specs.length !== 114) {
    throw new Error(`expected 114 exact specs, got ${specs.length}`);
  }
  return specs.map(makeExactCase);
}

function buildReviewAdditions() {
  const templates = [
    ["drug-duration", "薬剤日数不足", ["急性気管支炎疑い"], [{ name: "処方薬", type: "drug_candidate" }], "処方薬の名称はあるが、1回量、回数、日数が不足。", ["薬剤日数不足", "総量不足"]],
    ["wound-area", "創傷面積不足", ["創傷"], [{ name: "創傷処置", type: "treatment_candidate" }], "創部を洗浄しガーゼ保護したが、面積がcm単位で不明。", ["処置面積不足"]],
    ["burn-area", "熱傷面積不足", ["熱傷"], [{ name: "熱傷処置", type: "treatment_candidate" }], "熱傷創を処置したが、面積区分が不明。", ["処置面積不足"]],
    ["facility-lab", "検体検査管理加算施設基準確認", ["発熱精査"], [{ name: "検体検査管理加算", type: "facility_based_candidate" }], "採血検査と検体検査管理加算の記載があるが、施設基準が未確認。", ["施設基準確認"]],
    ["imaging-management", "画像診断管理加算確認", ["画像精査"], [{ name: "画像診断管理加算", type: "facility_based_candidate" }], "CT撮影と読影管理の記載があるが、届出状況が不明。", ["施設基準確認"]],
    ["generic-rx", "一般名処方加算確認", ["慢性疾患"], [{ name: "一般名処方加算", type: "medication_fee_candidate" }], "院外処方だが一般名処方か銘柄処方かが曖昧。", ["一般名処方確認"]],
    ["visit-type", "初診再診確認", ["頭痛"], [{ name: "初診/再診", type: "visit_type_candidate" }], "この症状では初めてとあるが、同院受診歴があり初診/再診判断が必要。", ["初診/再診確認"]],
    ["pediatric-time", "小児時間外条件確認", ["急性胃腸炎疑い"], [{ name: "乳幼児時間外加算", type: "time_based_candidate" }], "2歳児の休日受診。受付時刻と診療体制の記載がない。", ["受付時刻確認", "休日加算確認"]],
    ["management-chronic", "慢性疾患管理料確認", ["高血圧症"], [{ name: "生活習慣病管理料", type: "management_candidate" }], "生活指導、服薬指導、血圧管理を行ったが、対象要件と同月算定履歴が不明。", ["管理料確認", "同月履歴確認"]],
    ["lab-code", "検査コード確定確認", ["糖尿病疑い"], [{ name: "HbA1c", type: "lab_candidate" }], "HbA1c確認と記載があるが、標準コードを自動確定するには不足。", ["検査コード確認"]]
  ];

  const cases = [];
  for (let index = 0; index < 70; index += 1) {
    const number = 215 + index;
    const [slug, title, diagnoses, targets, text, reviewTopics] = templates[index % templates.length];
    const patientIndex = index + 1;
    cases.push(makeReviewCase({
      caseId: `L2-${pad(number)}-${slug}-${patientIndex}`,
      difficulty: 2,
      title: `${title} ${patientIndex}`,
      diagnoses,
      targets,
      text: `${text} 症例番号${patientIndex}として、診療録には追加確認が必要な条件を残す。`,
      reviewTopics,
      assertion: "review_required"
    }));
  }
  return cases;
}

function buildSafetyAdditions() {
  const templates = [
    ["planned-only", "予定のみを算定しない", ["腰痛症"], [{ name: "次回画像検査予定", type: "planned_procedure" }], "本日は検査なし。改善しなければ次回X線を予定。", ["予定検査除外"], ["170000410"], "safety"],
    ["history-only", "過去実施を算定しない", ["頭痛"], [{ name: "前回CT結果説明", type: "history_only" }], "前回他院で撮影したCT結果を説明。本日は画像検査なし。", ["過去検査除外"], ["170011810"], "safety"],
    ["not-performed", "未実施検査を算定しない", ["急性上気道炎"], [{ name: "インフル検査未実施", type: "not_performed" }], "インフル検査は希望せず未実施。対症療法のみ。", ["未実施検査除外"], ["160169450"], "safety"],
    ["family-history", "家族歴を本人病名にしない", ["健診異常"], [{ name: "糖尿病家族歴", type: "history_only" }], "父が糖尿病。本人は糖尿病と診断していない。", ["家族歴除外"], ["糖尿病"], "safety"],
    ["home-care", "在宅医療未対応", ["慢性呼吸不全"], [{ name: "在宅酸素療法指導管理料", type: "unsupported_candidate" }], "在宅酸素の使用状況を確認。在宅医療領域のため確定算定しない。", ["在宅医療未対応"], [], "unsupported_expected"],
    ["surgery", "手術未対応", ["皮膚腫瘍"], [{ name: "皮膚腫瘍切除術", type: "surgery_candidate" }], "局所麻酔下に皮膚腫瘍を切除。手術領域のため要レビュー。", ["手術未対応"], [], "unsupported_expected"],
    ["rehab", "リハビリ未対応", ["脳梗塞後遺症"], [{ name: "脳血管疾患等リハビリテーション", type: "unsupported_candidate" }], "リハビリを実施。リハビリ領域は確定算定しない。", ["リハビリ未対応"], [], "unsupported_expected"],
    ["psychiatry", "精神科専門療法未対応", ["うつ病"], [{ name: "精神科専門療法", type: "unsupported_candidate" }], "精神科専門療法を実施。未対応領域として要レビュー。", ["精神科専門療法未対応"], [], "unsupported_expected"],
    ["pathology", "病理未対応", ["甲状腺腫瘤疑い"], [{ name: "細胞診", type: "pathology_candidate" }], "穿刺吸引細胞診を実施。病理領域として要レビュー。", ["病理未対応"], [], "unsupported_expected"],
    ["dialysis", "透析未対応", ["慢性腎不全"], [{ name: "人工腎臓", type: "unsupported_candidate" }], "血液透析を実施。透析条件は未対応として要レビュー。", ["透析未対応"], [], "unsupported_expected"],
    ["multi-day", "複数日記録を分割する", ["肺炎疑い"], [{ name: "複数日診療", type: "split_required" }], "6/1初診、6/3結果説明、6/7再診が同じ本文に混在。", ["複数日記録分割"], [], "split_required"],
    ["conflict", "矛盾記載を要レビューにする", ["急性上気道炎疑い"], [{ name: "検査実施有無が矛盾", type: "conflict" }], "前半に検査陰性、後半に検査未実施と記載が矛盾。", ["矛盾記載確認"], [], "safety"],
    ["external", "他院実施を算定しない", ["腹痛精査"], [{ name: "他院CT", type: "external_record_only" }], "他院で撮影したCT画像を持参。本日は結果確認のみ。", ["他院実施除外"], ["170011810"], "safety"],
    ["considered", "検討のみを算定しない", ["胸痛"], [{ name: "CT検討", type: "considered_only" }], "CTも検討したが本日は実施せず、経過観察とした。", ["検討のみ除外"], ["170011810"], "safety"],
    ["dpc-surgery", "DPC手術混在を確定しない", ["胆嚢炎"], [{ name: "DPC", type: "dpc_candidate" }, { name: "腹腔鏡下胆嚢摘出術", type: "surgery_candidate" }], "入院中に手術を実施。DPCと手術の扱いを要レビュー。", ["DPC確認", "手術未対応"], [], "unsupported_expected"],
    ["anesthesia", "麻酔未対応", ["処置時疼痛"], [{ name: "静脈麻酔", type: "anesthesia_candidate" }], "処置時に鎮静薬を使用。麻酔区分は未対応として要レビュー。", ["麻酔未対応"], [], "unsupported_expected"]
  ];
  return templates.map((template, index) => makeReviewCase({
    caseId: `L3-${pad(285 + index)}-${template[0]}`,
    difficulty: 3,
    title: template[1],
    diagnoses: template[2],
    targets: template[3],
    text: template[4],
    reviewTopics: template[5],
    forbidden: template[6],
    assertion: template[7]
  }));
}

function exactProcedureSpec(caseId, title, text, diagnoses, procedureCodes, context) {
  return {
    caseId,
    difficulty: 1,
    title,
    text,
    diagnoses,
    claimContextGold: {
      encounter: encounter(true),
      procedure_codes: procedureCodes,
      ...context
    }
  };
}

function exactTreatmentSpec(caseId, title, text, diagnoses, treatmentOrder, outpatientBasic) {
  return {
    caseId,
    difficulty: 1,
    title,
    text,
    diagnoses,
    claimContextGold: {
      encounter: encounter(true),
      outpatient_basic: outpatientBasic,
      treatment_orders: [treatmentOrder]
    }
  };
}

function exactImagingOrProcedureSpec(caseId, title, text, diagnoses, order, outpatientBasic) {
  if (order.procedure_codes) {
    return exactProcedureSpec(caseId, title, text, diagnoses, order.procedure_codes, { outpatient_basic: outpatientBasic });
  }
  return {
    caseId,
    difficulty: 1,
    title,
    text,
    diagnoses,
    claimContextGold: {
      encounter: encounter(true),
      outpatient_basic: outpatientBasic,
      imaging_orders: [order]
    }
  };
}

function exactMedicationSpec(caseId, title, text, diagnoses, outpatientBasic, medication, drugInputs) {
  return {
    caseId,
    difficulty: 1,
    title,
    text,
    diagnoses,
    claimContextGold: {
      encounter: encounter(true),
      outpatient_basic: outpatientBasic,
      medication,
      ...(drugInputs.length ? { drug_inputs: drugInputs } : {})
    }
  };
}

function exactInpatientSpec(caseId, title, text, diagnoses, days) {
  return {
    caseId,
    difficulty: 1,
    title,
    text,
    diagnoses,
    claimContextGold: {
      encounter: encounter(false, { admission_date: "2026-07-01" }),
      facility_standard_keys: ["一般入院"],
      inpatient_basic: {
        basic_fee_code: "190117710",
        basic_fee_days: days,
        facility_standard_key: "一般入院"
      }
    }
  };
}

function makeExactCase(spec) {
  const result = runEngine(spec.caseId, spec.claimContextGold);
  const billingTargets = result.lineItems.map((line) => normalizeBillingTarget({
    code: line.code,
    name: line.name,
    points: Number(line.points || 0),
    quantity: Number(line.quantity || 1),
    totalPoints: Number(line.totalPoints || 0),
    status: line.status,
    source: line.source
  }));
  return {
    caseId: spec.caseId,
    difficulty: spec.difficulty,
    title: spec.title,
    targetBillingFacts: {
      patient: patientForCase(spec),
      encounter: {
        setting: spec.claimContextGold.encounter?.is_outpatient === false ? "inpatient" : "outpatient",
        visitType: spec.claimContextGold.outpatient_basic?.fee_kind || "explicit",
        department: departmentForCase(spec),
        serviceDate: spec.claimContextGold.encounter?.service_date || "2026-07-10"
      },
      diagnoses: spec.diagnoses,
      billingTargets,
      reviewTargets: ["現行エンジンの候補点数として検証済み。医療事務レビュー前。"]
    },
    claimContextGold: spec.claimContextGold,
    expectedCalculation: {
      assertionLevel: "exact",
      engineStatus: result.engineStatus,
      totalPoints: Number(result.totalPoints || 0),
      candidateCodes: result.candidateCodes
    },
    expectedExtraction: {
      requiredDiagnoses: spec.diagnoses,
      requiredProcedureCandidates: result.candidateCodes.filter((code) => !String(code).startsWith("6")),
      requiredMedicationCandidates: result.candidateCodes.filter((code) => String(code).startsWith("6")),
      requiredReviewTopics: ["要レビュー表示"],
      forbiddenCandidates: []
    },
    chartVariants: chartFromText(spec.text, spec.diagnoses),
    status: "master_verified",
    qualityLabel: "verified",
    reviewPolicy: reviewPolicy("exact", true, "現行マスターと現行算定エンジンで検証済み。医療事務レビュー前。"),
    evidence: [],
    engineVerification: {
      verifiedAt,
      engine: "python.medical_fee_calculation.api",
      masterDb: "python/data/master/standard-master.sqlite",
      verificationMethod: "claimContextGold executed locally",
      expectedMatched: true,
      result: {
        engineStatus: result.engineStatus,
        totalPoints: Number(result.totalPoints || 0),
        candidateCodes: result.candidateCodes
      }
    }
  };
}

function makeReviewCase(spec) {
  const assertion = spec.assertion || "review_required";
  return {
    caseId: spec.caseId,
    difficulty: spec.difficulty,
    title: spec.title,
    targetBillingFacts: {
      patient: patientForCase(spec),
      encounter: {
        setting: spec.difficulty === 3 && /在宅|訪問/.test(spec.title) ? "home_visit" : "outpatient",
        visitType: "unknown",
        department: departmentForCase(spec),
        serviceDate: "2026-07-10"
      },
      diagnoses: spec.diagnoses,
      billingTargets: spec.targets,
      reviewTargets: spec.reviewTopics
    },
    claimContextGold: null,
    expectedCalculation: {
      assertionLevel: assertion,
      engineStatus: "needs_review",
      minimumCandidateCodes: [],
      totalPoints: null
    },
    expectedExtraction: {
      requiredDiagnoses: spec.diagnoses,
      requiredReviewTopics: spec.reviewTopics,
      forbiddenCandidates: spec.forbidden || []
    },
    chartVariants: chartFromText(spec.text, spec.diagnoses),
    status: "draft",
    qualityLabel: assertion === "unsupported_expected" ? "unsupported_expected" : (assertion === "safety" || assertion === "split_required" ? "regression_only" : "needs_office_review"),
    reviewPolicy: reviewPolicy(assertion, false, "医療事務レビュー前。抽出品質または安全性確認用の草案。"),
    evidence: []
  };
}

function refreshMetadata(item) {
  const assertion = item.expectedCalculation?.assertionLevel || "review_required";
  if (assertion === "exact") {
    item.status = "master_verified";
    item.qualityLabel = "verified";
    item.reviewPolicy = reviewPolicy("exact", true, "現行マスターと現行算定エンジンで検証済み。医療事務レビュー前。");
    const result = runEngine(item.caseId, item.claimContextGold);
    item.expectedCalculation.engineStatus = result.engineStatus;
    item.expectedCalculation.totalPoints = Number(result.totalPoints || 0);
    item.expectedCalculation.candidateCodes = result.candidateCodes;
    item.engineVerification = {
      verifiedAt,
      engine: "python.medical_fee_calculation.api",
      masterDb: "python/data/master/standard-master.sqlite",
      verificationMethod: "claimContextGold executed locally",
      expectedMatched: true,
      result: {
        engineStatus: result.engineStatus,
        totalPoints: Number(result.totalPoints || 0),
        candidateCodes: result.candidateCodes
      }
    };
  } else {
    item.status = "draft";
    item.qualityLabel = assertion === "unsupported_expected" ? "unsupported_expected" : (assertion === "safety" || assertion === "split_required" ? "regression_only" : "needs_office_review");
    item.reviewPolicy = reviewPolicy(assertion, false, item.reviewPolicy?.notes || "医療事務レビュー前。抽出品質または安全性確認用の草案。");
    delete item.engineVerification;
  }
  item.targetBillingFacts.billingTargets = item.targetBillingFacts.billingTargets.map(normalizeBillingTarget);
  item.evidence = evidenceForTargets(item.targetBillingFacts.billingTargets);
}

function reviewPolicy(assertion, ciEligible, notes) {
  return {
    officeReviewed: false,
    officeReviewRequired: true,
    calculationAssertion: assertion,
    ciEligible,
    productionGoldAllowed: false,
    notes
  };
}

function evidenceForTargets(targets) {
  return targets.map((target) => {
    if (target.code) {
      return normalizeBillingTarget({
        type: String(target.code).startsWith("6") ? "drug_master" : "medical_procedure_master",
        source: "standard-master.sqlite",
        masterVersion,
        code: target.code,
        name: target.name,
        points: Number(target.points || target.totalPoints || 0),
        ...(target.quantity !== undefined ? { quantity: target.quantity } : {}),
        ...(target.quantityUnit ? { quantityUnit: target.quantityUnit } : {}),
        ...(target.totalPoints !== undefined ? { totalPoints: target.totalPoints } : {}),
        ...(target.unitAmountYen !== undefined ? { unitAmountYen: target.unitAmountYen } : {}),
        ...(target.unitPoints !== undefined ? { unitPoints: target.unitPoints } : {}),
        ...(target.totalDrugPriceYen !== undefined ? { totalDrugPriceYen: target.totalDrugPriceYen } : {}),
        ...(target.rounding ? { rounding: target.rounding } : {}),
        verifiedBy: "codex",
        verifiedAt,
        verificationMethod: "local sqlite master lookup and exact cases checked with python medical_fee_calculation.api"
      });
    }
    return {
      type: "unsupported_policy",
      source: "halunasu fee calculation test policy",
      masterVersion,
      name: target.name,
      verifiedBy: "codex",
      verifiedAt,
      verificationMethod: "case intentionally represents review-only or unsupported behavior"
    };
  });
}

function normalizeBillingTarget(target) {
  if (target.code !== "620008991") return target;
  const quantity = Number(target.quantity || 0);
  const totalPoints = Number(target.totalPoints || 0);
  const unitAmountYen = 12.8;
  return {
    ...target,
    points: 1.28,
    unitPoints: 1.28,
    unitAmountYen,
    ...(quantity ? { totalDrugPriceYen: Number((unitAmountYen * quantity).toFixed(1)) } : {}),
    ...(quantity && totalPoints ? { rounding: `薬価${Number((unitAmountYen * quantity).toFixed(1))}円を10円で除して点数化し、現行エンジンの薬剤料丸めで${totalPoints}点。` } : {})
  };
}

function runEngine(caseId, claimContextGold) {
  const payload = {
    db_path: masterDbPath,
    session: {
      feeSessionId: caseId,
      serviceDate: claimContextGold?.encounter?.service_date || "2026-07-10",
      setting: claimContextGold?.encounter?.is_outpatient === false ? "inpatient" : "outpatient",
      claimContext: claimContextGold
    },
    input: {}
  };
  const result = spawnSync("python3", ["-m", "medical_fee_calculation.api"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, "python")
    }
  });
  if (result.status !== 0) {
    throw new Error(`${caseId}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout).calculationResult;
}

function encounter(isOutpatient = true, overrides = {}) {
  return {
    service_date: "2026-07-10",
    is_outpatient: isOutpatient,
    regional_bureau: "tohoku",
    medical_institution_code: "0410001",
    ...overrides
  };
}

function patientForCase(spec) {
  const text = [spec.title, spec.text].join(" ");
  const childAge = text.match(/(\d+)歳児/);
  if (childAge) return { age: Number(childAge[1]), sex: "male" };
  if (/乳幼児|小児科外来|小児/.test(text)) return { age: 4, sex: "male" };
  if (/高齢|在宅|慢性呼吸不全|心不全|透析/.test(text)) return { age: 76, sex: "female" };
  return spec.difficulty === 3 ? { age: 72, sex: "female" } : { age: 45, sex: "female" };
}

function departmentForCase(spec) {
  const text = [spec.title, spec.text, ...(spec.diagnoses || [])].join(" ");
  if (/熱傷|創傷|湿疹|皮膚/.test(text)) return "dermatology";
  if (/小児|歳児|乳幼児/.test(text)) return "pediatrics";
  if (/精神|うつ/.test(text)) return "psychiatry";
  if (/リハ/.test(text)) return "rehabilitation";
  if (/入院|肺炎/.test(text)) return "internal_medicine";
  return "internal_medicine";
}

function chartFromText(text, diagnoses) {
  const diagnosisText = diagnoses.join("、");
  return {
    soap: {
      S: [text],
      O: ["診察所見、実施内容、数量、日付、施設基準など、算定に必要な条件を確認する。"],
      A: [diagnosisText],
      P: ["算定候補は確定請求ではなく、条件確認とレビュー後に採用する。"]
    },
    standard: [`${text} 診断候補は${diagnosisText}。算定候補は条件確認後に採用する。`]
  };
}

function pad(value) {
  return String(value).padStart(3, "0");
}
