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

test("result UI keeps points, qualifiers, choices, and issues visible", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  await page.setContent(panelHtml);
  await page.addStyleTag({ path: path.join(extensionDir, "sidepanel.css") });
  await page.evaluate(() => {
    const snapshot = {
      ok: true,
      externalPatientId: "1001",
      sourceRecordId: "1001-20260625-01",
      sourceRecordDisplayId: "10010625",
      serviceDate: "2026-06-25",
      clinicalText: "S）安定。\nO）著変なし。",
      encounterType: "home_visit",
      encounterTypeLabel: "定期",
      encounterTypeSource: "dom",
      sameBuilding: false,
      sameBuildingSource: "dom",
      previewFingerprint: "preview-result-ui",
      extractionProof: { selectorContractVersion: "homis-mock-v3" }
    };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} }
      },
      tabs: {
        async query() { return [{ id: 1, active: true }]; },
        async sendMessage(_tabId, message) {
          return message.type === "halunasu:prepare-calculation"
            ? { ...snapshot, ok: true }
            : { ...snapshot };
        },
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} }
      }
    };
    globalThis.HalunasuSidecarApi = {
      async connectWithStoredGrant() { return { connected: true }; },
      async calculate() {
        return {
          sidecarDraft: {
            sourceRevision: 2,
            calculation: {
              estimatedTotalPoints: 969,
              candidates: [
                {
                  sourceType: "calculated_line",
                  code: "114001110",
                  name: "在宅患者訪問診療料（１）１（同一建物居住者以外）",
                  display: {
                    stem: "在宅患者訪問診療料",
                    qualifier: "(1)1(同一建物居住者以外)"
                  },
                  estimatedTotalPoints: 890
                },
                {
                  sourceType: "proposal",
                  code: "114057970",
                  name: "旧API形式の候補名",
                  estimatedTotalPoints: 50
                },
                {
                  sourceType: "proposal",
                  code: null,
                  codeCandidates: ["114003710", "114004110"],
                  requiresSelection: true,
                  name: "在宅酸素療法指導管理料の区分確認",
                  display: {
                    stem: "在宅酸素療法指導管理料",
                    qualifier: ""
                  },
                  estimatedTotalPoints: 0
                }
              ],
              warnings: ["施設基準を確認してください。"],
              reviewIssues: [
                { severity: "info", issueCode: "z_reference", messageForStaff: "参考情報です。" },
                { severity: "warning", issueCode: "b_requirement", messageForStaff: "算定要件を確認してください。" },
                { severity: "error", issueCode: "a_blocking", messageForStaff: "必須情報が不足しています。" }
              ]
            }
          }
        };
      },
      async pollDeviceAuthorization() {},
      async startDeviceAuthorization() { throw new Error("not used"); }
    };
  });
  await page.addScriptTag({ path: path.join(extensionDir, "sidepanel.js") });
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1001");
  await page.click("#calculate-button");
  await page.waitForFunction(() => document.querySelector("#result-section")?.hidden === false);

  const result = await page.evaluate(() => {
    const lineRow = document.querySelector("#line-candidates .candidate-row");
    const proposalRows = [...document.querySelectorAll("#proposal-candidates .candidate-row")];
    const selectionRow = document.querySelector("#proposal-candidates .requires-selection");
    const points = lineRow.querySelector(".candidate-points");
    const summaryBar = document.querySelector(".result-summary-bar");
    return {
      detailCount: document.querySelectorAll("details, summary").length,
      lineName: lineRow.querySelector(".candidate-name").textContent,
      lineMeta: lineRow.querySelector(".candidate-meta").textContent,
      lineChildCount: lineRow.children.length,
      fallbackName: proposalRows[0].querySelector(".candidate-name").textContent,
      selectionPoints: selectionRow.querySelector(".candidate-points").textContent,
      selectionMeta: selectionRow.querySelector(".candidate-meta").textContent,
      issueCount: document.querySelector("#issue-count").textContent,
      issues: [...document.querySelectorAll("#issues .issue-row")].map((row) => row.textContent),
      pointsWhiteSpace: getComputedStyle(points).whiteSpace,
      pointsTextAlign: getComputedStyle(points).textAlign,
      selectionBorderWidth: getComputedStyle(selectionRow).borderLeftWidth,
      stickyPosition: getComputedStyle(summaryBar).position
    };
  });

  assert.deepEqual(result, {
    detailCount: 0,
    lineName: "在宅患者訪問診療料",
    lineMeta: "(1)1(同一建物居住者以外)114001110",
    lineChildCount: 2,
    fallbackName: "旧API形式の候補名",
    selectionPoints: "要選択",
    selectionMeta: "2件から選択114003710 / 114004110",
    issueCount: "4件",
    issues: [
      "施設基準を確認してください。",
      "必須情報が不足しています。",
      "算定要件を確認してください。",
      "参考情報です。"
    ],
    pointsWhiteSpace: "nowrap",
    pointsTextAlign: "right",
    selectionBorderWidth: "4px",
    stickyPosition: "sticky"
  });

  await page.close();
});
