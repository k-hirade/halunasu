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

test("result UI hides blocked candidates and shows points for every visible selection", async () => {
  const page = await openPanel(380);
  const result = await page.evaluate(() => {
    const included = document.querySelector("#line-candidates .candidate-row");
    const review = document.querySelector("#proposal-candidates .candidate-row");
    const exactSelection = [...document.querySelectorAll("#proposal-candidates .candidate-row")]
      .find((node) => node.querySelector(".candidate-name")?.textContent.startsWith("在宅患者訪問診療料（区分確定例）"));
    const selection = document.querySelector("#selection-candidates .candidate-row");
    const sixOptionSelection = [...document.querySelectorAll("#selection-candidates .candidate-row")]
      .find((node) => node.querySelector(".candidate-name")?.textContent === "特定疾患療養管理料");
    const blockedDetail = [...document.querySelectorAll("#detail-log .detail-log-row")]
      .find((node) => node.textContent.includes("算定要件が未確定です"));
    return {
      clinicalTextVisible: document.body.textContent.includes("非表示にすべき患者本文"),
      readStatus: document.querySelector("#preview-read-status").textContent,
      zoneHeadings: [...document.querySelectorAll("#result-section .result-group > h3")]
        .slice(0, 3)
        .map((node) => node.textContent),
      includedName: included.querySelector(".candidate-name").textContent,
      includedPoints: included.querySelector(".candidate-points").textContent,
      reviewName: review.querySelector(".candidate-name").textContent,
      exactSelectionName: exactSelection?.querySelector(".candidate-name")?.textContent,
      exactSelectionPoints: exactSelection?.querySelector(".candidate-points")?.textContent,
      exactSelectionQualifier: exactSelection?.querySelector(".candidate-qualifier")?.textContent || null,
      exactSelectionCode: exactSelection?.querySelector(".candidate-code")?.textContent,
      selectionPoints: selection.querySelector(".candidate-points").textContent,
      sixOptionSelectionPoints: sixOptionSelection?.querySelector(".candidate-points")?.textContent,
      blockedCandidateCount: document.querySelectorAll(".candidate-row.zone-blocked").length,
      blockedChecklistVisible: document.querySelector("#checklist")?.textContent.includes("算定要件が未確定です"),
      blockedDetailAudience: blockedDetail?.querySelector(".detail-log-audience")?.textContent,
      cardBadgeCount: document.querySelectorAll(".candidate-context-badge").length,
      cardCommentCount: document.querySelectorAll(".candidate-comment").length,
      decisionCount: document.querySelector("#decision-count").textContent,
      revision: document.querySelector("#revision-copy").textContent,
      diff: document.querySelector("#calculation-diff").textContent,
      filterChips: [...selection.querySelectorAll(".selection-filter-chip")].map((node) => node.textContent),
      optionLabels: [...selection.querySelectorAll(".selection-option-row > span:first-child")].map((node) => node.textContent),
      optionPoints: [...selection.querySelectorAll(".selection-option-row > strong")].map((node) => node.textContent),
      selectionRange: selection.querySelector(".selection-summary").textContent,
      rawCodeCandidateVisible: document.body.textContent.includes("900000001"),
      selectionStateLabelVisible: document.body.textContent.includes("要選択"),
      candidateCodeTag: included.querySelector(".candidate-code").tagName,
      candidateExternalLinkCount: document.querySelectorAll(".candidate-row a").length,
      checklistAttention: [...document.querySelectorAll("#checklist .checklist-row")]
        .map((node) => [...node.classList].find((name) => name.startsWith("attention-"))),
      detailAttention: [...document.querySelectorAll("#detail-log .detail-log-row")]
        .map((node) => [...node.classList].find((name) => name.startsWith("attention-"))),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  assert.equal(result.clinicalTextVisible, false);
  assert.match(result.readStatus, /^読取済み: SOAP 4項目・(?:たった今|\d+秒前)$/u);
  assert.deepEqual(result.zoneHeadings, ["算定案に含まれる", "要確認", "区分確認"]);
  assert.equal(result.includedName, "在宅患者訪問診療料");
  assert.equal(result.includedPoints, "890点");
  assert.equal(result.reviewName, "在宅データ提出加算");
  assert.equal(result.exactSelectionName, "在宅患者訪問診療料（区分確定例）（同一建物居住者）");
  assert.equal(result.exactSelectionPoints, "215点");
  assert.equal(result.exactSelectionQualifier, null);
  assert.equal(result.exactSelectionCode, "114030310");
  assert.equal(result.selectionPoints, "1,685〜3,225点（残り2区分）");
  assert.equal(result.blockedCandidateCount, 0);
  assert.equal(result.blockedChecklistVisible, false);
  assert.equal(result.blockedDetailAudience, "管理者向け");
  assert.equal(result.cardBadgeCount, 0);
  assert.equal(result.cardCommentCount, 0);
  assert.equal(result.decisionCount, "4件");
  assert.match(result.revision, /再計算 2回目/u);
  assert.equal(result.diff, "前回から: 候補+1/−1・点数±0");
  assert.deepEqual(result.filterChips, [
    "施設類型 ✓ 機能強化型在支診等・病床あり",
    "単一建物人数 ✓ 単一建物6名",
    "当月訪問回数 ✓ 当月4回訪問",
    "診療方法 ✓ 対面診療"
  ]);
  assert.deepEqual(result.optionLabels, ["難病等", "一般"]);
  assert.deepEqual(result.optionPoints, ["3,225点", "1,685点"]);
  assert.match(result.selectionRange, /1,685〜3,225点/u);
  assert.equal(result.sixOptionSelectionPoints, "147〜225点（残り6区分）");
  assert.equal(result.rawCodeCandidateVisible, false);
  assert.equal(result.selectionStateLabelVisible, false);
  assert.equal(result.candidateCodeTag, "SPAN");
  assert.equal(result.candidateExternalLinkCount, 0);
  assert.deepEqual(result.checklistAttention, ["attention-required", "attention-recommended"]);
  assert.deepEqual(result.detailAttention, ["attention-required", "attention-required", "attention-recommended", "attention-reference"]);
  assert.equal(result.horizontalOverflow, false);

  await page.click("#detail-log-button");
  assert.equal(await page.locator("#detail-log-section").isVisible(), true);
  assert.equal(await page.locator("#detail-log .detail-log-row").count(), 4);
  await page.click("#detail-log-back-button");
  assert.equal(await page.locator("#result-section").isVisible(), true);
  await page.close();
});

for (const width of [320, 380]) {
  test(`side panel does not overflow at ${width}px`, async () => {
    const page = await openPanel(width);
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      rows: [...document.querySelectorAll(".candidate-row, .selection-option-row")].map((node) => ({
        client: node.clientWidth,
        scroll: node.scrollWidth
      }))
    }));
    assert.equal(dimensions.document <= dimensions.viewport, true);
    assert.equal(dimensions.rows.every((row) => row.scroll <= row.client), true);
    await page.close();
  });
}

async function openPanel(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(panelHtml);
  await page.addStyleTag({ path: path.join(extensionDir, "sidepanel.css") });
  await page.evaluate(() => {
    const snapshot = {
      ok: true,
      externalPatientId: "1001",
      sourceRecordId: "1001-20260625-01",
      sourceRecordDisplayId: "10010625",
      serviceDate: "2026-06-25",
      clinicalText: "非表示にすべき患者本文",
      clinicalTextNodeCount: 4,
      extractedAt: new Date().toISOString(),
      encounterType: "home_visit",
      encounterTypeLabel: "定期",
      encounterTypeSource: "dom",
      sameBuilding: true,
      sameBuildingSource: "dom",
      singleBuildingPatientCount: 6,
      previewFingerprint: "preview-result-ui",
      extractionProof: { selectorContractVersion: "homis-mock-v4" }
    };
    const codeCandidates = Array.from({ length: 175 }, (_, index) => String(900000001 + index));
    globalThis.chrome = {
      runtime: { onMessage: { addListener() {} } },
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
            calculationRevision: 2,
            calculationDiff: {
              candidates: { addedCount: 1, removedCount: 1 },
              notices: { addedCount: 1, removedCount: 0 },
              pointDelta: 0
            },
            calculation: {
              estimatedTotalPoints: 890,
              decisionCandidateCount: 5,
              candidates: [
                {
                  candidateId: "visit",
                  sourceType: "calculated_line",
                  zone: "included",
                  code: "114030310",
                  display: { stem: "在宅患者訪問診療料", qualifier: "(1)1(同一建物居住者)" },
                  estimatedTotalPoints: 890,
                  badges: ["facility_rule"],
                  comments: [{ status: "generated", text: "カードには表示しない" }]
                },
                {
                  candidateId: "data-addon",
                  sourceType: "proposal",
                  zone: "review_required",
                  code: "114057970",
                  display: { stem: "在宅データ提出加算", qualifier: "(在医総管・施医総管)" },
                  estimatedTotalPoints: 50
                },
                {
                  candidateId: "management",
                  sourceType: "proposal",
                  zone: "selection_required",
                  code: null,
                  codeCandidates,
                  requiresSelection: true,
                  selectionResolution: "ambiguous",
                  display: { stem: "施設入居時等医学総合管理料", qualifier: "算定区分" },
                  selectionNarrowing: {
                    selectionResolution: "ambiguous",
                    remainingOptionCount: 2,
                    appliedFilters: [
                      { label: "施設類型", evidenceLabel: "機能強化型在支診等・病床あり" },
                      { label: "単一建物人数", evidenceLabel: "単一建物6名" },
                      { label: "当月訪問回数", evidenceLabel: "当月4回訪問" },
                      { label: "診療方法", evidenceLabel: "対面診療" }
                    ],
                    pointRange: { min: 1685, max: 3225 },
                    remainingOptions: [
                      { code: "114035610", qualifierLabel: "難病等", points: 3225, axisQuestion: "対象疾病等に該当しますか" },
                      { code: "114035910", qualifierLabel: "一般", points: 1685, axisQuestion: "対象疾病等に該当しますか" }
                    ]
                  }
                },
                {
                  candidateId: "exact-management",
                  sourceType: "proposal",
                  zone: "review_required",
                  code: null,
                  codeCandidates: ["114030310"],
                  requiresSelection: true,
                  selectionResolution: "exact",
                  billingEligibility: "review_required",
                  display: { stem: "在宅患者訪問診療料（区分確定例）", qualifier: "" },
                  selectionNarrowing: {
                    selectionResolution: "exact",
                    remainingOptionCount: 1,
                    pointRange: { min: 215, max: 215 },
                    appliedFilters: [],
                    remainingOptions: [
                      { code: "114030310", qualifierLabel: "同一建物居住者", points: 215, axisQuestion: "算定要件を確認してください" }
                    ]
                  }
                },
                {
                  candidateId: "six-option-management",
                  sourceType: "proposal",
                  zone: "selection_required",
                  code: null,
                  codeCandidates: ["113001810", "113001910", "113002010", "113034010", "113034110", "113034210"],
                  requiresSelection: true,
                  selectionResolution: "ambiguous",
                  display: { stem: "特定疾患療養管理料", qualifier: "算定区分" },
                  selectionNarrowing: {
                    selectionResolution: "ambiguous",
                    remainingOptionCount: 6,
                    pointRange: { min: 147, max: 225 },
                    appliedFilters: [],
                    remainingOptions: [
                      { code: "113001810", qualifierLabel: "区分1", points: 147 },
                      { code: "113001910", qualifierLabel: "区分2", points: 165 },
                      { code: "113002010", qualifierLabel: "区分3", points: 180 },
                      { code: "113034010", qualifierLabel: "区分4", points: 195 },
                      { code: "113034110", qualifierLabel: "区分5", points: 210 },
                      { code: "113034210", qualifierLabel: "区分6", points: 225 }
                    ]
                  }
                },
                {
                  candidateId: "sensor",
                  sourceType: "proposal",
                  sourceSubtype: "sensor_candidate",
                  zone: "blocked",
                  code: null,
                  display: {
                    stem: "未確認の行為xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                    qualifier: "マスター検索で確認"
                  },
                  adoptionBlocked: true,
                  estimatedTotalPoints: 0
                }
              ],
              notices: [
                { noticeId: "required", attentionLevel: "required", checklist: true, shortText: "必須確認", detailText: "必須の確認内容です。", audience: "clinician" },
                { noticeId: "blocked", candidateId: "sensor", badge: "adoption_blocked", attentionLevel: "required", checklist: true, shortText: "算定要件が未確定です", detailText: "算定要件が未確定です。", audience: "admin" },
                { noticeId: "recommended", attentionLevel: "recommended", checklist: true, shortText: "確認推奨", detailText: "推奨の確認内容です。", audience: "admin" },
                { noticeId: "reference", attentionLevel: "reference", checklist: false, shortText: "参考情報", detailText: "参考情報です。", audience: "clinician" }
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
  return page;
}
