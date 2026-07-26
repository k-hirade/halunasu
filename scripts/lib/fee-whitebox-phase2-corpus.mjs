import crypto from "node:crypto";

export const PHASE2_SPECIALTIES = Object.freeze([
  ["internal_medicine", "内科", "慢性疾患の状態は安定している"],
  ["dermatology", "皮膚科", "皮疹の範囲と掻痒感を確認した"],
  ["orthopedics", "整形外科", "疼痛部位と可動域を確認した"],
  ["pediatrics", "小児科", "保護者から経過と全身状態を聴取した"],
  ["otolaryngology", "耳鼻咽喉科", "耳鼻咽喉症状と局所所見を確認した"],
  ["ophthalmology", "眼科", "左右の視覚症状と眼所見を確認した"],
  ["psychiatry", "精神科", "精神症状と生活状況を確認した"],
  ["surgery", "外科", "創部と全身状態を確認した"]
]);

export const PHASE2_ENCOUNTER_SETTINGS = Object.freeze([
  ["outpatient", "本日は外来で診察した"],
  ["home_visit", "本日は計画された定期訪問で診察した"],
  ["house_call", "患者側からの臨時の求めを受けて往診した"],
  ["telephone", "本日は患者本人からの電話相談に対応した"]
]);

export const PHASE2_CONTEXT_GENERATOR_FAMILY =
  "fee-whitebox-context-contrast-v1";
export const PHASE2_HOLDOUT_GENERATOR_FAMILY =
  "fee-whitebox-phase2-holdout-v1";

const IMAGING_EVENTS = Object.freeze([
  {
    text: "胸部単純X線撮影",
    code: "170000410",
    masterName: "単純撮影（イ）の写真診断",
    category: "imaging"
  },
  {
    text: "腹部CT撮影",
    code: "170011810",
    masterName: "ＣＴ撮影（１６列以上６４列未満マルチスライス型機器）",
    category: "imaging"
  },
  {
    text: "頭部MRI撮影",
    code: "170020110",
    masterName: "ＭＲＩ撮影（１．５テスラ以上３テスラ未満の機器）",
    category: "imaging"
  }
]);

const TREATMENT_EVENTS = Object.freeze([
  {
    text: "湿布処置",
    code: "140002210",
    masterName: "消炎鎮痛等処置（湿布処置）",
    category: "treatment"
  },
  {
    text: "器具による温熱療法",
    code: "140040310",
    masterName: "消炎鎮痛等処置（器具等による療法）",
    category: "treatment"
  },
  {
    text: "マッサージ療法",
    code: "140029610",
    masterName: "消炎鎮痛等処置（マッサージ等の手技による療法）",
    category: "treatment"
  }
]);

const CURRENT_TARGETS = Object.freeze({
  outpatient: Object.freeze([
    {
      text: "再診",
      code: "112007410",
      masterName: "再診料",
      category: "outpatient_basic",
      before: "経過観察中の患者を",
      after: "として対面診察した。"
    }
  ]),
  home_visit: Object.freeze([
    {
      text: "定期訪問診療",
      code: "114001110",
      masterName: "在宅患者訪問診療料（１）１（同一建物居住者以外）",
      category: "outpatient_basic",
      before: "患者宅で",
      after: "を実施した。"
    }
  ]),
  house_call: Object.freeze([
    {
      text: "再診",
      code: "112007410",
      masterName: "再診料",
      category: "outpatient_basic",
      before: "当院通院中の",
      after: "患者である。"
    },
    {
      text: "往診",
      code: "114000110",
      masterName: "往診料",
      category: "outpatient_basic",
      before: "患者側から臨時の求めがあり",
      after: "を実施した。"
    }
  ]),
  telephone: Object.freeze([
    {
      text: "電話等再診",
      code: "112007950",
      masterName: "電話等再診料",
      category: "outpatient_basic",
      before: "患者本人からの相談に対し、",
      after: "として治療上必要な指示を行った。"
    }
  ])
});

const GENERATOR_CONTRACT_SHA256 = sha256(JSON.stringify({
  contextFamily: PHASE2_CONTEXT_GENERATOR_FAMILY,
  holdoutFamily: PHASE2_HOLDOUT_GENERATOR_FAMILY,
  imaging: IMAGING_EVENTS,
  treatment: TREATMENT_EVENTS,
  targets: CURRENT_TARGETS
}));

export function buildPhase2ContextContrastCorpus({
  casesPerCell = 3
} = {}) {
  if (!Number.isInteger(casesPerCell) || casesPerCell < 3) {
    throw new Error("casesPerCell must be an integer greater than or equal to 3");
  }
  const cases = [];
  for (const [specialty, specialtyLabel, specialtyFocus] of PHASE2_SPECIALTIES) {
    for (const [encounterSetting, encounterDescription] of PHASE2_ENCOUNTER_SETTINGS) {
      for (let variant = 1; variant <= casesPerCell; variant += 1) {
        cases.push(buildContextContrastCase({
          specialty,
          specialtyLabel,
          specialtyFocus,
          encounterSetting,
          encounterDescription,
          variant
        }));
      }
    }
  }
  const document = {
    schemaVersion: "fee-whitebox-context-contrast-corpus-v1",
    datasetId: "fee-whitebox-context-contrast-v1",
    synthetic: true,
    notGold: true,
    trainingOnly: true,
    generatorContractSha256: GENERATOR_CONTRACT_SHA256,
    cases
  };
  const audit = auditPhase2ContextContrastCorpus(document);
  if (!audit.ok) {
    throw new Error(`phase2 context corpus is invalid: ${audit.errors.join("; ")}`);
  }
  return document;
}

export function buildPhase2HoldoutSupplement() {
  const cases = [];
  for (const [specialty, specialtyLabel, specialtyFocus] of PHASE2_SPECIALTIES) {
    for (const [encounterSetting, encounterDescription] of PHASE2_ENCOUNTER_SETTINGS) {
      cases.push(buildHoldoutSupplementCase({
        specialty,
        specialtyLabel,
        specialtyFocus,
        encounterSetting,
        encounterDescription
      }));
    }
  }
  const document = {
    schemaVersion: "fee-soap-e2e-v2-cases.v2",
    datasetId: "fee-whitebox-phase2-holdout-supplement-v1",
    synthetic: true,
    notGold: true,
    intendedSplit: "holdout",
    generatorContractSha256: GENERATOR_CONTRACT_SHA256,
    cases
  };
  const audit = auditPhase2HoldoutSupplement(document);
  if (!audit.ok) {
    throw new Error(`phase2 holdout supplement is invalid: ${audit.errors.join("; ")}`);
  }
  return document;
}

export function auditPhase2ContextContrastCorpus(document = {}) {
  const errors = [];
  const byCell = createCellMap();
  const caseIds = new Set();
  const templateIds = new Set();
  for (const item of Array.isArray(document.cases) ? document.cases : []) {
    auditCommonCase(item, { errors, caseIds, templateIds });
    if (!["train", "development"].includes(item?.split)) {
      errors.push(`${item?.caseId}: context corpus split must be train or development`);
    }
    if (
      item?.generationProvenance?.source !== "primary_generator"
      || item?.generationProvenance?.generatorFamily !== PHASE2_CONTEXT_GENERATOR_FAMILY
    ) {
      errors.push(`${item?.caseId}: context corpus provenance is invalid`);
    }
    const cell = byCell.get(cellKey(item));
    if (!cell) {
      errors.push(`${item?.caseId}: unsupported matrix cell ${cellKey(item)}`);
      continue;
    }
    cell.caseCount += 1;
    if (item.split === "development") cell.developmentCaseCount += 1;
    for (const span of item.expectedSpans || []) {
      if (span.temporalRelation === "past") cell.pastSpanCount += 1;
      if (span.providerOwnership === "other_provider") {
        cell.otherProviderSpanCount += 1;
      }
      if (span.sourceOrigin === "patient_reported") {
        cell.patientReportedSpanCount += 1;
      }
      if (span.temporalRelation === "same_day_but_unknown") {
        cell.sameDayUnknownSpanCount += 1;
      }
      if (span.category === "imaging") cell.imagingSpanCount += 1;
      if (span.category === "treatment") cell.treatmentSpanCount += 1;
    }
  }
  for (const cell of byCell.values()) {
    if (cell.caseCount < 3) errors.push(`${cell.cell}: requires at least 3 cases`);
    if (cell.developmentCaseCount < 1) {
      errors.push(`${cell.cell}: requires at least 1 development case`);
    }
    for (const field of [
      "pastSpanCount",
      "otherProviderSpanCount",
      "patientReportedSpanCount",
      "sameDayUnknownSpanCount",
      "imagingSpanCount",
      "treatmentSpanCount"
    ]) {
      if (cell[field] < 3) errors.push(`${cell.cell}: ${field} must be at least 3`);
    }
  }
  return {
    ok: errors.length === 0,
    caseCount: Array.isArray(document.cases) ? document.cases.length : 0,
    completeCellCount: [...byCell.values()].filter((cell) => (
      cell.caseCount >= 3
      && cell.developmentCaseCount >= 1
      && cell.pastSpanCount >= 3
      && cell.otherProviderSpanCount >= 3
      && cell.patientReportedSpanCount >= 3
      && cell.sameDayUnknownSpanCount >= 3
      && cell.imagingSpanCount >= 3
      && cell.treatmentSpanCount >= 3
    )).length,
    cellCount: byCell.size,
    coverage: [...byCell.values()],
    errors
  };
}

export function auditPhase2HoldoutSupplement(document = {}) {
  const errors = [];
  const byCell = createCellMap();
  const caseIds = new Set();
  const templateIds = new Set();
  for (const item of Array.isArray(document.cases) ? document.cases : []) {
    auditCommonCase(item, {
      errors,
      caseIds,
      templateIds,
      spansField: "annotationDraftSpans"
    });
    if (item?.split !== "holdout" || item?.annotationStatus !== "pending_review") {
      errors.push(`${item?.caseId}: holdout supplement must remain pending holdout`);
    }
    if (
      item?.generationProvenance?.source !== "separate_generator"
      || item?.generationProvenance?.generatorFamily !== PHASE2_HOLDOUT_GENERATOR_FAMILY
    ) {
      errors.push(`${item?.caseId}: holdout supplement provenance is invalid`);
    }
    const cell = byCell.get(cellKey(item));
    if (!cell) {
      errors.push(`${item?.caseId}: unsupported matrix cell ${cellKey(item)}`);
      continue;
    }
    cell.caseCount += 1;
    cell.reviewedLineCount += clinicalLineCount(
      item.clinicalText || item?.chart?.standard
    );
    cell.reviewedSpanCount += item.annotationDraftSpans?.length || 0;
  }
  for (const cell of byCell.values()) {
    if (cell.caseCount !== 1) {
      errors.push(`${cell.cell}: requires exactly 1 supplemental case`);
    }
    if (cell.reviewedLineCount < 12) {
      errors.push(`${cell.cell}: supplemental case must contain at least 12 lines`);
    }
    if (cell.reviewedSpanCount < 10) {
      errors.push(`${cell.cell}: supplemental case must suggest at least 10 spans`);
    }
  }
  return {
    ok: errors.length === 0,
    caseCount: Array.isArray(document.cases) ? document.cases.length : 0,
    completeCellCount: [...byCell.values()].filter((cell) => (
      cell.caseCount === 1
      && cell.reviewedLineCount >= 12
      && cell.reviewedSpanCount >= 10
    )).length,
    cellCount: byCell.size,
    coverage: [...byCell.values()],
    errors
  };
}

export function auditPhase2PromotionPreparation({
  canonicalDataset = {},
  generatedHoldoutDataset = {},
  supplementDataset = {},
  reviewQueue = {},
  minimumRunsPerCell = 3,
  minimumLinesPerCell = 20,
  minimumSpansPerCell = 10
} = {}) {
  const errors = [];
  const byCell = createCellMap();
  const queueBySourceCaseId = new Map();
  for (const entry of Array.isArray(reviewQueue.queue) ? reviewQueue.queue : []) {
    const sourceCaseId = String(entry?.sourceCaseId || "");
    if (!sourceCaseId || queueBySourceCaseId.has(sourceCaseId)) {
      errors.push(`${sourceCaseId || "(missing)"}: duplicate or missing review queue sourceCaseId`);
      continue;
    }
    if (
      entry?.annotationStatus !== "pending_manual_annotation"
      || Array.isArray(entry?.approvedSpans)
      || entry?.reviewedBy
    ) {
      errors.push(`${sourceCaseId}: phase2 review queue must remain unreviewed`);
    }
    queueBySourceCaseId.set(sourceCaseId, entry);
  }

  for (const item of Array.isArray(canonicalDataset.cases)
    ? canonicalDataset.cases
    : []) {
    if (item?.split !== "holdout" || item?.annotationStatus !== "reviewed") continue;
    addPreparedCase(byCell, item, {
      reviewed: true,
      lineCount: clinicalLineCount(item.clinicalText),
      spanCount: item.expectedSpans?.length || 0,
      errors
    });
  }

  for (const source of [generatedHoldoutDataset, supplementDataset]) {
    for (const item of Array.isArray(source?.cases) ? source.cases : []) {
      const queueEntry = queueBySourceCaseId.get(String(item?.caseId || ""));
      if (!queueEntry) {
        errors.push(`${item?.caseId}: missing from phase2 review queue`);
        continue;
      }
      const suggestionSpans = uniqueSuggestionCount(queueEntry);
      addPreparedCase(byCell, item, {
        reviewed: false,
        lineCount: clinicalLineCount(item?.chart?.standard),
        spanCount: suggestionSpans,
        errors
      });
    }
  }

  const expectedQueueCount = (generatedHoldoutDataset?.cases?.length || 0)
    + (supplementDataset?.cases?.length || 0);
  if (queueBySourceCaseId.size !== expectedQueueCount) {
    errors.push(
      `review queue size ${queueBySourceCaseId.size} does not match pending source count ${expectedQueueCount}`
    );
  }

  const coverage = [...byCell.values()].map((cell) => ({
    ...cell,
    reviewedComplete:
      cell.reviewedCaseCount >= minimumRunsPerCell
      && cell.reviewedLineCount >= minimumLinesPerCell
      && cell.reviewedSpanCount >= minimumSpansPerCell,
    preparedComplete:
      cell.caseCount >= minimumRunsPerCell
      && cell.preparedLineCount >= minimumLinesPerCell
      && cell.preparedSpanCount >= minimumSpansPerCell
  }));
  const preparedCompleteCellCount = coverage.filter(
    (cell) => cell.preparedComplete
  ).length;
  return {
    ok: errors.length === 0 && preparedCompleteCellCount === byCell.size,
    reviewedCompleteCellCount: coverage.filter(
      (cell) => cell.reviewedComplete
    ).length,
    preparedCompleteCellCount,
    cellCount: byCell.size,
    requirements: {
      minimumRunsPerCell,
      minimumLinesPerCell,
      minimumSpansPerCell
    },
    queueCount: queueBySourceCaseId.size,
    coverage,
    errors
  };
}

function buildContextContrastCase({
  specialty,
  specialtyLabel,
  specialtyFocus,
  encounterSetting,
  encounterDescription,
  variant
}) {
  const index = (variant - 1) % 3;
  const patientReported = IMAGING_EVENTS[(index + 1) % 3];
  const pastOwn = IMAGING_EVENTS[index];
  const externalOther = TREATMENT_EVENTS[index];
  const sameDayUnknown = TREATMENT_EVENTS[(index + 1) % 3];
  const content = annotatedText([
    plainLine(`S：${specialtyLabel}の継続診療。${encounterDescription}。`),
    spanLine(
      "患者は昨日、他院で",
      patientReported,
      "を受けたと話した。",
      axes("performed", "past", "patient_reported", "other_provider")
    ),
    plainLine(`O：バイタルは安定。${specialtyFocus}。`),
    spanLine(
      "前回の当院診療では",
      pastOwn,
      "を実施している。",
      axes("performed", "past", "own_clinic_record", "own_clinic")
    ),
    spanLine(
      "紹介元医療機関の診療情報提供書には",
      externalOther,
      "を実施済みと記載されている。",
      axes("performed", "past", "external_document", "other_provider")
    ),
    spanLine(
      "本日の",
      sameDayUnknown,
      "は実施の有無を記録から確認できない。",
      axes("unknown", "same_day_but_unknown", "own_clinic_record", "unknown")
    ),
    plainLine("A：現在の状態は安定しており、記録上不明な行為は算定確定しない。"),
    plainLine("P：過去・他院・患者申告と本日実施した行為を区別して記録する。")
  ]);
  const serial = String(variant).padStart(3, "0");
  return {
    caseId: `phase2-context-${specialty}-${encounterSetting}-${serial}`,
    specialty,
    encounterSetting,
    split: variant === 3 ? "development" : "train",
    templateId: `fee-whitebox-context-contrast-v1:${specialty}:${encounterSetting}:${serial}`,
    synthetic: true,
    annotationStatus: "reviewed",
    generationProvenance: {
      source: "primary_generator",
      generatorFamily: PHASE2_CONTEXT_GENERATOR_FAMILY,
      generatorContractSha256: GENERATOR_CONTRACT_SHA256,
      labelSource: "deterministic_template_contract",
      notIndependentGold: true
    },
    clinicalText: content.clinicalText,
    expectedSpans: content.spans,
    expectedClaimContext: {
      trainingOnly: true,
      encounterSetting,
      notes: "文脈軸の対立例。算定精度のgoldまたはpromotion holdoutには使用しない。"
    }
  };
}

function buildHoldoutSupplementCase({
  specialty,
  specialtyLabel,
  specialtyFocus,
  encounterSetting,
  encounterDescription
}) {
  const lines = [
    plainLine(`S：${specialtyLabel}の評価目的。${encounterDescription}。`),
    ...IMAGING_EVENTS.map((event, index) => spanLine(
      `患者は${index + 1}日前に他院で`,
      event,
      "を受けたと話した。",
      axes("performed", "past", "patient_reported", "other_provider")
    )),
    plainLine(`O：全身状態は安定。${specialtyFocus}。`),
    ...IMAGING_EVENTS.map((event, index) => spanLine(
      `当院の前回${index + 1}回目の診療では`,
      event,
      "を実施している。",
      axes("performed", "past", "own_clinic_record", "own_clinic")
    )),
    ...TREATMENT_EVENTS.map((event) => spanLine(
      "紹介元医療機関の文書には",
      event,
      "を実施済みと記載されている。",
      axes("performed", "past", "external_document", "other_provider")
    )),
    ...TREATMENT_EVENTS.map((event) => spanLine(
      "本日の",
      event,
      "は実施の有無を診療録から確認できない。",
      axes("unknown", "same_day_but_unknown", "own_clinic_record", "unknown")
    )),
    plainLine("A：過去情報と本日の実施事実を分けて確認する必要がある。"),
    ...CURRENT_TARGETS[encounterSetting].map((target, index) => spanLine(
      index === 0 ? `P：${target.before}` : target.before,
      target,
      target.after,
      axes("performed", "current_visit", "own_clinic_record", "own_clinic")
    ))
  ];
  const content = annotatedText(lines);
  const specialtyIndex = PHASE2_SPECIALTIES.findIndex(([id]) => id === specialty);
  const settingIndex = PHASE2_ENCOUNTER_SETTINGS.findIndex(([id]) => id === encounterSetting);
  const day = String(1 + ((specialtyIndex * 4 + settingIndex) % 27)).padStart(2, "0");
  const currentTargets = CURRENT_TARGETS[encounterSetting];
  return {
    caseId: `phase2-holdout-${specialty}-${encounterSetting}-001`,
    caseTypeKey: `fee-whitebox-phase2-holdout-v1:${specialty}:${encounterSetting}:001`,
    specialty,
    encounterSetting,
    split: "holdout",
    synthetic: true,
    annotationStatus: "pending_review",
    encounter: {
      department: specialty,
      setting: encounterSetting,
      serviceDate: `2026-09-${day}`
    },
    chart: {
      standard: content.clinicalText
    },
    expectedClaimContext: expectedClaimContext(encounterSetting, currentTargets),
    billingTargets: currentTargets.map((target) => ({
      code: target.code,
      name: target.masterName,
      source: "medical_procedures"
    })),
    expectedExtraction: {
      requiredBillingSignals: currentTargets.map((target) => target.text)
    },
    annotationDraftSpans: content.spans.map((span) => ({
      ...span,
      status: "suggestion_only"
    })),
    generationProvenance: {
      source: "separate_generator",
      generatorFamily: PHASE2_HOLDOUT_GENERATOR_FAMILY,
      provider: "local_deterministic_template",
      generatorContractSha256: GENERATOR_CONTRACT_SHA256,
      labelsRequireIndependentReview: true
    }
  };
}

function expectedClaimContext(encounterSetting, targets) {
  const procedureCodes = targets.map((target) => target.code);
  if (encounterSetting === "outpatient") {
    return {
      encounter: { is_outpatient: true },
      encounterDetails: { visitKind: "outpatient" },
      outpatient_basic: { fee_kind: "revisit" },
      procedure_codes: procedureCodes
    };
  }
  if (encounterSetting === "home_visit") {
    return {
      encounter: { is_outpatient: true },
      encounterDetails: {
        visitKind: "home_visit",
        sameBuilding: false,
        sameBuildingSource: "user",
        singleBuildingPatientCount: 1
      },
      procedure_codes: procedureCodes
    };
  }
  if (encounterSetting === "house_call") {
    return {
      encounter: { is_outpatient: true },
      encounterDetails: { visitKind: "house_call" },
      outpatient_basic: { fee_kind: "revisit" },
      procedure_codes: procedureCodes
    };
  }
  return {
    encounter: { is_outpatient: true },
    encounterDetails: {
      visitKind: "telephone_revisit",
      telephoneEligibility: {
        establishedPatient: true,
        patientInitiated: true,
        instructionGiven: true,
        scheduledManagement: false
      }
    },
    outpatient_basic: {
      fee_kind: "revisit",
      visit_kind: "telephone_revisit",
      telephone_eligibility: {
        established_patient: true,
        patient_initiated: true,
        instruction_given: true,
        scheduled_management: false
      }
    },
    procedure_codes: procedureCodes
  };
}

function axes(
  actionStatus,
  temporalRelation,
  sourceOrigin,
  providerOwnership
) {
  return {
    actionStatus,
    temporalRelation,
    sourceOrigin,
    providerOwnership,
    standingStatus: "none"
  };
}

function plainLine(text) {
  return { text: String(text) };
}

function spanLine(before, event, after, contextAxes) {
  return {
    before: String(before),
    event,
    after: String(after),
    axes: contextAxes
  };
}

function annotatedText(lines) {
  let clinicalText = "";
  const spans = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) clinicalText += "\n";
    const lineStart = codePointLength(clinicalText);
    if (!line.event) {
      clinicalText += line.text;
      continue;
    }
    const lineText = `${line.before}${line.event.text}${line.after}`;
    const charStart = lineStart + codePointLength(line.before);
    const charEnd = charStart + codePointLength(line.event.text);
    clinicalText += lineText;
    spans.push({
      text: line.event.text,
      charStart,
      charEnd,
      code: line.event.code,
      masterName: line.event.masterName,
      category: line.event.category,
      ...line.axes
    });
  }
  return { clinicalText, spans };
}

function auditCommonCase(item, {
  errors,
  caseIds,
  templateIds,
  spansField = "expectedSpans"
}) {
  const caseId = String(item?.caseId || "");
  const templateId = String(item?.templateId || item?.caseTypeKey || "");
  if (!caseId || caseIds.has(caseId)) errors.push(`${caseId || "(missing)"}: duplicate or missing caseId`);
  caseIds.add(caseId);
  if (!templateId || templateIds.has(templateId)) {
    errors.push(`${caseId}: duplicate or missing template id`);
  }
  templateIds.add(templateId);
  if (item?.synthetic !== true) errors.push(`${caseId}: synthetic must be true`);
  const clinicalText = String(item?.clinicalText || item?.chart?.standard || "");
  if (!clinicalText) errors.push(`${caseId}: clinical text is required`);
  const spans = Array.isArray(item?.[spansField]) ? item[spansField] : [];
  if (!spans.length) errors.push(`${caseId}: ${spansField} must not be empty`);
  const chars = Array.from(clinicalText);
  for (const [spanIndex, span] of spans.entries()) {
    const actual = chars.slice(span.charStart, span.charEnd).join("");
    if (actual !== span.text) {
      errors.push(`${caseId}: ${spansField}[${spanIndex}] offset mismatch`);
    }
  }
}

function createCellMap() {
  return new Map(PHASE2_SPECIALTIES.flatMap(([specialty]) => (
    PHASE2_ENCOUNTER_SETTINGS.map(([encounterSetting]) => {
      const cell = `${specialty}|${encounterSetting}`;
      return [cell, {
        cell,
        specialty,
        encounterSetting,
        caseCount: 0,
        developmentCaseCount: 0,
        pastSpanCount: 0,
        otherProviderSpanCount: 0,
        patientReportedSpanCount: 0,
        sameDayUnknownSpanCount: 0,
        imagingSpanCount: 0,
        treatmentSpanCount: 0,
        reviewedLineCount: 0,
        reviewedSpanCount: 0,
        reviewedCaseCount: 0,
        preparedLineCount: 0,
        preparedSpanCount: 0
      }];
    })
  )));
}

function addPreparedCase(byCell, item, {
  reviewed,
  lineCount,
  spanCount,
  errors
}) {
  const cell = byCell.get(cellKey(item));
  if (!cell) {
    errors.push(`${item?.caseId}: unsupported matrix cell ${cellKey(item)}`);
    return;
  }
  cell.caseCount += 1;
  cell.preparedLineCount += Number(lineCount || 0);
  cell.preparedSpanCount += Number(spanCount || 0);
  if (reviewed) {
    cell.reviewedCaseCount += 1;
    cell.reviewedLineCount += Number(lineCount || 0);
    cell.reviewedSpanCount += Number(spanCount || 0);
  }
}

function uniqueSuggestionCount(entry) {
  const identities = new Set();
  for (const span of [
    ...(Array.isArray(entry?.anchorSuggestions) ? entry.anchorSuggestions : []),
    ...(Array.isArray(entry?.draftSpanSuggestions) ? entry.draftSpanSuggestions : [])
  ]) {
    identities.add(
      `${span?.charStart}|${span?.charEnd}|${span?.text}`
    );
  }
  return identities.size;
}

function cellKey(item) {
  return `${item?.specialty}|${item?.encounterSetting}`;
}

function clinicalLineCount(value) {
  return String(value || "").split(/\r?\n/u).filter((line) => line.trim()).length;
}

function codePointLength(value) {
  return Array.from(String(value || "")).length;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
