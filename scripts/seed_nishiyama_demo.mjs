#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeeSession } from "../packages/fee-core/src/index.js";
import {
  collections,
  feeSessionPath,
  loginIdentityPath,
  memberPath,
  organizationCodePath,
  organizationPath,
  patientPath
} from "../packages/firestore-schema/src/index.js";
import { normalizeOrganizationCode } from "../packages/platform-contracts/src/index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sampleRoot = join(root, "samples", "nishiyama-demo");
const uploadRoot = join(sampleRoot, "upload");
const projectByEnv = Object.freeze({
  stg: "medical-core-stg",
  prod: "medical-core-497610"
});
const orgCodeByEnv = Object.freeze({
  stg: "nishiyama-demo-stg",
  prod: "nishiyama-demo"
});
const orgNameByEnv = Object.freeze({
  stg: "西山病院 Demo STG",
  prod: "西山病院 Demo"
});

const args = parseArgs(process.argv.slice(2));
if (args.has("help")) {
  printUsage();
  process.exit(0);
}

const apply = args.get("apply") === "true";
const resetPassword = args.get("reset-password") === "true";
const samplesOnly = args.get("samples-only") === "true";
const targetEnv = args.get("env") || "all";
const envs = targetEnv === "all" ? ["stg", "prod"] : [targetEnv];
const loginIds = csv(args.get("login-ids") || "nishiyama-admin,nishiyama-clerk,nishiyama-doctor");
const passwordFile = args.get("password-file") || args.get("generate-password-file") || "";

for (const env of envs) {
  if (!projectByEnv[env]) {
    throw new Error(`Unknown env: ${env}`);
  }
}

await writeSampleUploadFiles();
await ensurePasswordDirectory();

if (!samplesOnly) {
  for (const env of envs) {
    await seedEnv(env);
  }
}

async function ensurePasswordDirectory() {
  if (!args.get("generate-password-file")) {
    return;
  }
  const filePath = args.get("generate-password-file");
  if (!filePath) {
    return;
  }
  await mkdir(dirname(resolvePath(filePath)), { recursive: true });
}

async function seedEnv(env) {
  const projectId = args.get("project-id") || projectByEnv[env];
  const organizationCode = normalizeOrganizationCode(args.get("organization-code") || orgCodeByEnv[env]);
  const organizationName = args.get("organization-name") || orgNameByEnv[env];
  const facilityName = args.get("facility-name") || "西山病院 Demo";
  const departmentName = args.get("department-name") || "医事課";
  const now = timestamp();

  runCoreSeed({
    env,
    organizationCode,
    organizationName,
    facilityName,
    departmentName
  });

  if (!apply) {
    console.log(`${env}: dry-run ${projectId}`);
    console.log(`- organizationCode: ${organizationCode}`);
    console.log("- would upsert Nishiyama demo member roles");
    console.log("- would upsert 6 synthetic demo patients");
    console.log("- would upsert 6 calculated fee sessions");
    console.log();
    return;
  }

  const accessToken = getAccessToken();
  const organization = await getOrganizationByCode(projectId, accessToken, organizationCode);
  if (!organization) {
    throw new Error(`Organization was not found after core seed: ${organizationCode}`);
  }
  const orgId = organization.orgId;
  const [facility, department, members] = await Promise.all([
    firstActiveSubdoc(projectId, accessToken, orgId, collections.facilities),
    firstActiveSubdoc(projectId, accessToken, orgId, collections.departments),
    listSubdocs(projectId, accessToken, orgId, collections.members)
  ]);
  if (!facility?.facilityId || !department?.departmentId) {
    throw new Error(`Facility/department is missing for ${organizationCode}`);
  }
  const actor = members.find((member) => member.loginId === "nishiyama-admin") || members[0] || {};

  const actions = [];
  for (const member of members.filter((member) => loginIds.includes(member.loginId))) {
    const patched = memberPatchForDemoRole(member);
    actions.push(`upsert member role ${member.loginId}`);
    if (apply) {
      await setDoc(projectId, accessToken, memberPath(orgId, member.memberId), { ...member, ...patched, updatedAt: now });
      const identityPath = loginIdentityPath(organizationCode, member.loginId);
      const identity = await getDoc(projectId, accessToken, identityPath);
      if (identity) {
        await setDoc(projectId, accessToken, identityPath, {
          ...identity,
          mfaRequired: Boolean(patched.globalRoles?.length),
          updatedAt: now
        });
      }
    }
  }

  const patients = demoPatients(now);
  for (const patient of patients) {
    actions.push(`upsert patient ${patient.patientId}`);
    if (apply) {
      await setDoc(projectId, accessToken, patientPath(orgId, patient.patientId), {
        ...patient,
        orgId,
        ...buildPatientSearchFields(patient),
        updatedAt: now
      });
    }
  }

  const facilitySnapshot = {
    facilityId: facility.facilityId,
    displayName: facility.displayName || facilityName,
    facilityType: facility.facilityType || "clinic",
    medicalInstitutionCode: "9999999",
    demoData: true
  };
  const departmentSnapshot = {
    departmentId: department.departmentId,
    displayName: department.displayName || departmentName,
    code: department.code || "demo"
  };

  for (const source of demoSessionSources()) {
    const patient = patients.find((item) => item.patientId === source.patientId);
    if (!patient) {
      continue;
    }
    const session = buildDemoFeeSession({
      source,
      orgId,
      createdByMemberId: actor.memberId || "nishiyama-demo-seed",
      patient,
      facilityId: facility.facilityId,
      facilitySnapshot,
      departmentId: department.departmentId,
      departmentSnapshot,
      now
    });
    actions.push(`upsert fee session ${session.feeSessionId}`);
    if (apply) {
      const sessionPath = feeSessionPath(orgId, session.feeSessionId);
      await setDoc(projectId, accessToken, sessionPath, session);
      await setDoc(projectId, accessToken, `${sessionPath}/views/status`, sessionStatusView(session));
    }
  }

  console.log(`${env}: ${apply ? "applied" : "dry-run"} ${projectId}`);
  console.log(`- organizationCode: ${organizationCode}`);
  for (const action of actions) {
    console.log(`- ${action}`);
  }
  console.log();
}

function runCoreSeed({ env, organizationCode, organizationName, facilityName, departmentName }) {
  const command = [
    process.execPath,
    join(root, "scripts", "p15_seed_core_account.mjs"),
    "--env", env,
    "--organization-code", organizationCode,
    "--organization-name", organizationName,
    "--login-ids", loginIds.join(","),
    "--products", "fee",
    "--facility-name", facilityName,
    "--department-name", departmentName,
    "--skip-demo-patient"
  ];
  if (apply) command.push("--apply");
  if (resetPassword) command.push("--reset-password");
  if (passwordFile) {
    command.push(args.get("generate-password-file") ? "--generate-password-file" : "--password-file", passwordFile);
  }
  if (args.get("password-env")) {
    command.push("--password-env", args.get("password-env"));
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

async function getOrganizationByCode(projectId, accessToken, organizationCode) {
  const code = await getDoc(projectId, accessToken, organizationCodePath(organizationCode));
  if (!code) {
    return null;
  }
  return getDoc(projectId, accessToken, organizationPath(code.orgId));
}

async function firstActiveSubdoc(projectId, accessToken, orgId, collectionName) {
  const docs = await listSubdocs(projectId, accessToken, orgId, collectionName);
  return docs.find((doc) => doc.status === "active") || docs[0] || null;
}

async function listSubdocs(projectId, accessToken, orgId, collectionName) {
  return listDocs(projectId, accessToken, organizationPath(orgId), collectionName);
}

async function getDoc(projectId, accessToken, path) {
  const response = await firestoreRequest(projectId, accessToken, "GET", documentUrl(projectId, path), null, { allow404: true });
  return response ? decodeDocument(response) : null;
}

async function setDoc(projectId, accessToken, path, data) {
  await firestoreRequest(projectId, accessToken, "PATCH", documentUrl(projectId, path), {
    fields: encodeFields(data)
  });
}

async function listDocs(projectId, accessToken, parentPath, collectionName) {
  const docs = [];
  let pageToken = "";
  do {
    const separator = pageToken ? "&" : "";
    const url = `${collectionUrl(projectId, parentPath, collectionName)}?pageSize=300${separator}${pageToken ? `pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const response = await firestoreRequest(projectId, accessToken, "GET", url, null, { allow404: true });
    for (const doc of response?.documents || []) {
      docs.push(decodeDocument(doc));
    }
    pageToken = response?.nextPageToken || "";
  } while (pageToken);
  return docs;
}

async function firestoreRequest(projectId, accessToken, method, url, body, options = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 404 && options.allow404) {
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${projectId} ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function documentUrl(projectId, path) {
  return `${firestoreBase(projectId)}/${encodeFirestorePath(path)}`;
}

function collectionUrl(projectId, parentPath, collectionName) {
  return `${firestoreBase(projectId)}/${encodeFirestorePath(parentPath)}/${encodeURIComponent(collectionName)}`;
}

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

function encodeFirestorePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function encodeFields(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)])
  );
}

function encodeValue(value) {
  if (value === null) {
    return { nullValue: null };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return { integerValue: String(value) };
  }
  if (typeof value === "number") {
    return { doubleValue: value };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFields(value) } };
  }
  return { stringValue: String(value) };
}

function decodeDocument(document) {
  return decodeFields(document.fields || {});
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function decodeValue(value) {
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return undefined;
}

function getAccessToken() {
  return execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function memberPatchForDemoRole(member = {}) {
  if (member.loginId === "nishiyama-admin") {
    return {
      displayName: "西山Demo 管理者",
      globalRoles: ["org_admin", "billing_admin"],
      productRoles: { fee: ["admin"] }
    };
  }
  if (member.loginId === "nishiyama-clerk") {
    return {
      displayName: "西山Demo 医事課",
      globalRoles: [],
      productRoles: { fee: ["medical_clerk"] }
    };
  }
  if (member.loginId === "nishiyama-doctor") {
    return {
      displayName: "西山Demo 医師",
      globalRoles: [],
      productRoles: { fee: ["doctor"] }
    };
  }
  return {};
}

function demoPatients(now) {
  return [
    demoPatient("pat_nishiyama_demo_001", "西山デモ 患者001", "ニシヤマデモ カンジャ001", "NDM001", "male", "1998-04-15", now),
    demoPatient("pat_nishiyama_demo_002", "西山デモ 患者002", "ニシヤマデモ カンジャ002", "NDM002", "male", "1991-06-20", now),
    demoPatient("pat_nishiyama_demo_003", "西山デモ 患者003", "ニシヤマデモ カンジャ003", "NDM003", "male", "2022-02-10", now),
    demoPatient("pat_nishiyama_demo_004", "西山デモ 患者004", "ニシヤマデモ カンジャ004", "NDM004", "female", "1975-09-12", now),
    demoPatient("pat_nishiyama_demo_005", "西山デモ 患者005", "ニシヤマデモ カンジャ005", "NDM005", "male", "1942-11-05", now),
    demoPatient("pat_nishiyama_demo_006", "西山デモ 患者006", "ニシヤマデモ カンジャ006", "NDM006", "female", "1960-01-25", now)
  ];
}

function demoPatient(patientId, displayName, displayNameKana, primaryPatientNumber, sex, birthDate, now) {
  return {
    patientId,
    displayName,
    displayNameKana,
    birthDate,
    sex,
    primaryPatientNumber,
    patientIdentifiers: [{ system: "demo", value: primaryPatientNumber }],
    externalPatientIds: [primaryPatientNumber],
    contact: {},
    insurance: {
      insurerType: "other",
      insurerNumber: "99999999",
      insuredSymbol: "DEMO",
      insuredNumber: primaryPatientNumber,
      burdenRatio: 0.3
    },
    publicInsurance: {},
    consent: {},
    duplicateCandidateIds: [],
    status: "active",
    notes: "Synthetic Nishiyama hospital demo patient. No real PHI.",
    demoData: true,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

function demoSessionSources() {
  return [
    {
      feeSessionId: "fee_nishiyama_demo_001_20260701",
      patientId: "pat_nishiyama_demo_001",
      serviceDate: "2026-07-01",
      diagnoses: ["急性胃腸炎"],
      clinicalText: "S：本日夕方から嘔吐・下痢。発熱37.8℃。O：腹部やや圧痛、反跳痛なし。A：急性胃腸炎。P：院内処方。整腸剤（ビオフェルミンR）1日3回、制吐剤（ドンペリドン）頓用、5日分。水分補給を説明。",
      lineItems: [
        line("line_001_revisit", "112007410", "再診料", "basic", 76),
        line("line_001_bup", "180820010", "物価対応料１（外来・在宅物価対応料）（再診時等）ロ", "basic", 2),
        line("line_001_dispense", "120000710", "調剤料（内服薬・浸煎薬・屯服薬）", "medication", 11),
        line("line_001_prescription", "120001210", "処方料（その他）", "medication", 42),
        line("line_001_biofermin", "612370052", "ビオフェルミンＲ錠", "medication", 3)
      ],
      reviewIssues: [
        reviewIssue("demo_001_domperidone_dose", "薬剤情報確認", "ドンペリドンは用量または総量が不足しています。例: ドンペリドン XXmg 1日X回 X日分。", "warning")
      ]
    },
    {
      feeSessionId: "fee_nishiyama_demo_002_20260702",
      patientId: "pat_nishiyama_demo_002",
      serviceDate: "2026-07-02",
      diagnoses: ["右下腿II度熱傷", "右前腕擦過創"],
      clinicalText: "S：3日前に調理中の油で右下腿をやけど。本日2回目の処置。O：右下腿前面にII度熱傷、範囲約120cm2。右前腕擦過創約30cm2にも創傷処置。洗浄・軟膏塗布・被覆を施行。A：右下腿II度熱傷、右前腕擦過創。",
      lineItems: [
        line("line_002_revisit", "112007410", "再診料", "basic", 76),
        line("line_002_bup", "180820010", "物価対応料１（外来・在宅物価対応料）（再診時等）ロ", "basic", 2),
        line("line_002_burn", "140032110", "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", "treatment", 147),
        line("line_002_wound", "140000610", "創傷処置（１００ｃｍ２未満）", "treatment", 52)
      ],
      reviewIssues: [
        reviewIssue("demo_002_multiple_treatment", "同日複数処置の確認", "熱傷処置と創傷処置を同日に算定しています。右下腿II度熱傷120cm2、右前腕擦過創30cm2を別部位として処置した根拠を確認してください。", "warning")
      ]
    },
    {
      feeSessionId: "fee_nishiyama_demo_003_20260703",
      patientId: "pat_nishiyama_demo_003",
      serviceDate: "2026-07-03",
      diagnoses: ["A群溶連菌性扁桃炎"],
      clinicalText: "S：母より昨夜から39℃台の発熱、咽頭痛。O：4歳男児、咽頭発赤、迅速抗原検査2件実施。A群β溶血連鎖球菌迅速試験陽性、インフルエンザ陰性。結果を当日説明し文書交付。P：アモキシシリン細粒10日分、アセトアミノフェン頓用。",
      lineItems: [
        line("line_003_initial", "111000110", "初診料", "basic", 291),
        line("line_003_bup", "180820000", "物価対応料１（外来・在宅物価対応料）（初診時）", "basic", 6),
        line("line_003_strep", "160198010", "A群β溶血連鎖球菌迅速試験", "laboratory", 117),
        line("line_003_flu", "160141710", "インフルエンザウイルス抗原定性", "laboratory", 139),
        line("line_003_judgement", "160176810", "免疫学的検査判断料", "laboratory", 144)
      ],
      candidateProposals: [
        proposal("demo_003_document", "検査結果説明文書の確認", "結果を当日説明し文書交付しているため、該当するコメントまたは文書要件を確認してください。", 0)
      ]
    },
    {
      feeSessionId: "fee_nishiyama_demo_004_20260704",
      patientId: "pat_nishiyama_demo_004",
      serviceDate: "2026-07-04",
      diagnoses: ["高血圧症"],
      clinicalText: "S：高血圧で通院中。自宅血圧は安定。O：BP130/80。検査・画像なし。A：高血圧症、コントロール良好。P：リフィル処方箋を発行。アムロジピン5mg 1回1錠 1日1回朝 28日分。次回は3回使用後に受診予定。",
      lineItems: [
        line("line_004_revisit", "112007410", "再診料", "basic", 76),
        line("line_004_bup", "180820010", "物価対応料１（外来・在宅物価対応料）（再診時等）ロ", "basic", 2),
        line("line_004_prescription", "120002910", "処方箋料（リフィル以外・その他）", "medication", 68)
      ],
      reviewIssues: [
        reviewIssue("demo_004_refill_comment", "レセプトコメントの確認", "リフィル処方箋の使用回数、対象外でない理由、患者説明内容の記載を確認してください。", "warning")
      ]
    },
    {
      feeSessionId: "fee_nishiyama_demo_005_20260705",
      patientId: "pat_nishiyama_demo_005",
      serviceDate: "2026-07-05",
      diagnoses: ["末期肺癌", "がん性疼痛"],
      clinicalText: "S：在宅療養中。疼痛はオキシコドン調整後やや改善。O：自宅訪問、全身状態確認。A：末期肺癌、がん性疼痛。P：訪問診療を実施し、家族へ緩和ケア方針を説明。医療情報連携を継続。",
      lineItems: [
        line("line_005_visit", "114001110", "在宅患者訪問診療料（１）１（同一建物居住者以外）", "home_care", 890),
        line("line_005_pain", "113012810", "がん性疼痛緩和指導管理料", "management", 200),
        line("line_005_bup", "180725910", "外来・在宅ベースアップ評価料（１）３（訪問診療時）イ", "basic", 79)
      ],
      candidateProposals: [
        proposal("demo_005_home_data", "在宅データ提出加算の確認", "施設基準と届出状況が満たされていれば、在宅データ提出加算の算定可否を確認してください。", 50, {
          code: "114057970",
          name: "在宅データ提出加算（在医総管・施医総管）",
          orderType: "home_care"
        })
      ]
    },
    {
      feeSessionId: "fee_nishiyama_demo_006_20260706",
      patientId: "pat_nishiyama_demo_006",
      serviceDate: "2026-07-06",
      diagnoses: ["通年性アレルギー性鼻炎"],
      clinicalText: "S：通年性アレルギー性鼻炎で通院中。症状は安定。O：鼻鏡で下鼻甲介軽度腫脹。処置・ネブライザー・検査なし。A：通年性アレルギー性鼻炎。P：フェキソフェナジン60mg 1回1錠 1日2回 朝夕 28日分。",
      lineItems: [
        line("line_006_revisit", "112007410", "再診料", "basic", 76),
        line("line_006_bup", "180820010", "物価対応料１（外来・在宅物価対応料）（再診時等）ロ", "basic", 2),
        line("line_006_dispense", "120000710", "調剤料（内服薬・浸煎薬・屯服薬）", "medication", 11),
        line("line_006_prescription", "120001210", "処方料（その他）", "medication", 42)
      ],
      reviewIssues: [
        reviewIssue("demo_006_dosage", "用量チェック", "フェキソフェナジンは年齢・用量・日数の上限確認が必要です。実投与量が適正範囲内か確認してください。", "warning")
      ]
    }
  ];
}

function buildDemoFeeSession({ source, orgId, createdByMemberId, patient, facilityId, facilitySnapshot, departmentId, departmentSnapshot, now }) {
  const totalPoints = source.lineItems.reduce((sum, item) => sum + Number(item.totalPoints || 0), 0);
  const calculationId = `calc_${source.feeSessionId}`;
  const calculationResult = {
    calculationId,
    provider: "demo-seed",
    source: "nishiyama_demo",
    status: (source.reviewIssues?.length || source.candidateProposals?.length) ? "needs_review" : "calculated",
    engineStatus: "completed",
    totalPoints,
    lineItems: source.lineItems,
    warnings: [],
    reviewIssues: source.reviewIssues || [],
    candidateProposals: source.candidateProposals || [],
    coverage: {
      lineCount: source.lineItems.length,
      reviewLineCount: (source.reviewIssues || []).length,
      supportLevel: (source.reviewIssues?.length || source.candidateProposals?.length) ? "review_required" : "confirmed",
      reviewRequired: Boolean(source.reviewIssues?.length || source.candidateProposals?.length),
      generatedAt: now
    },
    generatedAt: now
  };
  const session = buildFeeSession({
    orgId,
    patientId: patient.patientId,
    patientSnapshot: patientSnapshot(patient),
    insuranceSnapshot: { insurance: patient.insurance, publicInsurance: patient.publicInsurance || {}, capturedAt: now },
    facilityId,
    facilitySnapshot,
    departmentId,
    departmentSnapshot,
    createdByMemberId,
    status: calculationResult.status === "needs_review" ? "needs_review" : "calculated",
    serviceDate: source.serviceDate,
    claimMonth: source.serviceDate.slice(0, 7),
    setting: "outpatient",
    clinicalText: source.clinicalText,
    diagnoses: source.diagnoses.map((name, index) => ({ name, isPrimary: index === 0 })),
    diagnosesSource: "demo_seed",
    orders: [],
    sourceSystem: "nishiyama_demo_seed",
    calculationResult,
    calculationSummary: summarizeCalculation(calculationResult),
    monthlyClaimWork: {
      status: calculationResult.status === "needs_review" ? "needs_action" : "ready",
      note: "Nishiyama demo synthetic monthly review item",
      updatedAt: now,
      updatedByMemberId: createdByMemberId
    }
  }, {
    feeSessionId: source.feeSessionId,
    now
  });
  return {
    ...session,
    latestCalculationId: calculationId,
    demoData: true
  };
}

function line(lineId, code, name, orderType, points, quantity = 1) {
  return {
    lineId,
    code,
    name,
    orderType,
    points,
    quantity,
    totalPoints: points * quantity,
    status: "approved",
    supportLevel: "confirmed",
    reviewRequired: false,
    source: "nishiyama_demo_seed"
  };
}

function reviewIssue(issueId, topicLabel, messageForStaff, severity = "warning") {
  return {
    issueId,
    topicLabel,
    title: topicLabel,
    messageForStaff,
    severity,
    source: "nishiyama_demo_seed",
    category: "demo_review",
    reviewRequired: true
  };
}

function proposal(proposalId, title, reason, potentialPoints, candidateLine = {}) {
  return {
    proposalId,
    title,
    reason,
    potentialPoints,
    source: "nishiyama_demo_seed",
    orderType: candidateLine.orderType || "other",
    candidateLine: {
      lineId: `line_${proposalId}`,
      code: candidateLine.code || "",
      name: candidateLine.name || title,
      orderType: candidateLine.orderType || "other",
      points: potentialPoints,
      quantity: 1,
      totalPoints: potentialPoints,
      status: "candidate",
      supportLevel: "candidate",
      reviewRequired: true
    }
  };
}

function summarizeCalculation(calculation = {}) {
  const lineItems = Array.isArray(calculation.lineItems) ? calculation.lineItems : [];
  return {
    calculationId: calculation.calculationId,
    totalPoints: Number(calculation.totalPoints || 0),
    lineCount: lineItems.length,
    reviewLineCount: Array.isArray(calculation.reviewIssues) ? calculation.reviewIssues.length : 0,
    supportLevel: calculation.coverage?.supportLevel || null,
    reviewRequired: calculation.status === "needs_review",
    generatedAt: calculation.generatedAt || null
  };
}

function patientSnapshot(patient = {}) {
  return {
    patientId: patient.patientId,
    displayName: patient.displayName,
    displayNameKana: patient.displayNameKana,
    birthDate: patient.birthDate,
    sex: patient.sex,
    primaryPatientNumber: patient.primaryPatientNumber,
    externalPatientIds: patient.externalPatientIds || []
  };
}

function sessionStatusView(session = {}) {
  return {
    feeSessionId: session.feeSessionId,
    sessionId: session.sessionId || session.feeSessionId,
    status: session.status || "draft",
    calculationProgress: session.calculationProgress || null,
    calculationSummary: session.calculationSummary || null,
    latestCalculationId: session.latestCalculationId || null,
    activeCalculationJobId: session.activeCalculationJobId || null,
    updatedAt: session.updatedAt || null
  };
}

async function writeSampleUploadFiles() {
  const sourceDir = join(uploadRoot, "recalculation-diff", "source");
  const checkerDir = join(uploadRoot, "receipt-checker");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(checkerDir, { recursive: true });

  const files = sampleUploadFiles();
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(sourceDir, name), content);
  }
  await writeFile(join(checkerDir, "RECEIPTC.UKE"), files["RECEIPTC.UKE"]);
  await writeFile(join(checkerDir, "receipt.csv"), files["receipt.csv"]);

  const zipPath = join(uploadRoot, "recalculation-diff", "nishiyama-demo-recalculation-diff.zip");
  await createZip(zipPath, sourceDir, Object.keys(files));
  await writeUploadReadme(zipPath);
  console.log(`samples: wrote ${relative(root, zipPath)}`);
}

function sampleUploadFiles() {
  const claimMonth = "2026-07";
  const manifest = {
    schemaVersion: "recalculation-diff.v1",
    datasetName: "nishiyama-demo-recalculation-diff",
    claimMonth,
    clinicName: "西山病院 Demo",
    medicalInstitutionCode: "9999999",
    files: {
      baselineReceipt: "RECEIPTC.UKE",
      patients: "patients.csv",
      charts: "charts.jsonl",
      orders: "orders.csv",
      diagnoses: "diagnoses.csv",
      facility: "facility.json",
      receiptCsvReference: "receipt.csv"
    },
    conversionPolicy: {
      notInferred: true,
      demoDataOnly: true
    }
  };
  const patients = [
    ["patient_id", "display_name", "birth_date", "sex"],
    ["NDM001", "西山デモ 患者001", "1998-04-15", "male"],
    ["NDM002", "西山デモ 患者002", "1991-06-20", "male"],
    ["NDM005", "西山デモ 患者005", "1942-11-05", "male"]
  ];
  const diagnoses = [
    ["patient_id", "service_date", "diagnosis_name", "is_primary"],
    ["NDM001", "2026-07-01", "急性胃腸炎", "1"],
    ["NDM002", "2026-07-02", "右下腿II度熱傷", "1"],
    ["NDM002", "2026-07-02", "右前腕擦過創", ""],
    ["NDM005", "2026-07-05", "末期肺癌", "1"],
    ["NDM005", "2026-07-05", "がん性疼痛", ""]
  ];
  const orders = [
    ["patient_id", "service_date", "order_type", "code", "name", "quantity", "days", "dose_quantity", "doses_per_day", "area_size", "status"],
    ["NDM001", "2026-07-01", "procedure", "112007410", "再診料", "1", "", "", "", "", "実施"],
    ["NDM001", "2026-07-01", "drug", "612370052", "ビオフェルミンＲ錠", "3", "5", "1", "3", "", "実施"],
    ["NDM002", "2026-07-02", "treatment", "", "熱傷処置", "1", "", "", "", "120cm2", "実施"],
    ["NDM002", "2026-07-02", "treatment", "", "創傷処置", "1", "", "", "", "30cm2", "実施"],
    ["NDM005", "2026-07-05", "procedure", "114001110", "在宅患者訪問診療料（１）１（同一建物居住者以外）", "1", "", "", "", "", "実施"],
    ["NDM005", "2026-07-05", "procedure", "113012810", "がん性疼痛緩和指導管理料", "1", "", "", "", "", "実施"]
  ];
  const receipt = [
    ["patient_id", "claim_month", "code", "name", "points", "count", "sex", "birth_date", "receipt_type"],
    ["NDM001", claimMonth, "112007410", "再診料", "76", "1", "male", "1998-04-15", "medical_outpatient"],
    ["NDM001", claimMonth, "120001210", "処方料（その他）", "42", "1", "male", "1998-04-15", "medical_outpatient"],
    ["NDM002", claimMonth, "140032110", "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", "147", "1", "male", "1991-06-20", "medical_outpatient"],
    ["NDM002", claimMonth, "140000610", "創傷処置（１００ｃｍ２未満）", "52", "1", "male", "1991-06-20", "medical_outpatient"],
    ["NDM005", claimMonth, "114001110", "在宅患者訪問診療料（１）１（同一建物居住者以外）", "890", "1", "male", "1942-11-05", "medical_outpatient"],
    ["NDM005", claimMonth, "113012810", "がん性疼痛緩和指導管理料", "200", "1", "male", "1942-11-05", "medical_outpatient"],
    ["NDM005", claimMonth, "114057970", "在宅データ提出加算（在医総管・施医総管）", "50", "1", "male", "1942-11-05", "medical_outpatient"]
  ];
  const charts = [
    {
      patient_id: "NDM001",
      service_date: "2026-07-01",
      clinical_text: "S：嘔吐・下痢。O：軽度脱水。A：急性胃腸炎。P：院内処方。整腸剤を5日分。"
    },
    {
      patient_id: "NDM002",
      service_date: "2026-07-02",
      clinical_text: "右下腿II度熱傷120cm2と右前腕擦過創30cm2を別部位として洗浄・軟膏塗布・被覆。"
    },
    {
      patient_id: "NDM005",
      service_date: "2026-07-05",
      clinical_text: "在宅訪問診療。末期肺癌、がん性疼痛。疼痛緩和指導を家族同席で実施。"
    }
  ];
  return {
    "README.md": [
      "# 西山病院Demo 再算定差分診断データセット",
      "",
      "匿名の合成データです。実患者情報、実保険情報、実医療機関コードは含めていません。",
      "fee-web の `再算定差分診断` に ZIP ごとアップロードして使います。",
      ""
    ].join("\n"),
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "patients.csv": csvText(patients),
    "diagnoses.csv": csvText(diagnoses),
    "orders.csv": csvText(orders),
    "receipt.csv": csvText(receipt),
    "charts.jsonl": `${charts.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "facility.json": `${JSON.stringify({
      medicalInstitutionCode: "9999999",
      regionalBureau: "demo",
      facilityStandardKeys: [],
      demoData: true
    }, null, 2)}\n`,
    "RECEIPTC.UKE": [
      "IR,1,14,1,9999999,,NishiyamaDemo,50701",
      "RE,1,1112,NDM001,2,4100415",
      "HO,99999999,,NDM001,,1,118,118",
      "SI,11,1,112007410,,76,1",
      "SI,60,1,120001210,,42,1",
      "RE,2,1112,NDM002,1,4030620",
      "HO,99999999,,NDM002,,1,199,199",
      "SI,40,1,140032110,,147,1",
      "SI,40,1,140000610,,52,1",
      "RE,3,1112,NDM005,1,2171105",
      "HO,99999999,,NDM005,,1,1140,1140",
      "SI,14,1,114001110,,890,1",
      "SI,13,1,113012810,,200,1",
      "SI,14,1,114057970,,50,1",
      ""
    ].join("\n")
  };
}

async function writeUploadReadme(zipPath) {
  const readmePath = join(sampleRoot, "README.md");
  const current = await readFile(readmePath, "utf8").catch(() => "");
  const marker = "\n## Web Demo / CSV・UKEアップロード\n";
  const section = `${marker}
営業Demoで使うアップロード用サンプルです。すべて匿名の合成データです。

- 再算定差分診断ZIP: \`${relative(root, zipPath)}\`
- ZIP展開元: \`${relative(root, join(uploadRoot, "recalculation-diff", "source"))}\`
- レセプトチェッカー用UKE: \`${relative(root, join(uploadRoot, "receipt-checker", "RECEIPTC.UKE"))}\`

使い方:

\`\`\`bash
# サンプルファイルだけ再生成
npm run seed:nishiyama-demo -- --samples-only

# STG/PRODのDemoアカウントとFirestoreダミーデータを作成（dry-run）
npm run seed:nishiyama-demo -- --env all

# 実作成。パスワードは生成ファイルに保存されます。
npm run seed:nishiyama-demo -- --env all --generate-password-file .secrets/nishiyama-demo-password.txt --apply
\`\`\`

PRODでは通常組織にアップロード系メニューを出さず、\`nishiyama-demo\` の組織コードだけに表示します。
STGは \`nishiyama-demo-stg\` です。
`;
  const next = current.includes(marker)
    ? `${current.slice(0, current.indexOf(marker)).trimEnd()}\n${section}`
    : `${current.trimEnd()}\n${section}`;
  await writeFile(readmePath, next.trimStart());
}

async function createZip(zipPath, sourceDir, fileNames) {
  const python = process.env.PYTHON_BIN || "python3";
  const argsForZip = ["-m", "zipfile", "-c", zipPath, ...fileNames];
  const result = spawnSync(python, argsForZip, {
    cwd: sourceDir,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`zip creation failed: ${result.stderr || result.stdout}`);
  }
}

function csvText(rows) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/u.test(text)) {
    return text;
  }
  return `"${text.replace(/"/gu, "\"\"")}"`;
}

function buildPatientSearchFields(patient = {}) {
  const primaryCode = patient.primaryPatientNumber
    || patient.patientCode
    || firstPatientIdentifierValue(patient)
    || "";
  const externalId = Array.isArray(patient.externalPatientIds) ? patient.externalPatientIds[0] : "";
  return compactObject({
    patientSearchName: normalizePatientSearchValue(patient.displayName) || undefined,
    patientSearchKana: normalizePatientSearchValue(patient.displayNameKana) || undefined,
    patientSearchPrimaryNumber: normalizePatientSearchValue(primaryCode) || undefined,
    patientSearchExternalId: normalizePatientSearchValue(externalId) || undefined,
    patientSearchId: normalizePatientSearchValue(patient.patientId) || undefined,
    patientSearchPrefixes: buildPatientSearchPrefixes(patient),
    patientSearchText: normalizePatientSearchValue([
      patient.displayName,
      patient.displayNameKana,
      primaryCode,
      externalId,
      patient.patientId
    ].filter(Boolean).join(" ")) || undefined
  });
}

function buildPatientSearchPrefixes(patient = {}) {
  const values = [
    normalizePatientSearchValue(patient.displayName),
    normalizePatientSearchValue(patient.displayNameKana),
    normalizePatientSearchValue(patient.primaryPatientNumber),
    normalizePatientSearchValue(patient.patientId),
    ...normalizePatientIdentifierValues(patient)
  ].filter(Boolean);
  const prefixes = new Set();
  for (const value of values) {
    const chars = [...value].slice(0, 32);
    for (let index = 1; index <= chars.length; index += 1) {
      prefixes.add(chars.slice(0, index).join(""));
    }
  }
  return prefixes.size ? [...prefixes].slice(0, 200) : undefined;
}

function firstPatientIdentifierValue(patient = {}) {
  return normalizePatientIdentifierValues(patient)[0] || "";
}

function normalizePatientIdentifierValues(patient = {}) {
  const identifiers = Array.isArray(patient.patientIdentifiers) ? patient.patientIdentifiers : [];
  return identifiers
    .map((identifier) => identifier?.value || identifier?.patientNumber || identifier?.id || "")
    .map(normalizePatientSearchValue)
    .filter(Boolean);
}

function normalizePatientSearchValue(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .trim();
}

function timestamp() {
  return new Date().toISOString();
}

function resolvePath(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = values[index + 1]?.startsWith("--") ? "true" : values[index + 1] || "true";
    parsed.set(key, value);
    if (value !== "true") {
      index += 1;
    }
  }
  return parsed;
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function printUsage() {
  console.log("Usage:");
  console.log("  npm run seed:nishiyama-demo -- --samples-only");
  console.log("  npm run seed:nishiyama-demo -- --env stg|prod|all [--apply] [--generate-password-file .secrets/nishiyama-demo-password.txt]");
  console.log("");
  console.log("Notes:");
  console.log("- --apply writes Firestore. Without --apply it is a dry-run after the core account dry-run.");
  console.log("- The seed creates nishiyama-demo-stg in STG and nishiyama-demo in PROD by default.");
}
