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

test("result UI renders review and selection candidates as compact decision rows", async () => {
  const page = await openPanel(380);
  const result = await page.evaluate(() => {
    const included = document.querySelector("#line-candidates .candidate-row");
    const includedNames = [...document.querySelectorAll("#line-candidates .candidate-row .candidate-name")]
      .map((node) => node.textContent);
    const decisionRows = [...document.querySelectorAll("#decision-candidates .decision-row")];
    const decision = (candidateName) => decisionRows.find((node) => (
      node.querySelector(".decision-name")?.textContent === candidateName
    ));
    const management = decision("施設入居時等医学総合管理料");
    const exactSelection = decision("在宅患者訪問診療料（区分確定例）（同一建物居住者）");
    const sixOptionSelection = decision("特定疾患療養管理料");
    return {
      clinicalTextVisible: document.body.textContent.includes("非表示にすべき患者本文"),
      readStatus: document.querySelector("#preview-read-status").textContent,
      zoneHeadings: [...document.querySelectorAll("#result-section .result-group > h3")]
        .map((node) => node.textContent),
      includedName: included.querySelector(".candidate-name").textContent,
      includedPoints: included.querySelector(".candidate-points").textContent,
      includedNames,
      decisionRowCount: decisionRows.length,
      decisionListRole: document.querySelector("#decision-candidates")?.getAttribute("role"),
      decisionListLabelledBy: document.querySelector("#decision-candidates")?.getAttribute("aria-labelledby"),
      decisionKinds: decisionRows.map((node) => node.querySelector(".decision-kind")?.textContent),
      decisionIds: decisionRows.map((node) => node.dataset.candidateId),
      decisionZones: decisionRows.map((node) => node.dataset.zone),
      decisionRoles: decisionRows.map((node) => node.getAttribute("role")),
      decisionChildCounts: decisionRows.map((node) => node.children.length),
      managementSummary: management?.querySelector(".decision-summary")?.textContent,
      exactSelectionSummary: exactSelection?.querySelector(".decision-summary")?.textContent,
      sixOptionSelectionSummary: sixOptionSelection?.querySelector(".decision-summary")?.textContent,
      decisionCodeCount: document.querySelectorAll("#decision-candidates .candidate-code").length,
      blockedCandidateCount: document.querySelectorAll(".zone-blocked").length,
      checklistSectionExists: document.querySelector("#checklist") !== null,
      detailLogSectionExists: document.querySelector("#detail-log-section") !== null,
      cardBadgeCount: document.querySelectorAll(".candidate-context-badge").length,
      cardCommentCount: document.querySelectorAll(".candidate-comment").length,
      totalPoints: document.querySelector("#total-points").textContent,
      removedSummaryMetadataExists: document.querySelector(
        "#decision-count, #calculation-diff, #revision-copy"
      ) !== null,
      rawCodeCandidateVisible: document.body.textContent.includes("900000001"),
      rawSelectionOptionVisible: document.body.textContent.includes("区分1")
        || document.body.textContent.includes("113001810"),
      blockedCandidateTextVisible: document.body.textContent.includes("未確認の行為xxxxxxxx"),
      legacyDecisionContainersExist: document.querySelector("#proposal-candidates, #selection-candidates") !== null,
      selectionStateLabelVisible: document.body.textContent.includes("要選択"),
      candidateCodeTag: included.querySelector(".candidate-code").tagName,
      candidateExternalLinkCount: document.querySelectorAll(".candidate-row a, .decision-row a").length,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  assert.equal(result.clinicalTextVisible, false);
  assert.match(result.readStatus, /^読取済み: SOAP 4項目・(?:たった今|\d+秒前)$/u);
  assert.deepEqual(result.zoneHeadings, ["算定案に含まれる", "要判断"]);
  assert.equal(result.includedName, "在宅患者訪問診療料");
  assert.equal(result.includedPoints, "890点");
  assert.deepEqual(result.includedNames, ["在宅患者訪問診療料", "在宅データ提出加算"]);
  assert.equal(result.decisionRowCount, 3);
  assert.equal(result.decisionListRole, "list");
  assert.equal(result.decisionListLabelledBy, "decision-heading");
  assert.deepEqual(result.decisionKinds, ["区分確認", "要確認", "区分確認"]);
  assert.deepEqual(result.decisionIds, ["management", "exact-management", "six-option-management"]);
  assert.deepEqual(result.decisionZones, ["selection_required", "review_required", "selection_required"]);
  assert.deepEqual(result.decisionRoles, ["listitem", "listitem", "listitem"]);
  assert.deepEqual(result.decisionChildCounts, [4, 4, 4]);
  assert.equal(
    result.managementSummary,
    "対象疾病等に該当しますか｜難病等 3,225点 / 一般 1,685点"
  );
  assert.equal(
    result.exactSelectionSummary,
    "215点｜訪問診療料の算定要件を確認してください。"
  );
  assert.equal(
    result.sixOptionSelectionSummary,
    "147〜225点（6区分）｜算定区分を確認してください"
  );
  assert.equal(result.decisionCodeCount, 0);
  assert.equal(result.blockedCandidateCount, 0);
  assert.equal(result.checklistSectionExists, false);
  assert.equal(result.detailLogSectionExists, false);
  assert.equal(result.cardBadgeCount, 0);
  assert.equal(result.cardCommentCount, 0);
  assert.equal(result.totalPoints, "940点");
  assert.equal(result.removedSummaryMetadataExists, false);
  assert.equal(result.rawCodeCandidateVisible, false);
  assert.equal(result.rawSelectionOptionVisible, false);
  assert.equal(result.blockedCandidateTextVisible, false);
  assert.equal(result.legacyDecisionContainersExist, false);
  assert.equal(result.selectionStateLabelVisible, false);
  assert.equal(result.candidateCodeTag, "SPAN");
  assert.equal(result.candidateExternalLinkCount, 0);
  assert.equal(result.horizontalOverflow, false);
  await page.close();
});

for (const width of [320, 380]) {
  test(`side panel does not overflow at ${width}px`, async () => {
    const page = await openPanel(width);
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      rows: [...document.querySelectorAll(".candidate-row, .decision-row")].map((node) => ({
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
      extractionProof: { selectorContractVersion: "homis-mock-v5" }
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
              pricingBasis: {
                mode: "current_master",
                masterLookupDate: "2026-06-15",
                masterVersion: "2026-06-15",
                historicalReproduction: false
              },
              estimatedTotalPoints: 940,
              decisionCandidateCount: 4,
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
                  zone: "included",
                  billingEligibility: "included",
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
                  reason: "訪問診療料の算定要件を確認してください。",
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
                { noticeId: "reference", candidateId: "exact-management", badge: "requires_selection", attentionLevel: "reference", checklist: false, shortText: "算定区分の確認が必要です。", detailText: "参考情報です。", audience: "clinician" }
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
