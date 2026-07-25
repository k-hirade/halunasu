import crypto from "node:crypto";

const SPECIALTIES = Object.freeze([
  ["internal_medicine", "内科", "慢性疾患または急性症状を簡潔に記載する"],
  ["dermatology", "皮膚科", "皮疹の部位・性状・経過を具体的に記載する"],
  ["orthopedics", "整形外科", "疼痛部位・可動域・移動能力を具体的に記載する"],
  ["pediatrics", "小児科", "保護者からの聴取、年齢、全身状態を記載する"],
  ["otolaryngology", "耳鼻咽喉科", "耳鼻咽喉症状と局所所見を記載する"],
  ["ophthalmology", "眼科", "左右、視覚症状、眼所見を明確に記載する"],
  ["psychiatry", "精神科", "精神症状、生活状況、本人または家族への指示を記載する"],
  ["surgery", "外科", "創部または術後経過、全身状態を記載する"]
]);

const REQUIRED_MASTER_CODES = Object.freeze([
  "111000110",
  "112007410",
  "112007950",
  "114000110",
  "114001110",
  "114030310",
  "120002910"
]);

const TELEPHONE_ALLOWED_CODES = new Set(["112007950", "120002910"]);
const TELEPHONE_PHYSICAL_ACT = /(?:採血|検体検査|迅速検査|画像検査|超音波|レントゲン|ＣＴ|CT|ＭＲＩ|MRI|内視鏡|処置|注射|点滴|手術|ネブライザー).{0,18}(?:実施|施行|行(?:っ|い)|投与)/u;

export const HOLDOUT_GENERATOR_FAMILY = "openai-fee-specialty-holdout-v1";
export const HOLDOUT_TEXT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["clinicalText"],
  properties: {
    clinicalText: {
      type: "string",
      minLength: 120,
      maxLength: 4000
    }
  }
});

export const HOLDOUT_TEXT_INSTRUCTIONS = [
  "You create synthetic Japanese SOAP notes for medical fee extraction evaluation.",
  "Never include a real person's name, address, insurer number, or other identifying information.",
  "Use all required phrases verbatim and make the encounter facts internally consistent.",
  "Do not invent any same-day billable procedure, test, injection, imaging, surgery, or medication beyond billingTargets.",
  "Write only the current encounter. Do not add a billing code or point value to the note.",
  "Return one clinicalText string containing S, O, A, and P sections."
].join("\n");

export function buildNonOutpatientHoldoutBlueprints({
  masterRecords,
  casesPerCell = 2,
  serviceMonth = "2026-08"
}) {
  if (!Number.isInteger(casesPerCell) || casesPerCell < 1) {
    throw new Error("casesPerCell must be a positive integer");
  }
  requireMasterRecords(masterRecords, REQUIRED_MASTER_CODES);
  const blueprints = [];
  for (const [specialty, specialtyLabel, style] of SPECIALTIES) {
    for (const setting of ["home_visit", "house_call", "telephone"]) {
      for (let variant = 1; variant <= casesPerCell; variant += 1) {
        blueprints.push(buildBlueprint({
          specialty,
          specialtyLabel,
          style,
          setting,
          variant,
          serviceMonth,
          masterRecords
        }));
      }
    }
  }
  const document = {
    schemaVersion: "fee-specialty-holdout-blueprints-v1",
    datasetId: "fee-specialty-holdout-blueprints-v1",
    synthetic: true,
    generatorFamily: HOLDOUT_GENERATOR_FAMILY,
    casesPerCell,
    blueprints
  };
  const validation = validateNonOutpatientBlueprintDataset({
    document,
    masterRecords,
    requireClinicalText: false
  });
  if (!validation.ok) {
    throw new Error(`generated holdout blueprints are invalid: ${validation.errors.join("; ")}`);
  }
  return document;
}

export async function generateHoldoutTexts({
  blueprintDocument,
  model,
  modelRevision,
  generator,
  maxAttempts = 2
}) {
  if (!String(model || "").trim()) throw new Error("model is required");
  if (!String(modelRevision || "").trim()) {
    throw new Error("modelRevision is required and must identify an immutable model revision");
  }
  if (typeof generator !== "function") throw new Error("generator function is required");
  const promptSha256 = sha256(HOLDOUT_TEXT_INSTRUCTIONS);
  const schemaSha256 = sha256(stableJson(HOLDOUT_TEXT_SCHEMA));
  const cases = [];
  for (const blueprint of blueprintDocument?.blueprints || []) {
    let generated = null;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await generator({
          blueprint,
          instructions: HOLDOUT_TEXT_INSTRUCTIONS,
          schema: HOLDOUT_TEXT_SCHEMA,
          model,
          attempt
        });
        const clinicalText = String(response?.clinicalText || "").trim();
        const textErrors = validateGeneratedClinicalText(blueprint, clinicalText);
        if (textErrors.length) throw new Error(textErrors.join("; "));
        generated = {
          clinicalText,
          responseId: String(response?.responseId || "") || null,
          usage: response?.usage || null
        };
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!generated) {
      throw new Error(
        `text generation failed for ${blueprint.blueprintId}: ${lastError?.message || "unknown error"}`
      );
    }
    cases.push({
      caseId: blueprint.blueprintId,
      caseTypeKey: blueprint.templateId,
      specialty: blueprint.specialty,
      encounterSetting: blueprint.encounterSetting,
      encounter: {
        department: blueprint.specialty,
        setting: blueprint.encounterSetting,
        serviceDate: blueprint.serviceDate
      },
      chart: {
        standard: generated.clinicalText
      },
      expectedClaimContext: blueprint.expectedClaimContext,
      billingTargets: blueprint.billingTargets,
      expectedExtraction: {
        requiredBillingSignals: blueprint.requiredPhrases
      },
      generationProvenance: {
        source: "separate_generator",
        generatorFamily: HOLDOUT_GENERATOR_FAMILY,
        provider: "openai",
        model,
        modelRevision,
        promptSha256,
        schemaSha256,
        blueprintSha256: sha256(stableJson(blueprint)),
        responseId: generated.responseId
      }
    });
  }
  const document = {
    schemaVersion: "fee-soap-e2e-v2-cases.v2",
    datasetId: "fee-specialty-holdout-generated-v1",
    synthetic: true,
    notGold: true,
    cases
  };
  const validation = validateNonOutpatientBlueprintDataset({
    document,
    masterRecords: null,
    requireClinicalText: true
  });
  if (!validation.ok) {
    throw new Error(`generated holdout source is invalid: ${validation.errors.join("; ")}`);
  }
  return document;
}

export function validateNonOutpatientBlueprintDataset({
  document,
  masterRecords = null,
  requireClinicalText = false
}) {
  const errors = [];
  const items = Array.isArray(document?.blueprints)
    ? document.blueprints
    : (Array.isArray(document?.cases) ? document.cases : []);
  if (!items.length) errors.push("document must contain blueprints or cases");
  const ids = new Set();
  for (const item of items) {
    const id = String(item?.blueprintId || item?.caseId || "").trim() || "(missing)";
    if (ids.has(id)) errors.push(`${id}: duplicate id`);
    ids.add(id);
    const setting = item.encounterSetting || item.encounter?.setting;
    const expectedClaimContext = item.expectedClaimContext || {};
    const targets = Array.isArray(item.billingTargets) ? item.billingTargets : [];
    const codes = targets.map((target) => String(target?.code || "")).filter(Boolean);
    if (!SPECIALTIES.some(([specialty]) => specialty === (item.specialty || item.encounter?.department))) {
      errors.push(`${id}: unsupported specialty`);
    }
    if (!["home_visit", "house_call", "telephone"].includes(setting)) {
      errors.push(`${id}: unsupported encounterSetting ${setting}`);
      continue;
    }
    if (masterRecords) {
      for (const code of codes) {
        if (!masterRecords[code]) errors.push(`${id}: master code not found ${code}`);
      }
    }
    if (setting === "home_visit") {
      validateHomeVisit(id, expectedClaimContext, codes, errors);
    } else if (setting === "house_call") {
      validateHouseCall(id, expectedClaimContext, codes, errors);
    } else {
      validateTelephone(id, expectedClaimContext, codes, errors);
    }
    if (requireClinicalText) {
      const clinicalText = String(item?.chart?.standard || "");
      errors.push(...validateGeneratedClinicalText({
        ...item,
        blueprintId: id,
        requiredPhrases: requiredPhrasesFromContext(setting, expectedClaimContext, codes)
      }, clinicalText));
    }
  }
  return { ok: errors.length === 0, itemCount: items.length, errors };
}

export function requiredFeeMasterCodesForHoldoutGeneration() {
  return [...REQUIRED_MASTER_CODES];
}

function buildBlueprint({
  specialty,
  specialtyLabel,
  style,
  setting,
  variant,
  serviceMonth,
  masterRecords
}) {
  const specialtyIndex = SPECIALTIES.findIndex(([id]) => id === specialty);
  const day = String(1 + ((specialtyIndex * 6 + variant * 3) % 27)).padStart(2, "0");
  const serviceDate = `${serviceMonth}-${day}`;
  const serial = String(variant).padStart(3, "0");
  const prefix = `${specialty.toUpperCase().replace(/[^A-Z]/gu, "-")}-${setting.toUpperCase()}`;
  const base = {
    blueprintId: `H2-${prefix}-${serial}`,
    templateId: `fee-specialty-holdout-v1:${specialty}:${setting}:${serial}`,
    specialty,
    specialtyLabel,
    encounterSetting: setting,
    serviceDate,
    style,
    synthetic: true
  };
  if (setting === "home_visit") {
    const sameBuilding = variant % 2 === 0;
    const code = sameBuilding ? "114030310" : "114001110";
    const patientCount = sameBuilding ? 4 : 1;
    return {
      ...base,
      expectedClaimContext: {
        encounter: {
          service_date: serviceDate,
          is_outpatient: true
        },
        encounterDetails: {
          visitKind: "home_visit",
          sameBuilding,
          sameBuildingSource: "user",
          singleBuildingPatientCount: patientCount
        },
        procedure_codes: [code]
      },
      billingTargets: [target(masterRecords, code)],
      requiredPhrases: [
        "定期訪問診療を実施",
        sameBuilding ? "同一建物内の患者4名" : "患者宅へ訪問"
      ],
      forbiddenPhrases: ["往診を実施", "電話等再診"]
    };
  }
  if (setting === "house_call") {
    const initial = variant % 2 === 0;
    const baseCode = initial ? "111000110" : "112007410";
    return {
      ...base,
      expectedClaimContext: {
        encounter: {
          service_date: serviceDate,
          is_outpatient: true
        },
        encounterDetails: {
          visitKind: "house_call"
        },
        outpatient_basic: {
          fee_kind: initial ? "initial" : "revisit"
        },
        procedure_codes: ["114000110"]
      },
      billingTargets: [
        target(masterRecords, baseCode),
        target(masterRecords, "114000110")
      ],
      requiredPhrases: [
        initial ? "当院初診" : "当院再診",
        "患者側から臨時の求めがあり往診を実施"
      ],
      forbiddenPhrases: ["定期訪問診療を実施", "電話等再診"]
    };
  }
  const prescribe = variant % 2 === 0;
  return {
    ...base,
    expectedClaimContext: {
      encounter: {
        service_date: serviceDate,
        is_outpatient: true
      },
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
      ...(prescribe
        ? { procedure_codes: ["120002910"] }
        : {})
    },
    billingTargets: [
      target(masterRecords, "112007950"),
      ...(prescribe ? [target(masterRecords, "120002910")] : [])
    ],
    requiredPhrases: [
      "患者本人から電話相談",
      "電話等再診として治療上必要な指示",
      ...(prescribe ? ["院外処方箋を発行"] : [])
    ],
    forbiddenPhrases: [
      "来院して診察",
      "当日、検査を実施",
      "当日、処置を実施"
    ]
  };
}

function validateHomeVisit(id, context, codes, errors) {
  const details = context?.encounterDetails || {};
  const expectedCode = details.sameBuilding === true ? "114030310" : "114001110";
  if (details.visitKind !== "home_visit") errors.push(`${id}: home_visit visitKind mismatch`);
  if (typeof details.sameBuilding !== "boolean") errors.push(`${id}: sameBuilding must be boolean`);
  if (details.sameBuildingSource !== "user") errors.push(`${id}: sameBuildingSource must be user`);
  if (details.sameBuilding && Number(details.singleBuildingPatientCount) < 2) {
    errors.push(`${id}: same-building home visit requires at least 2 patients`);
  }
  if (!details.sameBuilding && Number(details.singleBuildingPatientCount) !== 1) {
    errors.push(`${id}: outside-same-building home visit requires patient count 1`);
  }
  if (codes.length !== 1 || codes[0] !== expectedCode) {
    errors.push(`${id}: home_visit billing target must be ${expectedCode}`);
  }
}

function validateHouseCall(id, context, codes, errors) {
  if (context?.encounterDetails?.visitKind !== "house_call") {
    errors.push(`${id}: house_call visitKind mismatch`);
  }
  if (!codes.includes("114000110")) errors.push(`${id}: house_call requires 114000110`);
  const baseCodes = codes.filter((code) => ["111000110", "112007410"].includes(code));
  if (baseCodes.length !== 1) errors.push(`${id}: house_call requires exactly one initial/revisit base fee`);
  const expectedBase = context?.outpatient_basic?.fee_kind === "initial"
    ? "111000110"
    : "112007410";
  if (!baseCodes.includes(expectedBase)) errors.push(`${id}: house_call base fee/context mismatch`);
}

function validateTelephone(id, context, codes, errors) {
  if (context?.encounterDetails?.visitKind !== "telephone_revisit") {
    errors.push(`${id}: telephone visitKind mismatch`);
  }
  if (!codes.includes("112007950")) errors.push(`${id}: telephone requires 112007950`);
  const forbidden = codes.filter((code) => !TELEPHONE_ALLOWED_CODES.has(code));
  if (forbidden.length) {
    errors.push(`${id}: telephone contains same-day physical/test target ${forbidden.join(", ")}`);
  }
  const eligibility = context?.outpatient_basic?.telephone_eligibility || {};
  if (
    context?.outpatient_basic?.fee_kind !== "revisit"
    || context?.outpatient_basic?.visit_kind !== "telephone_revisit"
    || eligibility.established_patient !== true
    || eligibility.patient_initiated !== true
    || eligibility.instruction_given !== true
    || eligibility.scheduled_management !== false
  ) {
    errors.push(`${id}: telephone eligibility contract is incomplete`);
  }
}

function validateGeneratedClinicalText(blueprint, clinicalText) {
  const id = blueprint?.blueprintId || blueprint?.caseId || "(missing)";
  const errors = [];
  if (clinicalText.length < 120) errors.push(`${id}: clinicalText is too short`);
  if (!["S", "O", "A", "P"].every((section) => new RegExp(`${section}[）:]`, "u").test(clinicalText))) {
    errors.push(`${id}: clinicalText must contain S/O/A/P sections`);
  }
  for (const phrase of blueprint?.requiredPhrases || []) {
    if (!clinicalText.includes(phrase)) errors.push(`${id}: missing required phrase ${phrase}`);
  }
  for (const phrase of blueprint?.forbiddenPhrases || []) {
    if (clinicalText.includes(phrase)) errors.push(`${id}: contains forbidden phrase ${phrase}`);
  }
  if (blueprint?.encounterSetting === "telephone" && TELEPHONE_PHYSICAL_ACT.test(clinicalText)) {
    errors.push(`${id}: telephone text contains a same-day physical procedure/test`);
  }
  return errors;
}

function requiredPhrasesFromContext(setting, context, codes) {
  if (setting === "home_visit") {
    return [
      "定期訪問診療を実施",
      context?.encounterDetails?.sameBuilding
        ? "同一建物内の患者4名"
        : "患者宅へ訪問"
    ];
  }
  if (setting === "house_call") {
    return [
      context?.outpatient_basic?.fee_kind === "initial" ? "当院初診" : "当院再診",
      "患者側から臨時の求めがあり往診を実施"
    ];
  }
  return [
    "患者本人から電話相談",
    "電話等再診として治療上必要な指示",
    ...(codes.includes("120002910") ? ["院外処方箋を発行"] : [])
  ];
}

function target(masterRecords, code) {
  const record = masterRecords[code];
  if (!record) throw new Error(`master code not found: ${code}`);
  return {
    code,
    name: record.name,
    source: record.table
  };
}

function requireMasterRecords(masterRecords, codes) {
  const missing = codes.filter((code) => !masterRecords?.[code]);
  if (missing.length) throw new Error(`fee master codes are missing: ${missing.join(", ")}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
