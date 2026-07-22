import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "../extension");
const panelHtml = await readFile(path.join(extensionDir, "sidepanel.html"), "utf8");
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("automatic preview selects DOM-backed encounter details without calculating", async () => {
  const page = await browser.newPage();
  await page.setContent(panelHtml);
  await page.evaluate(() => {
    const listeners = {};
    const snapshot = {
      ok: true,
      externalPatientId: "1001",
      sourceRecordId: "1001-20260625-01",
      sourceRecordDisplayId: "10010625",
      serviceDate: "2026-06-25",
      receptionTime: "10:30",
      clinicalText: "S）安定。\nO）著変なし。",
      encounterType: "home_visit",
      encounterTypeLabel: "定期",
      encounterTypeSource: "dom",
      privateResidence: true,
      facilityResidence: false,
      singleBuildingPatientCount: null,
      sameBuilding: false,
      sameBuildingSource: "dom",
      previewFingerprint: "preview-1001",
      extractionProof: { selectorContractVersion: "homis-mock-v3" }
    };
    globalThis.__sidecarTest = { calculateCalls: [], listeners, snapshot };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener(listener) { listeners.runtime = listener; } }
      },
      tabs: {
        async query() { return [{ id: 1, active: true }]; },
        async sendMessage(_tabId, message) {
          return message.type === "halunasu:prepare-calculation"
            ? { ...snapshot, ok: true }
            : { ...snapshot };
        },
        onActivated: { addListener(listener) { listeners.activated = listener; } },
        onUpdated: { addListener(listener) { listeners.updated = listener; } }
      }
    };
    globalThis.HalunasuSidecarApi = {
      async connectWithStoredGrant() { return { connected: true }; },
      async calculate(payload) {
        globalThis.__sidecarTest.calculateCalls.push(payload);
        return {
          sidecarDraft: {
            sourceRevision: 1,
            calculation: { estimatedTotalPoints: 0, candidates: [], warnings: [], reviewIssues: [] }
          }
        };
      },
      async pollDeviceAuthorization() {},
      async startDeviceAuthorization() { throw new Error("not used"); }
    };
  });
  await page.addScriptTag({ path: path.join(extensionDir, "sidepanel.js") });
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1001");

  const automatic = await page.evaluate(() => ({
    encounter: document.querySelector('input[name="setting"]:checked')?.value,
    sameBuilding: document.querySelector('input[name="same-building"]:checked')?.value,
    encounterCopy: document.querySelector("#setting-copy").textContent,
    calculateCalls: globalThis.__sidecarTest.calculateCalls.length,
    calculateDisabled: document.querySelector("#calculate-button").disabled
  }));
  assert.deepEqual(automatic, {
    encounter: "home_visit",
    sameBuilding: "outside",
    encounterCopy: "画面の「診療記録 定期」から「定期訪問」を選択しました。",
    calculateCalls: 0,
    calculateDisabled: false
  });

  await page.click("#calculate-button");
  await page.waitForFunction(() => globalThis.__sidecarTest.calculateCalls.length === 1);
  const domPayload = await page.evaluate(() => globalThis.__sidecarTest.calculateCalls[0]);
  assert.equal(domPayload.setting, "home_visit");
  assert.equal(domPayload.encounterTypeSource, "dom");
  assert.equal(domPayload.sameBuilding, false);
  assert.equal(domPayload.sameBuildingSource, "dom");

  await page.click('input[name="setting"][value="outpatient"]');
  await page.click("#calculate-button");
  await page.waitForFunction(() => globalThis.__sidecarTest.calculateCalls.length === 2);
  const userPayload = await page.evaluate(() => globalThis.__sidecarTest.calculateCalls[1]);
  assert.equal(userPayload.setting, "outpatient");
  assert.equal(userPayload.encounterTypeSource, "user");

  await page.evaluate(() => {
    Object.assign(globalThis.__sidecarTest.snapshot, {
      externalPatientId: "1002",
      sourceRecordId: "1002-20260623-01",
      sourceRecordDisplayId: "10020623",
      serviceDate: "2026-06-23",
      encounterType: "house_call",
      encounterTypeLabel: "往診",
      encounterTypeSource: "dom",
      privateResidence: false,
      facilityResidence: true,
      singleBuildingPatientCount: 4,
      sameBuilding: true,
      sameBuildingSource: "dom",
      previewFingerprint: "preview-1002"
    });
    globalThis.__sidecarTest.listeners.runtime({
      type: "halunasu:chart-state-changed",
      available: true,
      patientId: "1002",
      sourceRecordId: "1002-20260623-01"
    }, { tab: { id: 1 } });
  });
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");
  const switched = await page.evaluate(() => ({
    encounter: document.querySelector('input[name="setting"]:checked')?.value,
    sameBuilding: document.querySelector('input[name="same-building"]:checked')?.value,
    calculateCalls: globalThis.__sidecarTest.calculateCalls.length,
    resultHidden: document.querySelector("#result-section").hidden
  }));
  assert.deepEqual(switched, {
    encounter: "house_call",
    sameBuilding: "same",
    calculateCalls: 2,
    resultHidden: true
  });

  await page.close();
});
