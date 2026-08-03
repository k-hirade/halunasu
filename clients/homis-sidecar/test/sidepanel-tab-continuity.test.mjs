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

test("completed calculation is shown only after returning to its source chart", async () => {
  const page = await openPanel({ deferredCalculation: true });

  await page.click("#calculate-button");
  await page.waitForFunction(() => globalThis.__sidecarTest.calculationStarted === true);

  await activateTab(page, 2);
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");
  assert.equal(await page.isDisabled("#calculate-button"), true);
  await page.evaluate(() => globalThis.__sidecarTest.resolveCalculation());
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent.includes("元のカルテに戻る"));

  const otherChart = await page.evaluate(() => ({
    patientId: document.querySelector("#preview-patient")?.textContent,
    resultHidden: document.querySelector("#result-section")?.hidden,
    prepareTabIds: globalThis.__sidecarTest.prepareTabIds,
    calculationCalls: globalThis.__sidecarTest.calculationCalls
  }));
  assert.deepEqual(otherChart, {
    patientId: "1002",
    resultHidden: true,
    prepareTabIds: [1],
    calculationCalls: 1
  });

  await activateTab(page, 1);
  await page.waitForFunction(() => (
    document.querySelector("#preview-patient")?.textContent === "1001"
      && document.querySelector("#result-section")?.hidden === false
  ));
  assert.equal(await page.textContent("#total-points"), "777点");

  await page.close();
});

test("tab switch during prepare remains fail closed", async () => {
  const page = await openPanel({ deferredPreparation: true });

  await page.click("#calculate-button");
  await page.waitForFunction(() => globalThis.__sidecarTest.preparationStarted === true);
  await activateTab(page, 2);
  await page.evaluate(() => globalThis.__sidecarTest.resolvePreparation());
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");

  const state = await page.evaluate(() => ({
    calculationCalls: globalThis.__sidecarTest.calculationCalls,
    resultHidden: document.querySelector("#result-section")?.hidden
  }));
  assert.deepEqual(state, { calculationCalls: 0, resultHidden: true });

  await page.close();
});

test("patient charge save completed on another tab is restored with its source result", async () => {
  const page = await openPanel({ deferredPatientCharge: true });
  await page.click("#calculate-button");
  await page.waitForFunction(() => document.querySelector("#result-section")?.hidden === false);
  await page.selectOption("#patient-charge-handling", "charge");
  await page.click("#patient-charge-save");
  await page.waitForFunction(() => globalThis.__sidecarTest.patientChargeStarted === true);

  await activateTab(page, 2);
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");
  await page.evaluate(() => globalThis.__sidecarTest.resolvePatientCharge());
  await activateTab(page, 1);
  await page.waitForFunction(() => (
    document.querySelector("#preview-patient")?.textContent === "1001"
      && document.querySelector("#result-section")?.hidden === false
      && document.querySelector("#patient-charge-handling")?.value === "charge"
  ));
  assert.match(await page.textContent("#patient-charge-status"), /実費入力待ち/u);
  await page.close();
});

test("patient charge save cannot be submitted twice after switching back to its source tab", async () => {
  const page = await openPanel({ deferredPatientCharge: true });
  await page.click("#calculate-button");
  await page.waitForFunction(() => document.querySelector("#result-section")?.hidden === false);
  await page.selectOption("#patient-charge-handling", "charge");
  await page.click("#patient-charge-save");
  await page.waitForFunction(() => globalThis.__sidecarTest.patientChargeStarted === true);

  await activateTab(page, 2);
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");
  assert.equal(await page.isDisabled("#calculate-button"), true);
  await activateTab(page, 1);
  await page.waitForFunction(() => (
    document.querySelector("#preview-patient")?.textContent === "1001"
      && document.querySelector("#result-section")?.hidden === false
  ));
  assert.equal(await page.isDisabled("#patient-charge-save"), true);
  await page.evaluate(() => document.querySelector("#patient-charge-save")?.click());
  assert.equal(await page.evaluate(() => globalThis.__sidecarTest.patientChargeCalls), 1);

  await page.evaluate(() => globalThis.__sidecarTest.resolvePatientCharge());
  await page.waitForFunction(() => (
    document.querySelector("#patient-charge-handling")?.value === "charge"
      && document.querySelector("#patient-charge-save")?.textContent === "保存"
  ));
  assert.match(await page.textContent("#patient-charge-status"), /実費入力待ち/u);
  assert.equal(await page.evaluate(() => globalThis.__sidecarTest.patientChargeCalls), 1);
  await page.close();
});

test("completed calculation restores the manual input snapshot on its source chart", async () => {
  const page = await openPanel({ deferredCalculation: true });
  await page.click('input[name="setting"][value="telephone_revisit"]');
  await page.selectOption("#telephone-patient-initiated", "true");
  await page.selectOption("#telephone-instruction-given", "true");
  await page.selectOption("#telephone-scheduled-management", "false");
  await page.click('input[name="same-building"][value="same"]');

  await page.click("#calculate-button");
  await page.waitForFunction(() => globalThis.__sidecarTest.calculationStarted === true);
  await activateTab(page, 2);
  await page.evaluate(() => globalThis.__sidecarTest.resolveCalculation());
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");
  await activateTab(page, 1);
  await page.waitForFunction(() => document.querySelector("#result-section")?.hidden === false);

  const state = await page.evaluate(() => ({
    setting: document.querySelector('input[name="setting"]:checked')?.value,
    sameBuilding: document.querySelector('input[name="same-building"]:checked')?.value,
    patientInitiated: document.querySelector("#telephone-patient-initiated")?.value,
    instructionGiven: document.querySelector("#telephone-instruction-given")?.value,
    scheduledManagement: document.querySelector("#telephone-scheduled-management")?.value,
    input: globalThis.__sidecarTest.calculationInputs[0]
  }));
  assert.equal(state.setting, "telephone_revisit");
  assert.equal(state.sameBuilding, "same");
  assert.equal(state.patientInitiated, "true");
  assert.equal(state.instructionGiven, "true");
  assert.equal(state.scheduledManagement, "false");
  assert.equal(state.input.setting, "outpatient");
  assert.equal(state.input.visitKind, "telephone_revisit");
  assert.equal(state.input.sameBuilding, true);
  assert.deepEqual(state.input.telephoneEligibility, {
    establishedPatient: null,
    patientInitiated: true,
    instructionGiven: true,
    scheduledManagement: false
  });
  await page.close();
});

test("completed results for two patients remain restorable independently", async () => {
  const page = await openPanel();
  await page.click("#calculate-button");
  await page.waitForFunction(() => document.querySelector("#total-points")?.textContent === "777点");

  await activateTab(page, 2);
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");
  await page.click("#calculate-button");
  await page.waitForFunction(() => document.querySelector("#total-points")?.textContent === "888点");

  await activateTab(page, 1);
  await page.waitForFunction(() => (
    document.querySelector("#preview-patient")?.textContent === "1001"
      && document.querySelector("#total-points")?.textContent === "777点"
  ));
  await activateTab(page, 2);
  await page.waitForFunction(() => (
    document.querySelector("#preview-patient")?.textContent === "1002"
      && document.querySelector("#total-points")?.textContent === "888点"
  ));
  assert.equal(await page.evaluate(() => globalThis.__sidecarTest.calculationCalls), 2);
  await page.close();
});

test("patient charge failure on another tab is shown after returning to its source chart", async () => {
  const page = await openPanel({ deferredPatientCharge: true, patientChargeFailure: true });
  await page.click("#calculate-button");
  await page.waitForFunction(() => document.querySelector("#result-section")?.hidden === false);
  await page.selectOption("#patient-charge-handling", "charge");
  await page.click("#patient-charge-save");
  await page.waitForFunction(() => globalThis.__sidecarTest.patientChargeStarted === true);

  await activateTab(page, 2);
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1002");
  await page.evaluate(() => globalThis.__sidecarTest.resolvePatientCharge());
  await activateTab(page, 1);
  await page.waitForFunction(() => document.querySelector("#patient-charge-status")?.classList.contains("is-error"));
  assert.equal(await page.textContent("#patient-charge-status"), "患者別設定を保存できませんでした。");
  assert.equal(await page.inputValue("#patient-charge-handling"), "unknown");
  await page.close();
});

test("calculation response identity mismatch is rejected without rendering", async () => {
  const page = await openPanel({ mismatchedCalculationIdentity: true });
  await page.click("#calculate-button");
  await page.waitForFunction(() => (
    document.querySelector("#status-message")?.textContent.includes("算定結果の患者またはカルテが一致しません")
  ));
  assert.equal(await page.isHidden("#result-section"), true);
  await page.close();
});

test("active tab is rechecked after prepare before calling Fee API", async () => {
  const page = await openPanel({ deferredPreparation: true });

  await page.click("#calculate-button");
  await page.waitForFunction(() => globalThis.__sidecarTest.preparationStarted === true);
  await page.evaluate(() => {
    globalThis.__sidecarTest.activeTabId = 2;
    globalThis.__sidecarTest.resolvePreparation();
  });
  await page.waitForFunction(() => document.querySelector("#calculate-button")?.textContent === "算定案を作成");
  const result = await page.evaluate(() => ({
    calculationCalls: globalThis.__sidecarTest.calculationCalls,
    status: document.querySelector("#status-message")?.textContent
  }));
  assert.equal(result.calculationCalls, 0);
  assert.equal(result.status, "カルテが切り替わりました。画面を再読み取りしてください。");
  await page.close();
});

async function openPanel(options = {}) {
  const page = await browser.newPage();
  await page.setContent(panelHtml);
  await page.evaluate(({
    deferredCalculation,
    deferredPreparation,
    deferredPatientCharge,
    patientChargeFailure,
    mismatchedCalculationIdentity
  }) => {
    const snapshots = {
      1: chartSnapshot({
        externalPatientId: "1001",
        sourceRecordId: "1001-20260625-01",
        sourceRecordDisplayId: "10010625",
        serviceDate: "2026-06-25",
        previewFingerprint: "preview-1001"
      }),
      2: chartSnapshot({
        externalPatientId: "1002",
        sourceRecordId: "1002-20260623-01",
        sourceRecordDisplayId: "10020623",
        serviceDate: "2026-06-23",
        previewFingerprint: "preview-1002"
      })
    };
    const state = {
      activeTabId: 1,
      calculationCalls: 0,
      calculationInputs: [],
      calculationStarted: false,
      preparationStarted: false,
      patientChargeStarted: false,
      patientChargeCalls: 0,
      prepareTabIds: [],
      listeners: {},
      resolveCalculation: null,
      resolvePreparation: null,
      resolvePatientCharge: null
    };
    globalThis.__sidecarTest = state;
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener(listener) { state.listeners.runtime = listener; } }
      },
      tabs: {
        async query() { return [{ id: state.activeTabId, active: true }]; },
        async sendMessage(tabId, message) {
          const snapshot = snapshots[tabId];
          if (message.type !== "halunasu:prepare-calculation") {
            return { ...snapshot };
          }
          state.prepareTabIds.push(tabId);
          state.preparationStarted = true;
          if (deferredPreparation) {
            await new Promise((resolve) => { state.resolvePreparation = resolve; });
          }
          return { ...snapshot, ok: true };
        },
        onActivated: { addListener(listener) { state.listeners.activated = listener; } },
        onUpdated: { addListener(listener) { state.listeners.updated = listener; } }
      }
    };
    globalThis.HalunasuSidecarApi = {
      async connectWithStoredGrant() { return { connected: true }; },
      async calculate(payload) {
        state.calculationCalls += 1;
        state.calculationInputs.push(structuredClone(payload));
        state.calculationStarted = true;
        if (deferredCalculation) {
          await new Promise((resolve) => { state.resolveCalculation = resolve; });
        }
        const patientId = mismatchedCalculationIdentity ? "9999" : payload.externalPatientId;
        const points = payload.externalPatientId === "1002" ? 888 : 777;
        return {
          sidecarDraft: {
            sidecarDraftId: payload.externalPatientId === "1002"
              ? "sidecar-tab-continuity-1002"
              : "sidecar-tab-continuity",
            externalPatientId: patientId,
            sourceRecordId: payload.sourceRecordId,
            serviceDate: payload.serviceDate,
            lifecycleStatus: "draft",
            sourceRevision: 1,
            calculationRevision: 1,
            patientCharges: [{
              chargeType: "home_medical_transport",
              status: "pending",
              handling: null,
              billingHandling: "unknown",
              revision: 0,
              writable: true,
              unavailableReason: "setting_not_configured"
            }],
            calculation: { estimatedTotalPoints: points, candidates: [], notices: [] }
          }
        };
      },
      async setPatientChargeSetting(input) {
        state.patientChargeStarted = true;
        state.patientChargeCalls += 1;
        if (deferredPatientCharge) {
          await new Promise((resolve) => { state.resolvePatientCharge = resolve; });
        }
        if (patientChargeFailure) {
          const error = new Error("患者別設定を保存できませんでした。");
          error.status = 500;
          throw error;
        }
        return {
          contractVersion: "v1",
          changed: true,
          sidecarDraft: {
            sidecarDraftId: "sidecar-tab-continuity",
            externalPatientId: "1001",
            sourceRecordId: "1001-20260625-01",
            serviceDate: "2026-06-25",
            lifecycleStatus: "draft",
            sourceRevision: 1,
            calculationRevision: 1,
            patientCharges: [{
              chargeType: "home_medical_transport",
              status: "configured",
              handling: input.handling,
              billingHandling: input.handling,
              revision: 1,
              writable: true,
              unavailableReason: null
            }],
            calculation: { estimatedTotalPoints: 777, candidates: [], notices: [] }
          }
        };
      },
      async clearGrant() {},
      async pollDeviceAuthorization() {},
      async startDeviceAuthorization() { throw new Error("not used"); }
    };

    function chartSnapshot(overrides) {
      return {
        ok: true,
        clinicalText: "S）安定。\nO）著変なし。",
        clinicalTextNodeCount: 2,
        extractedAt: new Date().toISOString(),
        encounterType: "home_visit",
        encounterTypeLabel: "定期",
        encounterTypeSource: "dom",
        visitKind: null,
        visitKindSource: null,
        privateResidence: true,
        facilityResidence: false,
        singleBuildingPatientCount: null,
        sameBuilding: false,
        sameBuildingSource: "dom",
        sourceSurfaces: {},
        extractionProof: { selectorContractVersion: "homis-mock-v5" },
        ...overrides
      };
    }
  }, options);
  await page.addScriptTag({ path: path.join(extensionDir, "sidepanel.js") });
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1001");
  return page;
}

async function activateTab(page, tabId) {
  await page.evaluate((nextTabId) => {
    globalThis.__sidecarTest.activeTabId = nextTabId;
    globalThis.__sidecarTest.listeners.activated({ tabId: nextTabId });
  }, tabId);
}
