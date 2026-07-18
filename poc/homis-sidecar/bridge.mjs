#!/usr/bin/env node
// HOMIS サイドカーPoC ローカルブリッジ。
//
// 実 fee-api のリクエストハンドラを、インメモリstore + 実Python算定エンジン(ローカル完全マスタ)で
// そのまま動かし、拡張機能向けに単純化した1エンドポイントを公開する。
//   POST /poc/calculate { externalPatientId, patientLabel?, serviceDate, receptionTime?, setting, clinicalText }
// 認証はローカル署名セッション(テストハーネスと同方式)で内部的に付与する。
//
// セキュリティ前提(PoC限定):
// - 127.0.0.1 バインドのみ。実患者データを扱わない(mock_homis専用)。
// - OPENAI_API_KEY があればLLM抽出、無ければルール抽出のみで動く。
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from "../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../services/platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../services/platform-api/src/store/memory-store.js";
import { handleFeeApiRequest } from "../../services/fee-api/src/server.js";
import { MemoryFeeStore } from "../../services/fee-api/src/store/memory-store.js";
import { PythonFeeCalculator } from "../../services/fee-api/src/python-calculator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.HOMIS_POC_BRIDGE_PORT || 8901);
const SESSION_SECRET = "homis-poc-local-secret";
const masterDbPath = process.env.FEE_MASTER_DB_PATH
  || path.join(repoRoot, "python/data/master/standard-master.sqlite");

const platformStore = new MemoryPlatformStore({});
const feeStore = new MemoryFeeStore({});
const feeCalculator = new PythonFeeCalculator({ masterDbPath, workerMode: false });

// 外部患者ID(HOMISのpatient_id) -> halunasu patientId
const patientIdByExternalId = new Map();

function authHeaders() {
  let identity = platformStore.getLoginIdentity("clinic", "admin@example.com");
  if (identity?.mfaRequired && !identity.mfaEnrolled) {
    const pending = platformStore.beginMfaEnrollment(identity, "MZXW6YTBOI======");
    identity = platformStore.completeMfaEnrollment(pending);
  }
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: ["org_admin"],
    productRoles: { fee: ["admin"] },
    mfaRequired: Boolean(identity.mfaRequired),
    mfaEnrolled: Boolean(identity.mfaEnrolled),
    mfaVerified: Boolean(identity.mfaRequired && identity.mfaEnrolled),
    csrfToken: "csrf_poc"
  }, { now: new Date(), sessionSecret: SESSION_SECRET });
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken
  };
}

function feeApi(method, apiPath, body, headers) {
  return handleFeeApiRequest({
    method,
    path: apiPath,
    body,
    headers,
    platformStore,
    feeStore,
    feeCalculator,
    env: "test",
    openAiApiKey: process.env.OPENAI_API_KEY || undefined,
    projectId: "homis-poc-local",
    region: "local",
    startedAt: new Date(),
    now: new Date(),
    sessionSecret: SESSION_SECRET
  });
}

async function ensurePatient(externalPatientId, patientLabel, headers) {
  const known = patientIdByExternalId.get(externalPatientId);
  if (known) {
    return known;
  }
  const response = await feeApi("POST", "/v1/fee/patients", {
    // 実名は扱わない(PoC/本番方針とも)。外部IDベースの表示名にする。
    displayName: patientLabel || `HOMIS患者 ${externalPatientId}`,
    externalPatientIds: [String(externalPatientId)]
  }, headers);
  if (response.statusCode !== 201) {
    throw new Error(`patient create failed: ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  const patientId = response.body.patient.patientId;
  patientIdByExternalId.set(externalPatientId, patientId);
  return patientId;
}

function summarizeCalculation(calculationResult = {}, feeSession = {}) {
  const lines = (calculationResult.lineItems || []).map((line) => ({
    code: line.code || "",
    name: line.name || "",
    points: Number(line.points || 0),
    quantity: Number(line.quantity || 1),
    totalPoints: Number(line.totalPoints || 0),
    status: line.status || "",
    excludedFromTotal: Boolean(line.excludedFromTotal),
    reason: String(line.reason || "").slice(0, 120)
  }));
  const proposals = (calculationResult.candidateProposals || []).map((proposal) => ({
    title: proposal.title || "",
    code: proposal.code || null,
    codeCandidates: Array.isArray(proposal.codeCandidates) ? proposal.codeCandidates : [],
    potentialPoints: Number(proposal.potentialPoints || 0),
    reason: String(proposal.reason || "").slice(0, 160)
  }));
  return {
    feeSessionId: feeSession.feeSessionId || null,
    serviceDate: feeSession.serviceDate || null,
    totalPoints: Number(calculationResult.totalPoints || 0),
    extractionSource: calculationResult.clinicalExtraction?.source || null,
    promptVersion: calculationResult.clinicalExtraction?.promptVersion || null,
    lines,
    candidateProposals: proposals,
    warnings: (calculationResult.warnings || []).slice(0, 20)
  };
}

async function handleCalculate(payload) {
  const externalPatientId = String(payload.externalPatientId || "").trim();
  const clinicalText = String(payload.clinicalText || "").trim();
  const serviceDate = String(payload.serviceDate || "").trim();
  if (!externalPatientId || !clinicalText || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    return { statusCode: 400, body: { error: "externalPatientId, clinicalText, serviceDate(YYYY-MM-DD) are required" } };
  }
  const headers = authHeaders();
  const patientId = await ensurePatient(externalPatientId, payload.patientLabel, headers);
  const sessionResponse = await feeApi("POST", "/v1/fee/sessions", {
    patientId,
    facilityId: "homis_poc",
    serviceDate,
    setting: payload.setting || "home_visit",
    ...(payload.receptionTime ? { receptionTime: payload.receptionTime } : {}),
    clinicalText
  }, headers);
  if (sessionResponse.statusCode !== 201) {
    return { statusCode: 502, body: { error: "session create failed", detail: sessionResponse.body } };
  }
  const feeSession = sessionResponse.body.feeSession;
  const calcResponse = await feeApi(
    "POST",
    `/v1/fee/sessions/${feeSession.feeSessionId}/calculate`,
    {},
    headers
  );
  if (calcResponse.statusCode !== 201) {
    return { statusCode: 502, body: { error: "calculation failed", detail: calcResponse.body } };
  }
  return {
    statusCode: 200,
    body: summarizeCalculation(calcResponse.body.calculationResult, feeSession)
  };
}

function withCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  withCors(res, origin);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && req.url === "/poc/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", masterDbPath, openAi: Boolean(process.env.OPENAI_API_KEY) }));
    return;
  }
  if (req.method === "POST" && req.url === "/poc/calculate") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(raw || "{}");
        const result = await handleCalculate(payload);
        res.writeHead(result.statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[homis-poc-bridge] http://127.0.0.1:${PORT} (master: ${masterDbPath})`);
  console.log(`[homis-poc-bridge] OpenAI抽出: ${process.env.OPENAI_API_KEY ? "有効" : "無効(ルール抽出のみ)"}`);
});
