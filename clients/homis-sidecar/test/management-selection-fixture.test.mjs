import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { validateSidecarCalculationInput } from "../../../packages/fee-contracts/src/index.js";
import { narrowSidecarCandidateSelection } from "../../../services/fee-api/src/sidecar-selection-narrowing.js";
import { normalizeSidecarStructuredFacts } from "../../../services/fee-api/src/sidecar-structured-facts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const extensionDir = path.resolve(here, "../extension");
const fixtureDir = path.resolve(here, "../mock/fixture");
const preparedFixture = prepareFixture();
const homisClientScript = readFileSync(path.join(preparedFixture.output, "static/homis.js"), "utf8");
const homisStyles = readFileSync(path.join(preparedFixture.output, "static/style.css"), "utf8");
const selectionArtifact = JSON.parse(readFileSync(path.join(
  repositoryRoot,
  "services/fee-api/src/fee-rule-data/sidecar-selection-axes-2026.generated.json"
), "utf8"));
const candidateCodesByFamily = new Map(["在医総管", "施医総管"].map((familyName) => [
  familyName,
  selectionArtifact.options
    .filter((option) => option.familyName === familyName)
    .map((option) => option.code)
]));
const expectedCodes = new Map([
  ["1001", "114031010"],
  ["1002", "114035610"],
  ["1003", "114031310"],
  ["1004", "114035610"],
  ["1005", "114031310"],
  ["1006", "114030710"],
  ["1007", "114030710"],
  ["1008", "114031010"],
  ["1009", "114031010"],
  ["1010", "114035610"],
  ["1011", "114035610"],
  ["1012", "114031010"],
  ["1013", "114030710"]
]);
const fixturePages = renderFixturePages(preparedFixture.output);
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  rmSync(preparedFixture.temporaryRoot, { recursive: true, force: true });
});

test("visible fixture surfaces resolve all 13 management selections without action-list input", async () => {
  assert.equal(fixturePages.length, 13);
  const actualCodes = new Map();
  const metrics = {
    exactMatchCount: 0,
    wrongExactCount: 0,
    ambiguousCount: 0,
    contextIncompleteCount: 0,
    selectionExactMatchRate: 0,
    methodology: {
      actionListUsedAsCalculationInput: false
    }
  };

  for (const fixture of fixturePages) {
    const detailPage = await browser.newPage();
    await detailPage.route("http://fixture.local/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/static/homis.js")) {
        await route.fulfill({ contentType: "text/javascript", body: homisClientScript });
        return;
      }
      if (url.pathname.endsWith("/static/style.css")) {
        await route.fulfill({ contentType: "text/css", body: homisStyles });
        return;
      }
      const pageId = url.searchParams.get("pid") || "patient_detail";
      const html = pageId === "patient_problem"
        ? fixture.problemHtml
        : pageId === "docs_index"
          ? fixture.documentsHtml
          : pageId === "patient_plan0" ? fixture.planHtml : fixture.detailHtml;
      await route.fulfill({ contentType: "text/html", body: html });
    });
    const locationHref = `http://fixture.local/homic/?pid=patient_detail&patient_id=${fixture.patientId}`;
    await detailPage.goto(locationHref, { waitUntil: "domcontentloaded" });
    await detailPage.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
    await detailPage.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
    await detailPage.evaluate(() => {
      globalThis.__sidecarContentListener = null;
      globalThis.chrome = {
        runtime: {
          onMessage: {
            addListener(listener) {
              globalThis.__sidecarContentListener = listener;
            }
          },
          async sendMessage() {
            return {};
          }
        }
      };
    });
    await detailPage.addScriptTag({ path: path.join(extensionDir, "content.js") });
    const baselinePreview = await callContentScript(detailPage, { type: "halunasu:extract" });
    assert.equal(baselinePreview.ok, true, `${fixture.patientId}: baseline preview`);
    const baselinePrepared = await callContentScript(detailPage, {
      type: "halunasu:prepare-calculation",
      previewFingerprint: baselinePreview.previewFingerprint
    });
    assert.equal(baselinePrepared.ok, true, `${fixture.patientId}: baseline prepare`);
    const baseline = prepareSelection(baselinePrepared);
    for (const [mutationIndex, actionText] of [
      "MUTATED_GOLD_CODE 0点",
      "",
      "UNRELATED_RANDOM_TEXT_7f73c4"
    ].entries()) {
      await detailPage.evaluate((value) => {
        const actionList = document.querySelector("#action_list");
        if (actionList) actionList.textContent = value;
      }, actionText);
      const mutatedPreview = await callContentScript(detailPage, { type: "halunasu:extract" });
      assert.equal(mutatedPreview.ok, true, `${fixture.patientId}: mutation ${mutationIndex} preview`);
      const mutatedPrepared = await callContentScript(detailPage, {
        type: "halunasu:prepare-calculation",
        previewFingerprint: mutatedPreview.previewFingerprint
      });
      assert.equal(mutatedPrepared.ok, true, `${fixture.patientId}: mutation ${mutationIndex} prepare`);
      assert.equal(
        baselinePreview.previewFingerprint,
        mutatedPreview.previewFingerprint,
        `${fixture.patientId}: mutation ${mutationIndex}`
      );
      assert.deepEqual(
        baselinePrepared.sourceSurfaces.currentChart.raw,
        mutatedPrepared.sourceSurfaces.currentChart.raw,
        `${fixture.patientId}: mutation ${mutationIndex}`
      );
      const mutated = prepareSelection(mutatedPrepared);
      assert.deepEqual(
        mutated.revisionPayload,
        baseline.revisionPayload,
        `${fixture.patientId}: mutation ${mutationIndex}`
      );
      assert.equal(
        mutated.sourceRevisionHash,
        baseline.sourceRevisionHash,
        `${fixture.patientId}: mutation ${mutationIndex}`
      );
      assert.deepEqual(
        selectionWithoutObservationTimes(mutated.selection),
        selectionWithoutObservationTimes(baseline.selection),
        `${fixture.patientId}: mutation ${mutationIndex}`
      );
    }
    const visitPlan = baselinePrepared.sourceSurfaces.visitPlan;
    assert.equal(visitPlan.raw.basis, "encounter_history", fixture.patientId);
    assert.equal(visitPlan.raw.listCompleteness, "complete", fixture.patientId);
    assert.equal(visitPlan.raw.rows.length, fixture.targetMonthEncounterCount, fixture.patientId);
    assert.equal(new Set(visitPlan.raw.rows.map((row) => row.sourceRecordId)).size, visitPlan.raw.rows.length);
    await detailPage.close();

    const { selection } = baseline;
    if (selection.selectionResolution !== "exact") {
      metrics.ambiguousCount += selection.selectionResolution === "ambiguous" ? 1 : 0;
      metrics.contextIncompleteCount += 1;
    } else if (selection.remainingOptions[0]?.code === expectedCodes.get(fixture.patientId)) {
      metrics.exactMatchCount += 1;
    } else {
      metrics.wrongExactCount += 1;
    }
    assert.equal(selection.selectionResolution, "exact", fixture.patientId);
    assert.equal(selection.remainingOptionCount, 1, fixture.patientId);
    actualCodes.set(fixture.patientId, selection.remainingOptions[0].code);
  }

  metrics.selectionExactMatchRate = metrics.exactMatchCount / fixturePages.length;
  assert.deepEqual(actualCodes, expectedCodes);
  assert.deepEqual(metrics, {
    exactMatchCount: 13,
    wrongExactCount: 0,
    ambiguousCount: 0,
    contextIncompleteCount: 0,
    selectionExactMatchRate: 1,
    methodology: {
      actionListUsedAsCalculationInput: false
    }
  });
});

async function callContentScript(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    globalThis.__sidecarContentListener(payload, {}, resolve);
  }), message);
}

function prepareSelection(prepared) {
  const normalized = validateSidecarCalculationInput({
    contractVersion: "v1",
    facilityId: "fixture-facility",
    sourceSystem: "homis",
    externalPatientId: prepared.externalPatientId,
    sourceRecordId: prepared.sourceRecordId,
    sourceRecordDisplayId: prepared.sourceRecordDisplayId,
    serviceDate: prepared.serviceDate,
    receptionTime: prepared.receptionTime,
    setting: prepared.encounterType,
    encounterTypeSource: prepared.encounterTypeSource,
    sameBuilding: prepared.sameBuilding,
    sameBuildingSource: prepared.sameBuildingSource,
    singleBuildingPatientCount: prepared.singleBuildingPatientCount,
    residenceType: prepared.privateResidence ? "private" : "facility",
    visitKind: prepared.visitKind,
    visitKindSource: prepared.visitKindSource,
    clinicalText: prepared.clinicalText,
    sourceSurfaces: prepared.sourceSurfaces,
    extractionProof: prepared.extractionProof
  });
  const revisionPayload = calculationRevisionPayload(normalized);
  const sourceRevisionHash = createHash("sha256")
    .update(JSON.stringify(revisionPayload))
    .digest("hex");
  const structuredFacts = normalizeSidecarStructuredFacts({
    sourceSurfaces: normalized.sourceSurfaces,
    serviceDate: normalized.serviceDate,
    privateResidence: normalized.residenceType === "private",
    sameBuilding: normalized.sameBuilding,
    singleBuildingPatientCount: normalized.singleBuildingPatientCount,
    sourceRevisionHash,
    selectorContractVersion: normalized.extractionProof.selectorContractVersion
  });
  const family = normalized.residenceType === "private" ? "在医総管" : "施医総管";
  const selection = narrowSidecarCandidateSelection({
    requiresSelection: true,
    codeCandidates: candidateCodesByFamily.get(family)
  }, {
    facilityStandardKeys: ["3055", "3057"],
    setting: normalized.setting,
    selection: structuredFacts.selection
  });
  return { normalized, revisionPayload, sourceRevisionHash, structuredFacts, selection };
}

function calculationRevisionPayload(input) {
  return {
    contractVersion: input.contractVersion,
    selectorContractVersion: input.extractionProof.selectorContractVersion,
    serviceDate: input.serviceDate,
    receptionTime: input.receptionTime || null,
    setting: input.setting,
    encounterTypeSource: input.encounterTypeSource,
    sameBuilding: input.sameBuilding ?? null,
    sameBuildingSource: input.sameBuildingSource || null,
    singleBuildingPatientCount: input.singleBuildingPatientCount ?? null,
    residenceType: input.residenceType || null,
    visitKind: input.visitKind || null,
    visitKindSource: input.visitKindSource || null,
    telephoneEligibility: input.telephoneEligibility || null,
    clinicalText: input.clinicalText,
    orders: input.orders || [],
    diagnoses: input.diagnoses || [],
    sourceSurfaces: Object.fromEntries(
      ["currentChart", "documents", "problems", "visitPlan"]
        .filter((name) => input.sourceSurfaces?.[name])
        .map((name) => [name, {
          status: input.sourceSurfaces[name].status,
          patientId: input.sourceSurfaces[name].patientId,
          surfaceHash: input.sourceSurfaces[name].surfaceHash,
          unavailableReason: input.sourceSurfaces[name].unavailableReason || null
        }])
    )
  };
}

function selectionWithoutObservationTimes(selection) {
  return {
    ...selection,
    appliedFilters: selection.appliedFilters.map(({ observedAt: _observedAt, ...filter }) => filter)
  };
}

function prepareFixture() {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "halunasu-homis-v6-test-"));
  const output = path.join(temporaryRoot, "mock");
  try {
    execFileSync("python3", [
      path.join(repositoryRoot, "clients/homis-sidecar/mock/prepare_homis_mock_v6.py"),
      "--source", fixtureDir,
      "--output", output,
      "--target-month", "2026-07",
      "--apply"
    ], { encoding: "utf8" });
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return { temporaryRoot, output };
}

function renderFixturePages(preparedFixtureDir) {
  const script = [
    "import json",
    "from data.patients import PATIENTS, TARGET_MONTH, TARGET_YEAR",
    "from render import docs_page, patient_detail_page, plan_page, problem_page",
    "month = f'{TARGET_YEAR}-{TARGET_MONTH:02d}'",
    "payload = []",
    "for patient in PATIENTS:",
    "    payload.append({",
    "        'patientId': patient['id'],",
    "        'targetMonthEncounterCount': len(patient['visits'].get(month, [])),",
    "        'detailHtml': patient_detail_page(patient),",
    "        'problemHtml': problem_page(patient),",
    "        'documentsHtml': docs_page(patient),",
    "        'planHtml': plan_page(patient),",
    "    })",
    "print(json.dumps(payload, ensure_ascii=False))"
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script], {
    cwd: preparedFixtureDir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  }));
}
