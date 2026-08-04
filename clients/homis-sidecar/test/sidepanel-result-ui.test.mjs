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
      decisionKindTags: decisionRows.map((node) => node.querySelector(".decision-kind")?.tagName),
      decisionPressed: decisionRows.map((node) => node.querySelector(".decision-kind")?.getAttribute("aria-pressed")),
      decisionStatuses: decisionRows.map((node) => node.querySelector(".decision-kind")?.dataset.decisionStatus),
      decisionLabels: decisionRows.map((node) => node.querySelector(".decision-kind")?.getAttribute("aria-label")),
      decisionDisabled: decisionRows.map((node) => node.querySelector(".decision-kind")?.disabled),
      decisionCandidateKeys: decisionRows.map((node) => node.querySelector(".decision-kind")?.dataset.candidateKey),
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
      patientChargeGroupHidden: document.querySelector("#patient-charge-group")?.hidden,
      patientChargeHandling: document.querySelector("#patient-charge-handling")?.value,
      patientChargeOptions: [...document.querySelectorAll("#patient-charge-handling option")]
        .map((option) => [option.value, option.textContent]),
      patientChargeSaveDisabled: document.querySelector("#patient-charge-save")?.disabled,
      patientChargeStatus: document.querySelector("#patient-charge-status")?.textContent,
      candidateCodeTag: included.querySelector(".candidate-code").tagName,
      candidateExternalLinkCount: document.querySelectorAll(".candidate-row a, .decision-row a").length,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  assert.equal(result.clinicalTextVisible, false);
  assert.match(result.readStatus, /^読取済み: SOAP 4項目・(?:たった今|\d+秒前)$/u);
  assert.deepEqual(result.zoneHeadings, ["算定案に含まれる", "患者負担", "要判断"]);
  assert.equal(result.includedName, "在宅患者訪問診療料");
  assert.equal(result.includedPoints, "890点");
  assert.deepEqual(result.includedNames, ["在宅患者訪問診療料", "在宅データ提出加算"]);
  assert.equal(result.decisionRowCount, 3);
  assert.equal(result.decisionListRole, "list");
  assert.equal(result.decisionListLabelledBy, "decision-heading");
  assert.deepEqual(result.decisionKinds, ["区分確認", "確認済み", "区分確認"]);
  assert.deepEqual(result.decisionKindTags, ["BUTTON", "BUTTON", "BUTTON"]);
  assert.deepEqual(result.decisionPressed, [null, null, null]);
  assert.deepEqual(result.decisionStatuses, ["unacknowledged", "acknowledged", "stale"]);
  assert.deepEqual(result.decisionDisabled, [false, false, false]);
  assert.deepEqual(result.decisionCandidateKeys, [
    "candidate_management",
    "candidate_exact_management",
    "candidate_six_option_management"
  ]);
  assert.match(result.decisionLabels[0], /施設入居時等医学総合管理料.+区分確認.+確認済み/u);
  assert.match(result.decisionLabels[1], /在宅患者訪問診療料.+対象外にする/u);
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
  assert.equal(result.patientChargeGroupHidden, false);
  assert.equal(result.patientChargeHandling, "unknown");
  assert.deepEqual(result.patientChargeOptions, [
    ["unknown", "未設定"],
    ["charge", "請求する"],
    ["waive", "請求しない"]
  ]);
  assert.equal(result.patientChargeSaveDisabled, true);
  assert.equal(result.patientChargeStatus, "未設定です。選択するまで請求に含めません。");
  assert.equal(result.candidateCodeTag, "SPAN");
  assert.equal(result.candidateExternalLinkCount, 0);
  assert.equal(result.horizontalOverflow, false);
  await page.close();
});

test("patient transport handling is persisted without changing insurance points", async () => {
  const page = await openPanel(380);
  await page.selectOption("#patient-charge-handling", "charge");
  assert.equal(await page.locator("#patient-charge-save").isEnabled(), true);
  await page.click("#patient-charge-save");
  await page.locator("#patient-charge-status").filter({ hasText: "実費入力待ち" }).waitFor();

  const result = await page.evaluate(() => ({
    calls: globalThis.__sidecarTest.patientChargeCalls,
    handling: document.querySelector("#patient-charge-handling")?.value,
    totalPoints: document.querySelector("#total-points")?.textContent,
    saveDisabled: document.querySelector("#patient-charge-save")?.disabled
  }));
  assert.deepEqual(result.calls, [{
    sidecarDraftId: "sidecar_result_ui",
    handling: "charge",
    amountMode: "actual",
    amountYen: null,
    effectiveFrom: "2026-06-25",
    effectiveTo: null,
    expectedRevision: 0,
    expectedSourceRevision: 4,
    expectedCalculationRevision: 2
  }]);
  assert.equal(result.handling, "charge");
  assert.equal(result.totalPoints, "940点");
  assert.equal(result.saveDisabled, true);

  await page.selectOption("#patient-charge-handling", "unknown");
  assert.equal(await page.locator("#patient-charge-save").isEnabled(), true);
  await page.click("#patient-charge-save");
  await page.locator("#patient-charge-status").filter({ hasText: "未設定です" }).waitFor();
  const reset = await page.evaluate(() => ({
    calls: globalThis.__sidecarTest.patientChargeCalls,
    handling: document.querySelector("#patient-charge-handling")?.value,
    totalPoints: document.querySelector("#total-points")?.textContent
  }));
  assert.equal(reset.calls.length, 2);
  assert.deepEqual(reset.calls[1], {
    sidecarDraftId: "sidecar_result_ui",
    handling: "unknown",
    amountMode: null,
    amountYen: null,
    effectiveFrom: "2026-06-25",
    effectiveTo: null,
    expectedRevision: 1,
    expectedSourceRevision: 4,
    expectedCalculationRevision: 2
  });
  assert.equal(reset.handling, "unknown");
  assert.equal(reset.totalPoints, "940点");
  await page.close();
});

test("legacy patient transport settings are projected without rewriting stored reasons", async () => {
  const inherited = await openPanel(380, {
    initialPatientCharge: {
      chargeType: "home_medical_transport",
      status: "pending",
      handling: "inherit",
      billingHandling: "unknown",
      revision: 3,
      writable: true,
      unavailableReason: "facility_default_not_configured"
    }
  });
  assert.equal(await inherited.inputValue("#patient-charge-handling"), "unknown");
  assert.equal(await inherited.locator("#patient-charge-save").textContent(), "設定解除");
  assert.equal(await inherited.locator("#patient-charge-save").isEnabled(), true);
  assert.match(await inherited.locator("#patient-charge-status").textContent(), /旧設定「施設設定を継承」/u);
  await inherited.close();

  const included = await openPanel(380, {
    initialPatientCharge: {
      chargeType: "home_medical_transport",
      status: "configured",
      handling: "included_in_contract",
      billingHandling: "included_in_contract",
      revision: 2,
      writable: true,
      unavailableReason: null
    }
  });
  assert.equal(await included.inputValue("#patient-charge-handling"), "waive");
  assert.equal(await included.locator("#patient-charge-save").isDisabled(), true);
  assert.match(await included.locator("#patient-charge-status").textContent(), /患者へ交通費を別請求しません/u);
  await included.close();
});

test("decision badge persists the review, acknowledged, and excluded cycle", async () => {
  const page = await openPanel(380);
  const button = page.locator(".decision-row", { hasText: "施設入居時等医学総合管理料" })
    .locator(".decision-kind");

  await button.click();
  await button.filter({ hasText: "確認済み" }).waitFor();
  assert.equal(await button.getAttribute("data-decision-status"), "acknowledged");

  await button.press("Space");
  await button.filter({ hasText: "対象外" }).waitFor();
  assert.equal(await button.getAttribute("data-decision-status"), "excluded");

  await button.press("Space");
  await button.filter({ hasText: "区分確認" }).waitFor();
  assert.equal(await button.getAttribute("data-decision-status"), "unacknowledged");

  const calls = await page.evaluate(() => globalThis.__sidecarTest.acknowledgementCalls);
  assert.deepEqual(calls, [
    {
      sidecarDraftId: "sidecar_result_ui",
      candidateKey: "candidate_management",
      status: "acknowledged",
      expectedSourceRevision: 4,
      expectedCalculationRevision: 2,
      expectedAcknowledgementVersion: 0,
      candidateFingerprint: "fingerprint_management"
    },
    {
      sidecarDraftId: "sidecar_result_ui",
      candidateKey: "candidate_management",
      status: "excluded",
      expectedSourceRevision: 4,
      expectedCalculationRevision: 2,
      expectedAcknowledgementVersion: 1,
      candidateFingerprint: "fingerprint_management"
    },
    {
      sidecarDraftId: "sidecar_result_ui",
      candidateKey: "candidate_management",
      status: "unacknowledged",
      expectedSourceRevision: 4,
      expectedCalculationRevision: 2,
      expectedAcknowledgementVersion: 2,
      candidateFingerprint: "fingerprint_management"
    }
  ]);
  await page.close();
});

test("decision badge exposes a stable busy state and restores the prior state on conflict", async () => {
  const page = await openPanel(380);
  const row = page.locator(".decision-row", { hasText: "特定疾患療養管理料" });
  const button = row.locator(".decision-kind");
  await page.evaluate(() => { globalThis.__sidecarTest.acknowledgementMode = "deferred"; });

  await button.click();
  await page.waitForFunction(() => (
    document.querySelector('[data-candidate-key="candidate_six_option_management"]')?.getAttribute("aria-busy") === "true"
  ));
  assert.equal(await button.textContent(), "保存中");
  assert.equal(await button.isDisabled(), true);
  assert.equal(await button.getAttribute("data-decision-status"), "stale");
  assert.equal(await page.locator("#decision-candidates .decision-kind:disabled").count(), 1);

  await page.evaluate(() => (
    globalThis.__sidecarTest.releaseAcknowledgement("candidate_six_option_management")
  ));
  await button.filter({ hasText: "確認済み" }).waitFor();
  assert.equal(await button.getAttribute("aria-busy"), null);
  assert.equal(await button.isEnabled(), true);

  await page.evaluate(() => { globalThis.__sidecarTest.acknowledgementMode = "conflict"; });
  await button.press("Enter");
  await page.locator("#status-message").filter({
    hasText: "算定案が更新されたため、算定案を作成し直してください。"
  }).waitFor();
  assert.equal(await button.textContent(), "確認済み");
  assert.equal(await button.getAttribute("data-decision-status"), "acknowledged");
  assert.equal(await button.isEnabled(), true);
  await page.close();
});

test("different decision badges update independently without losing an earlier success", async () => {
  const page = await openPanel(380);
  const management = page.locator('[data-candidate-key="candidate_management"]');
  const sixOption = page.locator('[data-candidate-key="candidate_six_option_management"]');
  const exact = page.locator('[data-candidate-key="candidate_exact_management"]');
  await page.evaluate(() => { globalThis.__sidecarTest.acknowledgementMode = "deferred"; });

  await management.click();
  await sixOption.click();
  await page.waitForFunction(() => (
    document.querySelectorAll('#decision-candidates .decision-kind[aria-busy="true"]').length === 2
  ));
  assert.equal(await management.isDisabled(), true);
  assert.equal(await sixOption.isDisabled(), true);
  assert.equal(await exact.isEnabled(), true);
  assert.equal(await page.locator("#calculate-button").isDisabled(), true);

  await page.evaluate(() => (
    globalThis.__sidecarTest.releaseAcknowledgement("candidate_six_option_management")
  ));
  await sixOption.filter({ hasText: "確認済み" }).waitFor();
  assert.equal(await management.textContent(), "保存中");
  assert.equal(await page.locator("#calculate-button").isDisabled(), true);

  await page.evaluate(() => (
    globalThis.__sidecarTest.releaseAcknowledgement("candidate_management")
  ));
  await management.filter({ hasText: "確認済み" }).waitFor();
  assert.equal(await sixOption.textContent(), "確認済み");
  assert.equal(await management.getAttribute("data-decision-status"), "acknowledged");
  assert.equal(await sixOption.getAttribute("data-decision-status"), "acknowledged");
  assert.equal(await page.locator("#calculate-button").isEnabled(), true);
  await page.close();
});

test("recalculation cannot supersede a pending acknowledgement mutation", async () => {
  const page = await openPanel(380);
  const button = page.locator('[data-candidate-key="candidate_management"]');
  await page.evaluate(() => { globalThis.__sidecarTest.acknowledgementMode = "deferred"; });
  await button.click();
  await page.waitForFunction(() => (
    document.querySelector('[data-candidate-key="candidate_management"]')?.getAttribute("aria-busy") === "true"
  ));

  assert.equal(await page.locator("#calculate-button").isDisabled(), true);
  await page.evaluate(() => document.querySelector("#calculate-button")?.click());
  assert.equal(await page.locator("#result-section").isVisible(), true);
  assert.equal(await button.textContent(), "保存中");

  await page.evaluate(() => (
    globalThis.__sidecarTest.releaseAcknowledgement("candidate_management")
  ));
  await button.filter({ hasText: "確認済み" }).waitFor();
  assert.equal(await page.locator("#calculate-button").isEnabled(), true);
  assert.equal(await button.getAttribute("data-decision-status"), "acknowledged");
  await page.close();
});

test("authorization failure clears the Sidecar connection and result", async () => {
  const page = await openPanel(380);
  await page.evaluate(() => { globalThis.__sidecarTest.acknowledgementMode = "unauthorized"; });

  await page.locator('[data-candidate-key="candidate_management"]').click();
  await page.locator("#status-message").filter({
    hasText: "端末の接続が無効です。もう一度接続してください。"
  }).waitFor();

  assert.equal(await page.locator("#connection-badge").textContent(), "未接続");
  assert.equal(await page.locator("#calculation-section").isHidden(), true);
  assert.equal(await page.locator("#result-section").isHidden(), true);
  assert.equal(await page.evaluate(() => globalThis.__sidecarTest.clearGrantCalls), 1);
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

async function openPanel(width, options = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(panelHtml);
  await page.addStyleTag({ path: path.join(extensionDir, "sidepanel.css") });
  await page.evaluate((panelOptions) => {
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
    const initialPatientCharge = panelOptions.initialPatientCharge || {
      chargeType: "home_medical_transport",
      displayName: "在宅医療交通費",
      status: "unconfigured",
      billingHandling: "unknown",
      agreementRevision: 0,
      writable: true
    };
    globalThis.__sidecarTest = {
      acknowledgementCalls: [],
      acknowledgementCompleted: 0,
      acknowledgementMode: "success",
      acknowledgementResolvers: {},
      clearGrantCalls: 0,
      patientChargeCalls: [],
      releaseAcknowledgement(candidateKey) {
        const resolve = this.acknowledgementResolvers[candidateKey];
        delete this.acknowledgementResolvers[candidateKey];
        resolve?.();
      }
    };
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
            sidecarDraftId: "sidecar_result_ui",
            externalPatientId: "1001",
            sourceRecordId: "1001-20260625-01",
            serviceDate: "2026-06-25",
            lifecycleStatus: "draft",
            sourceRevision: 4,
            calculationRevision: 2,
            patientCharges: [structuredClone(initialPatientCharge)],
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
                  candidateKey: "candidate_management",
                  candidateFingerprint: "fingerprint_management",
                  acknowledgement: { status: "unacknowledged", version: 0, updatedAt: null },
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
                  candidateKey: "candidate_exact_management",
                  candidateFingerprint: "fingerprint_exact_management",
                  acknowledgement: { status: "acknowledged", version: 3, updatedAt: "2026-08-03T00:00:00.000Z" },
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
                  candidateKey: "candidate_six_option_management",
                  candidateFingerprint: "fingerprint_six_option_management",
                  acknowledgement: { status: "stale", version: 2, updatedAt: "2026-08-02T00:00:00.000Z" },
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
      async setCandidateAcknowledgement(input) {
        globalThis.__sidecarTest.acknowledgementCalls.push(structuredClone(input));
        if (globalThis.__sidecarTest.acknowledgementMode === "deferred") {
          await new Promise((resolve) => {
            globalThis.__sidecarTest.acknowledgementResolvers[input.candidateKey] = resolve;
          });
        }
        if (globalThis.__sidecarTest.acknowledgementMode === "failure") {
          const error = new Error("確認状態を保存できませんでした。");
          error.status = 500;
          throw error;
        }
        if (globalThis.__sidecarTest.acknowledgementMode === "conflict") {
          const error = new Error("candidate acknowledgement version conflict");
          error.status = 409;
          throw error;
        }
        if (globalThis.__sidecarTest.acknowledgementMode === "unauthorized") {
          const error = new Error("access token expired");
          error.status = 401;
          throw error;
        }
        const response = await this.calculate();
        const candidate = response.sidecarDraft.calculation.candidates.find((item) => (
          item.candidateKey === input.candidateKey
        ));
        candidate.acknowledgement = {
          status: input.status,
          version: Number(input.expectedAcknowledgementVersion || 0) + 1,
          updatedAt: "2026-08-03T00:00:01.000Z"
        };
        globalThis.__sidecarTest.acknowledgementCompleted += 1;
        return { contractVersion: "v1", changed: true, sidecarDraft: response.sidecarDraft };
      },
      async setPatientChargeSetting(input) {
        globalThis.__sidecarTest.patientChargeCalls.push(structuredClone(input));
        const response = await this.calculate();
        response.sidecarDraft.patientCharges = [{
          chargeType: "home_medical_transport",
          displayName: "在宅医療交通費",
          status: input.handling === "charge" ? "pending_actual" : input.handling === "unknown" ? "pending" : "resolved",
          handling: input.handling === "unknown" ? null : input.handling,
          billingHandling: input.handling,
          agreementRevision: Number(input.expectedRevision || 0) + 1,
          writable: true
        }];
        return { contractVersion: "v1", changed: true, sidecarDraft: response.sidecarDraft };
      },
      async clearGrant() { globalThis.__sidecarTest.clearGrantCalls += 1; },
      async pollDeviceAuthorization() {},
      async startDeviceAuthorization() { throw new Error("not used"); }
    };
  }, options);
  await page.addScriptTag({ path: path.join(extensionDir, "sidepanel.js") });
  await page.waitForFunction(() => document.querySelector("#preview-patient")?.textContent === "1001");
  await page.click("#calculate-button");
  await page.waitForFunction(() => document.querySelector("#result-section")?.hidden === false);
  return page;
}
