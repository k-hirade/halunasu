import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const extensionDir = path.resolve(here, "../extension");
const fixtureDir = path.resolve(here, "../mock/fixture");
const preparedFixture = prepareFixture();
const homisClientScript = readFileSync(path.join(preparedFixture.output, "static/homis.js"), "utf8");
const homisStyles = readFileSync(path.join(preparedFixture.output, "static/style.css"), "utf8");
const fixturePages = renderFixturePages(preparedFixture.output);
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  rmSync(preparedFixture.temporaryRoot, { recursive: true, force: true });
});

test("v6 preparation shifts fixture data without changing legacy DOM assets", () => {
  for (const relative of [
    "app.py",
    "data/schedule.py",
    "render.py",
    "requirements.txt",
    "run.sh",
    "static/homis.js",
    "static/style.css"
  ]) {
    assert.deepEqual(
      readFileSync(path.join(preparedFixture.output, relative)),
      readFileSync(path.join(fixtureDir, relative)),
      relative
    );
  }

  const preparedPatients = readFileSync(
    path.join(preparedFixture.output, "data/patients.py"),
    "utf8"
  );
  assert.match(preparedPatients, /^TARGET_YEAR = 2026$/mu);
  assert.match(preparedPatients, /^TARGET_MONTH = 7$/mu);
  assert.match(preparedPatients, /^PREV_YEAR = 2026$/mu);
  assert.match(preparedPatients, /^PREV_MONTH = 6$/mu);
  assert.doesNotMatch(preparedPatients, /^TARGET_YEAR = 2025$/mu);
  assert.doesNotMatch(preparedPatients, /["']2025-01["':]/u);

  assert.equal(fixturePages.length, 13);
  for (const fixture of fixturePages) {
    assert.equal(fixture.targetMonth, "2026-07", fixture.patientId);
    assert.ok(fixture.targetMonthVisitDates.length > 0, fixture.patientId);
    assert.ok(
      fixture.targetMonthVisitDates.every((value) => value.startsWith("2026-07-")),
      fixture.patientId
    );
    assert.doesNotMatch(fixture.detailHtml, /condition-management-list-status/u, fixture.patientId);
    assert.doesNotMatch(fixture.problemHtml, /problem-list-status/u, fixture.patientId);
    assert.doesNotMatch(fixture.planHtml, /encounter-history/u, fixture.patientId);
  }
});

test("v7 runtime crawls legacy DOM history without reading the action list", async () => {
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
    assert.ok(
      fixture.targetMonthVisitDates.includes(baselinePreview.serviceDate),
      `${fixture.patientId}: service date`
    );
    const baselinePrepared = await callContentScript(detailPage, {
      type: "halunasu:prepare-calculation",
      previewFingerprint: baselinePreview.previewFingerprint
    });
    assert.equal(baselinePrepared.ok, true, `${fixture.patientId}: baseline prepare`);
    assert.equal(
      baselinePrepared.sourceSurfaces.currentChart.raw.deviceManagementListCompleteness,
      "complete",
      fixture.patientId
    );
    assert.equal(
      baselinePrepared.sourceSurfaces.problems.raw.listCompleteness,
      "complete",
      fixture.patientId
    );
    assert.equal(baselinePrepared.sourceSurfaces.visitPlan.raw.basis, "encounter_history", fixture.patientId);
    assert.equal(
      baselinePrepared.sourceSurfaces.visitPlan.raw.listCompleteness,
      "complete",
      fixture.patientId
    );
    assert.equal(
      baselinePrepared.sourceSurfaces.visitPlan.raw.collectionMethod,
      "chart_navigation",
      fixture.patientId
    );
    assert.equal(baselinePrepared.sourceSurfaces.visitPlan.raw.traversalComplete, true, fixture.patientId);
    assert.equal(baselinePrepared.sourceSurfaces.visitPlan.raw.calendarReconciled, true, fixture.patientId);
    assert.equal(
      baselinePrepared.sourceSurfaces.visitPlan.raw.originalSourceRecordId,
      baselinePrepared.sourceRecordId,
      fixture.patientId
    );
    assert.equal(
      baselinePrepared.sourceSurfaces.visitPlan.raw.restoredSourceRecordId,
      baselinePrepared.sourceRecordId,
      fixture.patientId
    );
    assert.deepEqual(
      baselinePrepared.sourceSurfaces.visitPlan.raw.rows.map((row) => row.serviceDate),
      fixture.targetMonthVisitDates.slice().sort(),
      fixture.patientId
    );
    const baselineSourceInput = runtimeCalculationSourceInput(baselinePrepared);
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
        runtimeCalculationSourceInput(mutatedPrepared),
        baselineSourceInput,
        `${fixture.patientId}: mutation ${mutationIndex}`
      );
    }
    await detailPage.close();
  }
});

async function callContentScript(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    globalThis.__sidecarContentListener(payload, {}, resolve);
  }), message);
}

function runtimeCalculationSourceInput(prepared) {
  return {
    contractVersion: "v1",
    sourceSystem: "homis",
    externalPatientId: prepared.externalPatientId,
    sourceRecordId: prepared.sourceRecordId,
    sourceRecordDisplayId: prepared.sourceRecordDisplayId || undefined,
    serviceDate: prepared.serviceDate,
    receptionTime: prepared.receptionTime || undefined,
    setting: prepared.encounterType,
    encounterTypeSource: prepared.encounterTypeSource,
    sameBuilding: prepared.sameBuilding,
    sameBuildingSource: prepared.sameBuildingSource,
    singleBuildingPatientCount: prepared.singleBuildingPatientCount,
    residenceType: prepared.facilityResidence === true
      ? "facility"
      : prepared.privateResidence === true ? "private" : null,
    visitKind: prepared.visitKind,
    visitKindSource: prepared.visitKindSource,
    clinicalText: prepared.clinicalText,
    sourceSurfaces: stableSourceSurfaces(prepared.sourceSurfaces),
    extractionProof: stableExtractionProof(prepared.extractionProof)
  };
}

function stableSourceSurfaces(sourceSurfaces = {}) {
  return Object.fromEntries(Object.entries(sourceSurfaces).map(([name, surface]) => {
    const { observedAt: _observedAt, ...stableSurface } = surface;
    return [name, stableSurface];
  }));
}

function stableExtractionProof(extractionProof = {}) {
  const {
    extractedAt: _extractedAt,
    surfaceProofs = {},
    ...stableProof
  } = extractionProof;
  return {
    ...stableProof,
    surfaceProofs: Object.fromEntries(Object.entries(surfaceProofs).map(([name, proof]) => {
      const { observedAt: _observedAt, ...stableSurfaceProof } = proof;
      return [name, stableSurfaceProof];
    }))
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
    "        'targetMonth': month,",
    "        'targetMonthVisitDates': [f\"{month}-{visit['day']:02d}\" for visit in patient['visits'].get(month, [])],",
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
