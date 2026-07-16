import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { tokyoClaimMonth, tokyoDateKey } from "../lib/tokyo-date.js";

assert.equal(tokyoDateKey("2026-07-15T15:30:00.000Z"), "2026-07-16");
assert.equal(tokyoClaimMonth("2026-06-30T15:30:00.000Z"), "2026-07");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = await findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    NEXT_PUBLIC_PLATFORM_BASE_URL: "/api/platform",
    NEXT_PUBLIC_FEE_BASE_URL: "/api/fee"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

try {
  await waitForHttp(`${baseUrl}/sessions`, 30_000);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{
      name: "halunasu_csrf",
      value: "test-csrf",
      url: baseUrl
    }]);
    const page = await context.newPage();
    const apiMocks = await installApiMocks(page);
    await page.goto(`${baseUrl}/sessions`, { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "算定一覧" }).waitFor();
    await page.getByRole("button", { name: "メニューを開く" }).click();

    const drawer = page.locator(".admin-nav-drawer");
    await drawer.waitFor();
    assert.equal(await drawer.locator(".admin-nav-drawer-head strong").textContent(), "移動先を選択");
    assert.equal(await drawer.locator(".admin-sidebar-link").count(), 7);
    assert.equal(await drawer.getByRole("link", { name: /月次レセ点検/ }).count(), 1);
    assert.equal(await drawer.getByRole("link", { name: /レセプト設定/ }).count(), 1);

    const drawerBox = await drawer.boundingBox();
    assert.ok(drawerBox, "drawer must be visible");
    assert.ok(drawerBox.width >= 300, "drawer must have stable width");
    assert.ok(drawerBox.height > 240, "drawer must have a complete panel height");

    const firstLink = drawer.locator(".admin-sidebar-link").first();
    const firstLinkDisplay = await firstLink.evaluate((element) => getComputedStyle(element).display);
    assert.equal(firstLinkDisplay, "grid");

    const smallLineHeight = await firstLink.locator("small").evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    assert.ok(smallLineHeight >= 18, "drawer description text must have readable line height");

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(hasHorizontalOverflow, false);

    await page.goto(`${baseUrl}/monthly`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "請求月ごとの確認状況" }).waitFor();
    await page.getByRole("heading", { name: "患者別点検リスト" }).waitFor();
    assert.equal(await page.getByText("病名不足 1件").count(), 1, "monthly worklist must show missing diagnosis count");
    assert.equal(await page.getByText("要確認 2件").count(), 1, "monthly worklist must show review count");
    await page.getByRole("button", { name: /患者名未入力/ }).click();
    const monthlyPopup = page.getByRole("dialog", { name: "患者の点検" });
    await monthlyPopup.waitFor();
    await monthlyPopup.getByText("受診 2026-06-03").waitFor();
    await monthlyPopup.getByText("要確認").first().waitFor();
    assert.equal(await monthlyPopup.getByRole("link", { name: "算定画面で開く" }).first().getAttribute("href"), "/sessions/fee_test_1");
    await monthlyPopup.getByRole("button", { name: "月次レセプト案を開く" }).click();
    const monthlyReceiptDialog = page.getByRole("dialog", { name: "月次レセプト案" });
    await monthlyReceiptDialog.waitFor();
    await monthlyReceiptDialog.getByRole("heading", { name: "患者名未入力" }).waitFor();
    await monthlyReceiptDialog.getByRole("button", { name: "CSV出力" }).waitFor();
    await monthlyReceiptDialog.getByText("診療報酬明細書").waitFor();
    await monthlyReceiptDialog.locator(".fee-modal-footer").getByRole("button", { name: "閉じる" }).click();

    await page.goto(`${baseUrl}/sessions/fee_test_1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "患者", level: 2 }).waitFor();
    await page.getByText("カルテの内容").waitFor();
    assert.equal(await page.getByText("算定記録を準備しました").count(), 0, "empty candidate pane must not show patient-dependent preparation notice");
    assert.equal(await page.getByText("入力と採否は自動保存されます。").count(), 0, "detail footer must not show autosave status copy");
    await page.getByRole("button", { name: /患者名未入力/ }).click();
    const patientDialog = page.getByRole("dialog", { name: "患者検索" });
    await patientDialog.waitFor();
    await waitForCondition(() => apiMocks.patientSearchRequests.length >= 1, "initial patient search request");
    assert.equal(apiMocks.patientSearchRequests.at(-1).searchParams.get("limit"), "30");
    assert.equal(apiMocks.patientSearchRequests.at(-1).searchParams.get("q"), null);
    await patientDialog.getByPlaceholder("氏名・患者番号で検索").fill("山");
    await page.waitForTimeout(320);
    assert.equal(apiMocks.patientSearchRequests.length, 1, "single-character name search must not hit the API");
    await patientDialog.getByPlaceholder("氏名・患者番号で検索").fill("吉田");
    await waitForCondition(() => apiMocks.patientSearchRequests.some((url) => url.searchParams.get("q") === "吉田"), "patient search request for typed name");
    const patchCountBeforePatientSelect = apiMocks.patchBodies.length;
    await patientDialog.getByRole("button", { name: /吉田 結衣/ }).click();
    await page.waitForTimeout(850);
    assert.equal(apiMocks.patchBodies.length, patchCountBeforePatientSelect, "selecting a patient must not autosave the session before calculation");

    const clinicalEditor = page.locator(".clinical-text-editable");
    await clinicalEditor.getByText("ゲーベンクリーム XXgを塗布。").waitFor();
    assert.equal(
      await clinicalEditor.locator(".clinical-text-inline-annotation").filter({ hasText: "ゲーベンクリーム XXgを塗布。" }).count(),
      1,
      "medication missing-dose annotation must render inline inside the chart text"
    );
    const sameDayTreatmentAnnotationAtSentenceEnd = await clinicalEditor.evaluate((element) => {
      const html = element.innerHTML;
      return html.includes("被覆）。<span class=\"clinical-text-inline-annotation\"")
        && html.includes("右前腕部II度熱傷")
        && html.includes("右前腕擦過創 30cm²")
        && html.includes("別部位としてそれぞれ処置。");
    });
    assert.equal(
      sameDayTreatmentAnnotationAtSentenceEnd,
      true,
      "same-day wound treatment annotation must render after the treatment sentence"
    );
    await clinicalEditor.focus();
    const medicationAnnotation = clinicalEditor.locator(".clinical-text-inline-annotation").filter({ hasText: "ゲーベンクリーム XXgを塗布。" }).first();
    await medicationAnnotation.evaluate((span) => {
      const editor = span.closest(".clinical-text-editable");
      editor?.focus();
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let textNode = null;
      let offset = -1;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        offset = node.textContent.indexOf("XX");
        if (offset >= 0) {
          textNode = node;
          break;
        }
      }
      if (!textNode || offset < 0) {
        throw new Error("missing editable medication placeholder");
      }
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + "XX".length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = document.execCommand("insertText", false, "50");
      if (!inserted) {
        throw new Error("failed to insert medication text");
      }
    });
    await clinicalEditor.evaluate(() => {
      const inserted = document.execCommand("insertText", false, "m");
      if (!inserted) {
        throw new Error("failed to continue medication text edit");
      }
    });
    const editedMedicationText = "ゲーベンクリーム 50mgを塗布。";
    await page.waitForFunction(
      (expected) => document.querySelector(".clinical-text-editable")?.innerText.includes(expected),
      editedMedicationText
    );
    assert.equal(
      await clinicalEditor.evaluate((element) => element.innerText.trim().startsWith("m")),
      false,
      "continued typing after editing an inline annotation must not jump to the beginning"
    );
    assert.equal(
      await clinicalEditor.locator(".clinical-text-inline-annotation").filter({ hasText: editedMedicationText }).count(),
      0,
      "edited inline annotation must become regular chart text"
    );

    const detailColumns = await page.locator(".fee-session-workspace").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    assert.ok(detailColumns.trim().split(/\s+/).length >= 2, "desktop fee detail view must use two robust columns");

    await page.getByRole("button", { name: "オーダーを確認" }).click();
    const orderDialog = page.getByRole("dialog", { name: "オーダーの確認" });
    await orderDialog.waitFor();
    const manualOrderEditorVisible = await orderDialog.getByRole("button", { name: "オーダー行を追加" }).isVisible();
    assert.equal(manualOrderEditorVisible, true, "manual order editor must remain available inside the order confirmation dialog");
    await orderDialog.locator(".fee-modal-footer").getByRole("button", { name: "閉じる" }).click();
    assert.equal(await page.getByText("詳細条件 JSON").count(), 0, "claimContext JSON editor must be removed from the UI");
    assert.equal(await page.getByText("算定オプション JSON").count(), 0, "calculationOptions JSON editor must be removed from the UI");
    assert.equal(await page.locator(".fee-session-action-footer").isVisible(), true, "detail actions must be available in the session footer");
    assert.equal(await page.getByRole("tab", { name: "レセプト案" }).count(), 0, "receipt draft tab must be removed from session detail");
    assert.equal(await page.getByRole("tab", { name: "算定作業" }).count(), 0, "work tab must be removed from session detail");
    assert.equal(await page.getByRole("button", { name: "コピー" }).count(), 0, "receipt draft export actions must not be shown in session detail");

    const hasDetailHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(hasDetailHorizontalOverflow, false);

    await page.setViewportSize({ width: 390, height: 900 });
    const mobileColumns = await page.locator(".fee-session-workspace").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    assert.equal(mobileColumns.trim().split(/\s+/).length, 1, "mobile fee detail view must stack into one column");
    const hasMobileHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(hasMobileHorizontalOverflow, false);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.getByRole("button", { name: "カルテから算定候補を作成" }).click();
    const missingDiagnosisDialog = page.getByRole("dialog", { name: "病名未入力の確認" });
    await missingDiagnosisDialog.waitFor();
    await missingDiagnosisDialog.getByRole("button", { name: "病名なしで進む" }).click();
    const patchBody = await apiMocks.patchPromise;
    assert.equal(
      patchBody.patientId,
      "patient_100",
      "selected patient must be saved only when calculation is requested"
    );
    assert.deepEqual(
      patchBody.orders.map((order) => [order.orderType, order.localName, order.standardCode]),
      [],
      "chart-only calculation must not submit client-side fixed coded orders"
    );
    assert.deepEqual(
      patchBody.diagnoses.map((diagnosis) => diagnosis.name),
      [],
      "chart-only calculation must not submit client-side fixed diagnoses"
    );
    assert.equal(
      patchBody.clinicalText.includes("ゲーベンクリーム XXmg 1日X回 X日分。"),
      false,
      "inline red annotation must not be persisted into the original chart text"
    );
    assert.equal(
      patchBody.clinicalText.includes("ゲーベンクリーム XXgを塗布。"),
      false,
      "unedited inline red ointment annotation must not be persisted into the original chart text"
    );
    assert.equal(
      patchBody.clinicalText.includes(editedMedicationText),
      true,
      "edited inline annotation must be persisted as regular chart text"
    );
    assert.equal(
      patchBody.clinicalText.includes("別部位としてそれぞれ処置。"),
      false,
      "unedited same-day treatment annotation must not be persisted into the original chart text"
    );

    let detailLoadFailureRequests = 0;
    await page.route("**/api/fee/v1/fee/sessions/fee_load_error/detail**", (route) => {
      detailLoadFailureRequests += 1;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fee_detail_unavailable", message: "算定詳細を取得できません。" })
      });
    });
    await page.goto(`${baseUrl}/sessions/fee_load_error`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "算定詳細を表示できません" }).waitFor();
    const detailLoadAlert = page.locator(".fee-error-state[role=alert]");
    await detailLoadAlert.waitFor();
    assert.ok((await detailLoadAlert.textContent()).trim().length > 0);
    assert.equal(await page.getByRole("button", { name: "カルテから算定候補を作成" }).count(), 0);
    assert.equal(await page.locator(".clinical-text-editable").count(), 0);
    await page.getByRole("button", { name: "再読み込み" }).click();
    await waitForCondition(() => detailLoadFailureRequests >= 2, "detail retry request");
    await browser.close();
  } catch (error) {
    await browser.close().catch(() => null);
    throw error;
  }
} finally {
  server.kill("SIGTERM");
}

console.log("Fee web Next UI smoke passed");

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Next dev server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until Next finishes compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}.\n${serverOutput}`);
}

async function waitForCondition(predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function installApiMocks(page) {
  let patchResolve;
  const patchBodies = [];
  const patientSearchRequests = [];
  const patchPromise = new Promise((resolve) => {
    patchResolve = resolve;
  });
  await page.route("**/api/platform/v1/auth/session", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      authenticated: true,
      session: {
        orgId: "org_test",
        organizationCode: "prod-test",
        memberId: "member_keishi",
        loginId: "keishi",
        displayName: "keishi",
        globalRoles: ["org_admin"],
        productRoles: { fee: ["admin"] },
        mfaVerified: true
      }
    })
  }));
  await page.route("**/api/fee/v1/fee/bootstrap**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      patients: [{
        patientId: "patient_1",
        displayName: "患者名未入力",
        primaryPatientNumber: "1234",
        externalPatientIds: ["1234"]
      }],
      facilities: [{
        facilityId: "facility_1",
        displayName: "prod-test",
        medicalInstitutionCode: ""
      }],
      departments: [{
        departmentId: "department_1",
        displayName: "General"
      }],
      masterStatus: { available: true }
    })
  }));
  await page.route("**/api/fee/v1/fee/monthly-summary**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      claimMonth: "2026-06",
      patientCount: 2,
      sessionCount: 3,
      totalPoints: 451,
      calculatedCount: 2,
      needsReviewCount: 2,
      missingDiagnosisCount: 1,
      symptomDetailCandidateCount: 1,
      readyForClaimCount: 1,
      blockedCount: 2,
      uncalculatedCount: 0,
      patients: [{
        patientId: "patient_1",
        patientName: "患者名未入力",
        sessionCount: 2,
        totalPoints: 321,
        calculatedCount: 2,
        needsReviewCount: 2,
        missingDiagnosisCount: 0,
        symptomDetailCandidateCount: 1,
        readyForClaimCount: 1,
        blockedCount: 1,
        uncalculatedCount: 0,
        readyForClaim: false,
        blocked: true,
        sessions: [{
          feeSessionId: "fee_test_1",
          serviceDate: "2026-06-03",
          status: "needs_review",
          totalPoints: 321,
          monthlyClaimWork: {
            status: "doctor_confirming",
            diagnosisCandidates: [{ name: "急性上気道炎" }],
            diagnosisRequestReason: "病名不足のため確認",
            doctorName: "山田医師",
            collectedResult: "急性上気道炎"
          },
          pointsBreakdown: [{ label: "手術", points: 4040 }, { label: "基本料", points: 233 }],
          readiness: {
            blocked: true,
            readyForClaim: false,
            diagnosisRequestCandidate: true,
            missingDiagnosis: false,
            needsReviewCount: 2,
            symptomDetailCandidateCount: 1,
            pendingReceiptAnnotationCount: 0,
            uncalculated: false,
            issues: [{
              type: "review",
              label: "要確認",
              detail: "算定根拠の確認が必要です。"
            }]
          }
        }]
      }, {
        patientId: "patient_2",
        patientName: "病名未確認患者",
        sessionCount: 1,
        totalPoints: 130,
        calculatedCount: 1,
        needsReviewCount: 0,
        missingDiagnosisCount: 1,
        symptomDetailCandidateCount: 0,
        readyForClaimCount: 0,
        blockedCount: 1,
        uncalculatedCount: 0,
        readyForClaim: false,
        blocked: true,
        sessions: [{
          feeSessionId: "fee_test_2",
          serviceDate: "2026-06-04",
          status: "calculated",
          totalPoints: 130
        }]
      }]
    })
  }));
  await page.route("**/api/fee/v1/fee/monthly-bulk-candidates**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      claimMonth: "2026-06",
      targetCount: 1,
      runnableCount: 1,
      blockedCount: 0,
      reasonCounts: { uncalculated: 1 },
      targets: [{
        feeSessionId: "fee_test_2",
        patientId: "patient_2",
        patientName: "病名未確認患者",
        serviceDate: "2026-06-04",
        reason: "uncalculated",
        reasonLabel: "未算定",
        canRun: true
      }]
    })
  }));
  await page.route("**/api/fee/v1/fee/monthly-bulk-jobs**", (route) => route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({
      monthlyBulkJob: {
        monthlyBulkJobId: "bulk_1",
        status: "completed_with_errors",
        progress: { totalCount: 1, processedCount: 1, queuedCount: 0, failedCount: 1, skippedCount: 0, percent: 100 },
        items: [{ itemId: "bulk_item_1", feeSessionId: "fee_test_2", patientName: "病名未確認患者", serviceDate: "2026-06-04", status: "failed", reasonLabel: "未算定", errorMessage: "not configured" }]
      }
    })
  }));
  await page.route("**/api/fee/v1/fee/monthly-receipt?**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      receiptDraft: {
        receiptDraftId: "receipt_monthly_patient_1_2026_06",
        scope: "monthly",
        receiptType: "medical_outpatient",
        claimKey: "patient_1|2026-06|medical_outpatient|12345678|A|1|",
        patientId: "patient_1",
        patientRef: "patient_1",
        patientSnapshot: { displayName: "患者名未入力", sex: "unknown" },
        facilitySnapshot: { displayName: "prod-test", medicalInstitutionCode: "" },
        insuranceSnapshot: { insurance: { insurerNumber: "12345678", insuredSymbol: "A", insuredNumber: "1" }, publicInsurance: [] },
        claimMonth: "2026-06",
        serviceDate: "2026-06-03",
        setting: "outpatient",
        status: "ready",
        actualDays: 1,
        totalPoints: 321,
        billing: { totalPoints: 321, totalFee: 3210, burdenRatio: 0.3, burdenRatioSource: "default_unknown", copay: 960, insurerPay: 2250, notes: [] },
        diagnoses: [{ name: "急性上気道炎", icd10Code: "J06.9", isPrimary: true }],
        receiptAnnotations: { comments: [], symptomDetails: [] },
        lineOccurrences: [{
          occurrenceId: "fee_test_1_line_1",
          aggregateKey: "112007410|basic|再診料",
          serviceDate: "2026-06-03",
          code: "112007410",
          name: "再診料",
          orderType: "basic",
          quantity: 1,
          points: 76,
          totalPoints: 76
        }],
        lineGroups: [{
          key: "basic",
          label: "基本料",
          totalPoints: 321,
          lines: [{
            code: "112007410",
            name: "再診料",
            orderType: "basic",
            quantity: 1,
            points: 76,
            totalPoints: 76,
            includedInTotal: true,
            status: "included"
          }]
        }]
      }
    })
  }));
  await page.route("**/api/fee/v1/fee/patients**", (route) => {
    const requestUrl = new URL(route.request().url());
    patientSearchRequests.push(requestUrl);
    const query = requestUrl.searchParams.get("q") || "";
    const patients = query ? [{
      patientId: "patient_100",
      displayName: "吉田 結衣",
      primaryPatientNumber: "100",
      externalPatientIds: ["100"]
    }] : [{
      patientId: "patient_1",
      displayName: "患者名未入力",
      primaryPatientNumber: "1234",
      externalPatientIds: ["1234"]
    }, {
      patientId: "patient_100",
      displayName: "吉田 結衣",
      primaryPatientNumber: "100",
      externalPatientIds: ["100"]
    }];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ patients })
    });
  });
  await page.route("**/api/fee/v1/fee/sessions**", (route) => {
    const request = route.request();
    const requestUrl = request.url();
    if (request.method() === "PATCH" && requestUrl.match(/\/fee_test_1$/u)) {
      const body = JSON.parse(request.postData() || "{}");
      patchBodies.push(body);
      patchResolve(body);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          feeSession: buildMockDetailSession(body),
          reviewItems: [],
          receiptDraft: null
        })
      });
    }
    if (request.method() === "POST" && requestUrl.includes("/fee_test_1/calculate")) {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          feeSession: buildMockDetailSession({
            calculationResult: {
              totalPoints: 64,
              lineItems: []
            }
          }),
          calculationResult: {
            provider: "test",
            status: "completed",
            totalPoints: 64,
            lineItems: [],
            warnings: [],
            coverage: { supportLevel: "partial" }
          },
          reviewItems: [],
          receiptDraft: { claimMonth: "2026-06", status: "ready", totalPoints: 64, lineGroups: [] }
        })
      });
    }
    if (route.request().url().includes("/fee_test_1/detail")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          feeSession: buildMockDetailSession(),
          reviewItems: [],
          candidateWorkbench: buildMockCandidateWorkbench(),
          receiptDraft: null
        })
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        feeSessions: [{
          feeSessionId: "fee_test_1",
          status: "active",
          serviceDate: "2026-06-03",
          patientSnapshot: { displayName: "患者名未入力" },
          facilitySnapshot: { displayName: "施設未設定" },
          departmentSnapshot: { displayName: "診療科未指定" },
          createdAt: "2026-06-03T09:06:00.000Z",
          calculationResult: null,
          reviewItems: []
        }],
        page: 1,
        pageSize: 20,
        totalCount: 1,
        totalPages: 1
      })
    });
  });
  return { patchBodies, patchPromise, patientSearchRequests };
}

function buildMockCandidateWorkbench() {
  return {
    lines: [],
    includedLines: [],
    pendingLines: [],
    excludedLines: [],
    proposals: [],
    hiddenIssues: [],
    issues: [{
      reviewItemId: "review_medication_missing_dose",
      kind: "issue",
      sourceType: "review_issue",
      issueCategory: "medication",
      displayTitle: "ゲーベンクリームの確認",
      displayReason: "薬剤日数不足: 薬剤「ゲーベンクリーム」は日数または総量が不足しているため、算定候補には入れていません。",
      requiredInput: "1回量、1日回数、日数または総量。",
      hiddenFromWorkspace: false
    }, {
      reviewItemId: "review_same_day_treatment",
      kind: "issue",
      sourceType: "warning",
      issueCategory: "input",
      displayTitle: "同日複数処置の確認",
      displayReason: "同日複数処置の確認: 熱傷処置と創傷処置を同日に算定しています。別部位・別創傷として処置した根拠を確認してください。",
      hiddenFromWorkspace: false
    }],
    counts: { included: 0, pending: 0, excluded: 0, proposals: 0, issues: 2, needsReview: 2 }
  };
}

function buildMockDetailSession(overrides = {}) {
  return {
    feeSessionId: "fee_test_1",
    status: "active",
    patientId: "patient_1",
    patientSnapshot: { displayName: "患者名未入力" },
    facilityId: "facility_1",
    serviceDate: "2026-06-03",
    claimMonth: "2026-06",
    setting: "outpatient",
    clinicalText: [
      "S（Subjective：主観的情報）",
      "ガーゼが傷にくっつく感じがあって、交換のときが辛い",
      "睡眠は取れている、発熱なし",
      "O（Objective：客観的情報）",
      "右前腕部熱傷（II度浅達性）、受傷後14日目",
      "創部サイズ：約4×6cm",
      "A（Assessment：評価）",
      "熱傷創、上皮化進行中",
      "感染兆候なし",
      "P（Plan：計画）",
      "当日、熱傷処置を施行（洗浄・軟膏塗布・被覆）。当日、同時に右前腕の擦過創（約30cm²）にも創傷処置を施行。ゲーベンクリーム塗布＋ノンスティックガーゼで保護"
    ].join("\n"),
    diagnoses: [],
    orders: [],
    calculationResult: null,
    ...overrides
  };
}
