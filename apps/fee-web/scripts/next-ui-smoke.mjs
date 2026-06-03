import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

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
    await installApiMocks(page);
    await page.goto(`${baseUrl}/sessions`, { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "算定一覧" }).waitFor();
    await page.getByRole("button", { name: "メニューを開く" }).click();

    const drawer = page.locator(".admin-nav-drawer");
    await drawer.waitFor();
    assert.equal(await drawer.locator(".admin-nav-drawer-head strong").textContent(), "移動先を選択");
    assert.equal(await drawer.locator(".admin-sidebar-link").count(), 5);

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

    await page.goto(`${baseUrl}/sessions/fee_test_1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "カルテから算定候補を作成" }).waitFor();
    await page.getByText("カルテの内容").waitFor();

    const detailColumns = await page.locator(".fee-detail-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    assert.equal(detailColumns.trim().split(/\s+/).length, 1, "fee detail view must use a single column to avoid overlapping panels");

    const manualOrderEditorVisible = await page.getByRole("button", { name: "オーダー行を追加" }).isVisible();
    assert.equal(manualOrderEditorVisible, false, "manual order editor must stay hidden until advanced details are opened");

    const hasDetailHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(hasDetailHorizontalOverflow, false);
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

async function installApiMocks(page) {
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
  await page.route("**/api/fee/v1/fee/sessions**", (route) => {
    if (route.request().url().includes("/fee_test_1/detail")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          feeSession: {
            feeSessionId: "fee_test_1",
            status: "active",
            patientId: "patient_1",
            patientSnapshot: { displayName: "患者名未入力" },
            facilityId: "facility_1",
            serviceDate: "2026-06-03",
            claimMonth: "2026-06",
            setting: "outpatient",
            clinicalText: "A（Assessment：評価）\n熱傷創、上皮化進行中\n感染兆候なし",
            diagnoses: [],
            orders: [],
            calculationResult: null
          },
          reviewItems: [],
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
}
