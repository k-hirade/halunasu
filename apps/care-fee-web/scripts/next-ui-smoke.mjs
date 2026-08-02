import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(root, "../..");
const port = await findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    HALUNASU_ENV: "local",
    NEXT_PUBLIC_PLATFORM_BASE_URL: "/api/platform",
    NEXT_PUBLIC_CARE_FEE_BASE_URL: "/api/care-fee",
    NEXT_TELEMETRY_DISABLED: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

try {
  await waitForHttp(baseUrl, 30_000);
  const browser = await chromium.launch();
  try {
    await runDesktopSmoke(browser);
    await runMobileSmoke(browser);
  } finally {
    await browser.close().catch(() => null);
  }
} finally {
  server.kill("SIGTERM");
}

console.log("Care fee web Next UI smoke passed");

async function runDesktopSmoke(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.print = () => { window.__careFeePrintInvoked = true; };
  });
  await installApiMocks(page);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "緊急時治療管理" }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(resolve(repositoryRoot, "samples/care-fee/emergency-treatment-template.csv"));
  await page.getByRole("button", { name: "一括点検を実行" }).click();
  await page.getByRole("heading", { name: "点検結果" }).waitFor();
  assert.equal(await page.getByText("算定要件を満たしています").isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "結果CSVを出力" }).isVisible(), true);

  await page.getByRole("button", { name: "月次管理に取込", exact: true }).click();
  await page.getByRole("button", { name: "月次管理に取り込む" }).click();
  await page.getByText("1症例を月次管理に取り込みました").waitFor();

  await page.getByRole("button", { name: "月次点検" }).click();
  await page.getByRole("heading", { name: "2026年8月 月次点検" }).waitFor();
  assert.equal(await page.getByText("患者A").isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "確認" }).isEnabled(), true);
  await page.getByRole("button", { name: "印刷" }).click();
  assert.equal(await page.evaluate(() => window.__careFeePrintInvoked === true), true);
  await page.getByRole("button", { name: "月次点検を実行" }).click();
  await page.getByText("月次点検が完了しました。").waitFor();
  await page.screenshot({ path: "/tmp/halunasu-care-fee-monthly.png", fullPage: true });
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: "/tmp/halunasu-care-fee-monthly-print.png", fullPage: true });
  await page.emulateMedia({ media: "screen" });

  await page.getByRole("button", { name: "施設設定" }).click();
  await page.getByRole("heading", { name: "施設設定" }).waitFor();
  assert.equal(await page.getByLabel("介護医療院").inputValue(), "556000");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, "care fee web must not create desktop horizontal overflow");
  await page.screenshot({ path: "/tmp/halunasu-care-fee-desktop.png", fullPage: true });
  await context.close();
}

async function runMobileSmoke(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await installApiMocks(page);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "緊急時治療管理" }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, "care fee web must not create mobile document overflow");
  await page.screenshot({ path: "/tmp/halunasu-care-fee-mobile.png", fullPage: true });
  await context.close();
}

async function installApiMocks(page) {
  let monthlyRunCreated = false;
  await page.route("**/api/platform/v1/auth/session", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      authenticated: true,
      accessToken: "test-access-token",
      csrfToken: "test-csrf",
      session: {
        orgId: "org_test",
        organizationCode: "care-demo",
        memberId: "member_admin",
        loginId: "care-admin",
        displayName: "Care Admin",
        globalRoles: ["org_admin"],
        productRoles: { care_fee: ["admin"] },
        mfaVerified: true
      }
    })
  }));
  await page.route("**/api/care-fee/v1/care-fee/bootstrap**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(mockBootstrap(monthlyRunCreated))
  }));
  await page.route("**/api/care-fee/v1/care-fee/evaluations/csv", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(mockCsvResult())
  }));
  await page.route("**/api/care-fee/v1/care-fee/imports/csv", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...mockCsvResult(),
      importSummary: {
        acceptedRowCount: 1,
        importErrorRowCount: 0,
        persistedEpisodeCount: 1,
        createdEpisodeCount: 1,
        updatedEpisodeCount: 0,
        unchangedEpisodeCount: 0
      }
    })
  }));
  await page.route("**/api/care-fee/v1/care-fee/monthly-runs", async (route) => {
    monthlyRunCreated = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ run: mockMonthlyRun(), reused: false })
    });
  });
}

function mockBootstrap(withRun) {
  return {
    facilities: [{ facilityId: "fac_001", displayName: "西山介護医療院", status: "active" }],
    settings: [{
      facilityId: "fac_001",
      facilityCode: "facility-001",
      careOfficeNumber: "1234567890",
      timezone: "Asia/Tokyo",
      emergencyServiceCodes: { care_medical_institution: "556000" },
      facilityVariants: {},
      enabled: true,
      updatedAt: "2026-08-02T00:00:00.000Z"
    }],
    episodes: [{
      episodeId: "cep_001",
      patientKey: "patient-001",
      patientDisplayName: "患者A",
      treatmentDates: ["2026-08-01"],
      decisionStatus: "pending",
      evaluation: {
        judgmentStatus: "billing_candidate",
        totalUnits: 518,
        reasonCodes: ["eligible_requirements_satisfied"],
        missingFields: []
      }
    }],
    monthlyRuns: withRun ? [mockMonthlyRun()] : [],
    monthlyClaims: [],
    importJobs: []
  };
}

function mockMonthlyRun() {
  return {
    runId: "cmr_001",
    coverage: { sourceEpisodeCount: 1, claimCount: 0 },
    summary: { candidateCount: 1, needsReviewCount: 0 },
    createdAt: "2026-08-02T03:00:00.000Z"
  };
}

function mockCsvResult() {
  const row = {
    patient_key: "patient-001",
    patient_display_name: "患者A",
    treatment_date: "2026-08-01",
    judgment_status: "billing_candidate",
    resolved_service_code: "556000",
    resolved_service_code_name: "医療院緊急時治療管理",
    counted_units: 518,
    reason_codes: "eligible_requirements_satisfied",
    missing_fields: "",
    normalized_row_sha256: "a".repeat(64)
  };
  return {
    importJob: { importJobId: "cij_001" },
    result: {
      runId: "care-smoke",
      ruleVersion: "care-emergency-rule-v1",
      masterVersion: "care-emergency-service-codes-2026-06-01-v1",
      inputEncoding: "utf8",
      summary: {
        rowCount: 1,
        episodeCount: 1,
        candidateUnits: 518,
        statusCounts: { billing_candidate: 1, needs_review: 0, conflict: 0, not_eligible: 0, import_error: 0 }
      },
      rows: [row],
      outputBase64: Buffer.from("result").toString("base64")
    }
  };
}

function findOpenPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (server.exitCode !== null) throw new Error(`Next dev server exited early.\n${serverOutput}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Wait until Next finishes compiling.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}.\n${serverOutput}`);
}
