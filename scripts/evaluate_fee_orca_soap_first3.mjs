import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../packages/auth-client/src/index.js";
import { createSignedSession } from "../services/platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../services/platform-api/src/store/memory-store.js";
import { MemoryFeeStore } from "../services/fee-api/src/store/memory-store.js";
import { handleFeeApiRequest } from "../services/fee-api/src/server.js";
import { createFeeCalculatorFromEnv } from "../services/fee-api/src/python-calculator.js";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const SOURCE_DOC = path.join(
  ROOT_DIR,
  "docs/migration-parity/fee-calculation-legacy-docs/orca-karte-gold-11.md"
);
const OUTPUT_DOC = path.join(
  ROOT_DIR,
  "docs/migration-parity/fee-calculation-legacy-docs/orca-karte-first3-current-logic-evaluation.md"
);

const CASE_META = {
  1: {
    title: "事例1（整形外科・国保）",
    serviceDate: "2026-04-14",
    department: "整形外科",
    patient: { displayName: "ORCA Case 1", sex: "male", externalPatientIds: ["orca-00001"] }
  },
  2: {
    title: "事例2（内科・協会けんぽ→国保）",
    serviceDate: "2026-04-11",
    department: "内科",
    patient: { displayName: "ORCA Case 2", sex: "unknown", externalPatientIds: ["orca-00002"] }
  },
  3: {
    title: "事例3（内科・共済）",
    serviceDate: "2026-04-19",
    department: "内科",
    patient: { displayName: "ORCA Case 3", sex: "unknown", externalPatientIds: ["orca-00003"] }
  }
};

const now = new Date("2026-06-06T00:00:00.000Z");
const source = readFileSync(SOURCE_DOC, "utf8");
const cases = [1, 2, 3].map((caseNumber) => ({
  caseNumber,
  ...CASE_META[caseNumber],
  soap: extractCodeBlockAfterHeading(source, `### 事例${caseNumber}`, "SOAP"),
  expected: extractExpectedBlock(source, caseNumber)
}));

const stores = createStores();
const headers = signedHeaders(stores.platformStore);
const startedAt = Date.now();
const results = [];

for (const item of cases) {
  const result = await evaluateCase(item, stores, headers);
  results.push(result);
}

if (typeof stores.feeCalculator.stopWorker === "function") {
  stores.feeCalculator.stopWorker();
}

const durationMs = Date.now() - startedAt;
const report = buildReport({ cases, results, durationMs });
writeFileSync(OUTPUT_DOC, report);
console.log(`Wrote ${path.relative(ROOT_DIR, OUTPUT_DOC)}`);

function createStores() {
  let counter = 0;
  const counters = new Map();
  const idFactory = (prefix) => {
    const next = Number(counters.get(prefix) || 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(3, "0")}`;
  };
  const platformStore = new MemoryPlatformStore({
    now: () => now,
    idFactory,
    tokenFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const feeStore = new MemoryFeeStore({
    now: () => now,
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const organization = platformStore.createOrganization({
    organizationCode: "orca-eval",
    displayName: "ORCA Evaluation Clinic"
  });
  platformStore.createMember(organization.orgId, {
    loginId: "admin@example.com",
    displayName: "Admin",
    globalRoles: ["org_admin"],
    productRoles: { fee: ["admin"] },
    password: "correct horse battery staple"
  });
  const facility = platformStore.createFacility(organization.orgId, {
    displayName: "ORCA評価クリニック",
    medicalInstitutionCode: "1312345",
    regionalBureau: "kanto-shinetsu",
    prefecture: "tokyo"
  });
  const departments = new Map();
  for (const displayName of ["内科", "整形外科"]) {
    const department = platformStore.createDepartment(organization.orgId, {
      facilityId: facility.facilityId,
      displayName,
      code: displayName === "内科" ? "01" : "11"
    });
    departments.set(displayName, department.departmentId);
  }
  platformStore.upsertProductEntitlement(organization.orgId, {
    productId: "fee",
    status: "trialing"
  });

  return {
    platformStore,
    feeStore,
    facilityId: facility.facilityId,
    departments,
    feeCalculator: createFeeCalculatorFromEnv({
      ...process.env,
      FEE_MASTER_DB_PATH: path.join(ROOT_DIR, "python/data/master/standard-master.sqlite"),
      FEE_PYTHON_WORKER: "0",
      FEE_CALCULATOR_TIMEOUT_MS: "60000"
    })
  };
}

function signedHeaders(platformStore) {
  const identity = platformStore.getLoginIdentity("orca-eval", "admin@example.com");
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: ["org_admin"],
    productRoles: { fee: ["admin"] },
    csrfToken: "csrf_eval"
  }, {
    now,
    sessionSecret: "orca-eval-session-secret"
  });

  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken
  };
}

async function evaluateCase(item, stores, headers) {
  const createResponse = await request(stores, "POST", "/v1/fee/sessions", {
    patient: item.patient,
    facilityId: stores.facilityId,
    departmentId: stores.departments.get(item.department),
    serviceDate: item.serviceDate,
    clinicalText: item.soap,
    sourceSystem: "orca_karte_gold_first3_eval"
  }, headers);
  if (createResponse.statusCode >= 400) {
    throw new Error(`case ${item.caseNumber} create failed: ${JSON.stringify(createResponse.body)}`);
  }
  const sessionId = createResponse.body.feeSession.feeSessionId;
  const calculateResponse = await request(
    stores,
    "POST",
    `/v1/fee/sessions/${sessionId}/calculate`,
    {},
    headers
  );
  if (calculateResponse.statusCode >= 400) {
    return {
      ...item,
      statusCode: calculateResponse.statusCode,
      error: calculateResponse.body
    };
  }
  const detailResponse = await request(
    stores,
    "GET",
    `/v1/fee/sessions/${sessionId}/detail`,
    undefined,
    headers
  );
  const detail = detailResponse.body || {};
  const feeSession = detail.feeSession || calculateResponse.body.feeSession || {};
  const calculationResult = feeSession.calculationResult || calculateResponse.body.calculationResult || {};
  const receiptDraft = detail.receiptDraft || calculateResponse.body.receiptDraft || {};
  const reviewItems = detail.reviewItems || calculateResponse.body.reviewItems || [];
  return {
    ...item,
    statusCode: calculateResponse.statusCode,
    feeSessionId: sessionId,
    status: feeSession.status,
    diagnoses: (feeSession.diagnoses || []).map((diagnosis) => diagnosis.name || diagnosis),
    calculationOptionsSource: feeSession.calculationOptionsSource || null,
    calculationOptionsAutoKeys: feeSession.calculationOptionsAutoKeys || [],
    progress: feeSession.calculationProgress || null,
    totalPoints: Number(calculationResult.totalPoints || receiptDraft.totalPoints || 0),
    lineItems: (calculationResult.lineItems || []).map((line) => ({
      code: line.code || "",
      name: line.name || "",
      category: line.orderType || line.category || "",
      status: line.status || "",
      points: Number(line.points || 0),
      totalPoints: Number(line.totalPoints || line.points || 0),
      reviewRequired: Boolean(line.reviewRequired || line.coverage?.reviewRequired)
    })),
    warnings: calculationResult.warnings || [],
    reviewItems: reviewItems.map((review) => ({
      title: review.title || review.name || "確認事項",
      message: review.message || review.reason || "",
      status: review.status || "",
      severity: review.severity || ""
    })),
    receiptDraft
  };
}

function request(stores, method, apiPath, body, headers = {}) {
  return handleFeeApiRequest({
    method,
    path: apiPath,
    body,
    headers,
    platformStore: stores.platformStore,
    feeStore: stores.feeStore,
    feeCalculator: stores.feeCalculator,
    env: "local",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: now,
    now,
    sessionSecret: "orca-eval-session-secret"
  });
}

function extractCodeBlockAfterHeading(text, headingPrefix, requiredText) {
  const headingIndex = text.indexOf(headingPrefix);
  if (headingIndex < 0) {
    throw new Error(`heading not found: ${headingPrefix}`);
  }
  const headingEnd = text.indexOf("\n", headingIndex);
  const headingLine = text.slice(headingIndex, headingEnd);
  if (requiredText && !headingLine.includes(requiredText)) {
    const nextIndex = text.indexOf(`${headingPrefix}`, headingEnd + 1);
    if (nextIndex >= 0) {
      return extractCodeBlockAfterHeading(text.slice(nextIndex), headingPrefix, requiredText);
    }
    throw new Error(`heading does not include ${requiredText}: ${headingLine}`);
  }
  const open = text.indexOf("```", headingEnd);
  const contentStart = text.indexOf("\n", open) + 1;
  const close = text.indexOf("```", contentStart);
  return text.slice(contentStart, close).trim();
}

function extractExpectedBlock(text, caseNumber) {
  const marker = `### 事例${caseNumber}`;
  const expectedStart = text.indexOf("## 各事例の算定明細");
  const headingIndex = text.indexOf(marker, expectedStart);
  if (headingIndex < 0) {
    return "";
  }
  const open = text.indexOf("```", headingIndex);
  const contentStart = text.indexOf("\n", open) + 1;
  const close = text.indexOf("```", contentStart);
  return text.slice(contentStart, close).trim();
}

function buildReport({ cases: evaluatedCases, results, durationMs }) {
  const lines = [];
  lines.push("# ORCA SOAP first 3 current-logic evaluation");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## 実行条件");
  lines.push("");
  lines.push("- 対象: `orca-karte-gold-11.md` のSOAP書き起こし版 事例1〜3");
  lines.push("- 入力: SOAP本文のみ。手入力オーダーなし");
  lines.push("- API経路: `handleFeeApiRequest` でFee APIのセッション作成→算定→詳細取得を実行");
  lines.push("- 算定エンジン: ローカルPython Fee calculator + `python/data/master/standard-master.sqlite`");
  lines.push(`- OpenAI構造化: ${process.env.OPENAI_API_KEY ? "有効（OPENAI_API_KEYあり）" : "無効（このシェルにOPENAI_API_KEYなし。rules_no_openai経路）"}`);
  lines.push("- 注意: ORCA期待明細は2016年ver 4.8.0基準。点数絶対値ではなく、抽出・候補化・除外の妥当性を主に見る");
  lines.push(`- 総実行時間: ${durationMs}ms`);
  lines.push("");
  lines.push("## サマリー");
  lines.push("");
  lines.push("| 事例 | 現行結果 | 点数 | 明細数 | 病名抽出 | 主な評価 |");
  lines.push("| --- | --- | ---: | ---: | --- | --- |");
  for (const result of results) {
    lines.push(`| ${result.caseNumber} | ${result.error ? `ERROR ${result.statusCode}` : result.status || "-"} | ${result.error ? "-" : String(result.totalPoints)} | ${result.error ? "-" : String(result.lineItems.length)} | ${result.error ? "-" : escapeTable((result.diagnoses || []).join(" / ") || "なし")} | ${escapeTable(summaryAssessment(result))} |`);
  }
  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.title}`);
    lines.push("");
    lines.push("### 期待明細（Docs抜粋）");
    lines.push("");
    lines.push("```text");
    lines.push(result.expected || "(なし)");
    lines.push("```");
    lines.push("");
    if (result.error) {
      lines.push("### 現行結果");
      lines.push("");
      lines.push(`- HTTP: ${result.statusCode}`);
      lines.push(`- Error: \`${JSON.stringify(result.error)}\``);
      lines.push("");
      continue;
    }
    lines.push("### 現行結果");
    lines.push("");
    lines.push(`- Status: ${result.status}`);
    lines.push(`- Total points: ${result.totalPoints}`);
    lines.push(`- Diagnoses: ${(result.diagnoses || []).join(" / ") || "なし"}`);
    lines.push(`- Calculation options source: ${result.calculationOptionsSource || "-"}`);
    lines.push(`- Auto keys: ${(result.calculationOptionsAutoKeys || []).join(", ") || "なし"}`);
    lines.push(`- Clinical structuring: ${clinicalStructuringSummary(result.progress?.metrics?.clinicalStructuring)}`);
    lines.push(`- Rule inference: ${ruleInferenceSummary(result.progress?.metrics?.ruleBasedClinicalInference)}`);
    lines.push("");
    lines.push("#### 算定候補");
    lines.push("");
    if (result.lineItems.length) {
      lines.push("| code | name | category | status | points | review |");
      lines.push("| --- | --- | --- | --- | ---: | --- |");
      for (const line of result.lineItems) {
        lines.push(`| ${line.code} | ${escapeTable(line.name)} | ${escapeTable(line.category)} | ${line.status} | ${line.totalPoints} | ${line.reviewRequired ? "要" : "任意"} |`);
      }
    } else {
      lines.push("- 算定行なし");
    }
    lines.push("");
    lines.push("#### レビュー/警告");
    lines.push("");
    for (const warning of compactStrings(result.warnings).slice(0, 20)) {
      lines.push(`- warning: ${warning}`);
    }
    for (const review of result.reviewItems.slice(0, 20)) {
      lines.push(`- ${review.title}: ${review.message}`);
    }
    lines.push("");
    lines.push("#### 評価メモ");
    lines.push("");
    for (const note of detailedAssessment(result)) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function summaryAssessment(result) {
  if (result.error) {
    return "算定APIがエラー";
  }
  if (result.caseNumber === 1) {
    return "骨折/創傷/画像/投薬の大半が落ち、単純X線と基本料中心";
  }
  if (result.caseNumber === 2) {
    return "ポリープ切除/病理/投薬/注射が落ち、尿検査・超音波・基本料中心";
  }
  if (result.caseNumber === 3) {
    return "喘息点滴/管理料/投薬の多くが落ち、検査と基本料中心";
  }
  return "";
}

function detailedAssessment(result) {
  if (result.error) {
    return ["算定APIが失敗しているため、抽出・算定以前の問題。"];
  }
  if (result.caseNumber === 1) {
    return [
      "Docs期待では初診、薬剤情報提供、抗菌薬/鎮痛薬、ギプス、創傷処置、頭部/前腕X線が主要項目。",
      "現行結果は単純X線や基本料は一部候補化するが、ギプス、創傷処理、局麻/洗浄、処方薬の展開が不足。",
      "複数日SOAPを1診療日セッションに入れているため、再診回の創傷処置をどう分割するかも未定義。"
    ];
  }
  if (result.caseNumber === 2) {
    return [
      "Docs期待では初診時前処置薬、内視鏡的ポリープ切除、病理、再診時尿検査/血液検査/腹部超音波/注射/投薬が主要項目。",
      "現行結果は尿・血液検査や超音波を一部拾うが、内視鏡手術、病理、注射、薬剤の多くが候補化されない。",
      "保険変更や複数受診日の扱いは現行セッションモデルでは表現できていない。"
    ];
  }
  if (result.caseNumber === 3) {
    return [
      "Docs期待では再診、外来管理加算、特定疾患療養管理料、点滴注射、血液/生化学/CRP、判断料が主要項目。",
      "現行結果は初診料のみで、再診・検査・判断料・特定疾患療養管理料・点滴注射・処方薬が候補化されない。",
      "同一SOAP内の4/19〜4/21の複数再診を1算定に集約してしまうため、受診日単位の分割評価が必要。"
    ];
  }
  return [];
}

function clinicalStructuringSummary(metrics = null) {
  if (!metrics) return "-";
  return [
    `source=${metrics.source || "-"}`,
    `durationMs=${metrics.durationMs ?? "-"}`,
    `model=${metrics.model || "-"}`,
    `fallback=${metrics.fallbackReason || "-"}`
  ].join(" / ");
}

function ruleInferenceSummary(metrics = null) {
  if (!metrics) return "-";
  return [
    `source=${metrics.source || "-"}`,
    `durationMs=${metrics.durationMs ?? "-"}`,
    `masterLookupCount=${metrics.masterLookupCount ?? "-"}`
  ].join(" / ");
}

function compactStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function escapeTable(value) {
  return String(value || "").replace(/\|/gu, "\\|").replace(/\n/gu, "<br>");
}
