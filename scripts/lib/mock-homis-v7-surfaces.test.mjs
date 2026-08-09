import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalSidecarSurfaceJson,
  sidecarSurfaceIntegrityPayload,
  validateSidecarCalculationInput
} from "../../packages/fee-contracts/src/index.js";
import { normalizeSidecarStructuredFacts } from "../../services/fee-api/src/sidecar-structured-facts.js";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mockRoot = path.join(root, "tmp/mock_homis");
const OBSERVED_AT = "2026-08-06T00:00:00.000Z";

function exportCases(claimMonth) {
  const stdout = execFileSync("python3", [
    path.join(root, "scripts/export_mock_homis_evaluation_cases.py"),
    "--mock-root", mockRoot,
    "--claim-month", claimMonth
  ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// サーバの整合検査と同じ共有実装で封印する。
function sealSurface(surface) {
  const payload = {
    status: surface.status,
    patientId: surface.patientId,
    raw: surface.raw || {}
  };
  return {
    ...payload,
    observedAt: OBSERVED_AT,
    surfaceHash: `sha256-${crypto
      .createHash("sha256")
      .update(canonicalSidecarSurfaceJson(sidecarSurfaceIntegrityPayload(payload)))
      .digest("base64url")}`
  };
}

function buildRequest(item) {
  const surfaces = Object.fromEntries(
    ["currentChart", "documents", "problems", "visitPlan"].map((name) => [
      name,
      sealSurface({ status: "ok", patientId: item.patientId, raw: item.sourceSurfaceRaw[name] })
    ])
  );
  return validateSidecarCalculationInput({
    facilityId: "fac_test",
    sourceSystem: "homis",
    externalPatientId: item.patientId,
    patientAgeYears: item.patientAgeYears,
    sourceRecordId: item.sourceRecordId,
    sourceRecordDisplayId: item.sourceRecordDisplayId,
    serviceDate: item.serviceDate,
    receptionTime: item.receptionTime,
    setting: item.setting,
    encounterTypeSource: "dom",
    sameBuilding: item.sameBuilding,
    sameBuildingSource: "dom",
    singleBuildingPatientCount: item.singleBuildingPatientCount,
    residenceType: item.residenceType,
    clinicalText: item.clinicalText,
    orders: [],
    diagnoses: item.diagnoses,
    sourceSurfaces: surfaces,
    extractionProof: {
      patientIdBefore: item.patientId,
      patientIdAfter: item.patientId,
      sourceRecordIdBefore: item.sourceRecordId,
      sourceRecordIdAfter: item.sourceRecordId,
      selectorContractVersion: "homis-mock-v7",
      extractedAt: OBSERVED_AT,
      domMutationDetected: false,
      contractValidationPassed: true,
      previewMatched: true,
      requiredElementCount: 7,
      matchedRequiredElementCount: 7,
      clinicalTextNodeCount: 4,
      surfaceProofs: Object.fromEntries(Object.entries(surfaces).map(([name, surface]) => [name, {
        status: surface.status,
        patientId: surface.patientId,
        observedAt: surface.observedAt,
        surfaceHash: surface.surfaceHash
      }]))
    }
  });
}

test("exported mock cases satisfy the v7 source surface contract", { skip: !existsSync(mockRoot) }, () => {
  const dataset = exportCases("2026-07");
  assert.equal(dataset.schemaVersion, "mock-homis-act-coverage-cases-v2");
  // 合成であることを証跡に残さないと、実機の走査結果と取り違える。
  assert.equal(dataset.visitPlanSurfaceSynthesized, true);
  assert.equal(dataset.cases.length > 0, true);

  for (const item of dataset.cases) {
    const request = buildRequest(item);
    assert.deepEqual(
      Object.keys(request.sourceSurfaces).sort(),
      ["currentChart", "documents", "problems", "visitPlan"]
    );
    assert.equal(Number.isInteger(request.patientAgeYears), true, `${item.caseId} has no age`);
  }
});

test("v7 surfaces resolve the axes that blocked the C002 selection", { skip: !existsSync(mockRoot) }, () => {
  const dataset = exportCases("2026-07");
  const item = dataset.cases.filter((entry) => entry.patientId === "1006").at(-1);
  const request = buildRequest(item);
  const facts = normalizeSidecarStructuredFacts({
    sourceSurfaces: request.sourceSurfaces,
    serviceDate: request.serviceDate,
    selectorContractVersion: "homis-mock-v7",
    sourceRevisionHash: "a".repeat(64),
    observedAt: OBSERVED_AT,
    privateResidence: request.residenceType === "private",
    sameBuilding: request.sameBuilding,
    singleBuildingPatientCount: request.singleBuildingPatientCount
  });

  assert.deepEqual(
    Object.fromEntries(Object.entries(facts.sourceStatus).map(([name, value]) => [name, value.status])),
    { currentChart: "known", documents: "known", problems: "known", visitPlan: "known" }
  );
  // 当月訪問回数と疾病等区分が、在医総管・施医総管の区分を確定させる2軸。
  assert.equal(facts.selection.qualifyingMonthlyVisits.status, "complete");
  assert.equal(facts.selection.qualifyingMonthlyVisits.value, 4);
  assert.equal(facts.selection.specialDisease.status, "known");
  assert.equal(facts.selection.specialDisease.value, "eligible");
  assert.equal(facts.problems.listCompleteness, "complete");
});

test("the evaluator seals surfaces with the same implementation the server verifies", { skip: !existsSync(mockRoot) }, async () => {
  // v5 では整合検査が走らないため、封印方法の食い違いは v7 に切り替えた瞬間に
  // 全ケース HTTP 400 になる。実装の共有をテストで固定する。
  const evaluatorSource = await readFile(
    path.join(root, "scripts/evaluate_fee_mock_act_coverage.mjs"),
    "utf8"
  );
  assert.match(evaluatorSource, /canonicalSidecarSurfaceJson\(sidecarSurfaceIntegrityPayload\(/u);
  const serverSource = await readFile(
    path.join(root, "services/fee-api/src/server.js"),
    "utf8"
  );
  assert.match(serverSource, /canonicalSidecarSurfaceJson\(sidecarSurfaceIntegrityPayload\(surface\)\)/u);
  // どちらも独自の正規化関数を持っていないこと。
  assert.doesNotMatch(evaluatorSource, /function canonicalSurfaceValue/u);
  assert.doesNotMatch(serverSource, /function canonicalSidecarSurfaceValue/u);

  const dataset = exportCases("2026-07");
  const request = buildRequest(dataset.cases[0]);
  for (const [name, surface] of Object.entries(request.sourceSurfaces)) {
    const expected = `sha256-${crypto
      .createHash("sha256")
      .update(canonicalSidecarSurfaceJson(sidecarSurfaceIntegrityPayload(surface)))
      .digest("base64url")}`;
    assert.equal(surface.surfaceHash, expected, `${name} surfaceHash mismatch`);
  }
});
