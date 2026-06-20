import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = await findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    NEXT_PUBLIC_PLATFORM_BASE_URL: "/api/platform",
    NEXT_PUBLIC_REFERRAL_BASE_URL: "/api/referral",
    NEXT_TELEMETRY_DISABLED: "1"
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
  await waitForHttp(`${baseUrl}/referrals`, 30_000);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await installApiMocks(page);

    await page.goto(`${baseUrl}/referrals`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "紹介状一覧" }).waitFor();
    assert.equal(await page.getByText("山田 太郎").first().isVisible(), true);

    await page.goto(`${baseUrl}/referrals/new`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "紹介状下書き" }).waitFor();
    await page.getByLabel("文書種別").selectOption("specialist_referral");
    assert.equal(await page.getByRole("button", { name: "下書きを作成" }).isVisible(), true);

    await page.goto(`${baseUrl}/referrals/referral_1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "山田 太郎" }).waitFor();
    await page.getByRole("button", { name: "プレビュー" }).click();
    await page.getByRole("button", { name: "プレビュー文書を作成" }).waitFor();
    await page.getByRole("button", { name: "確認項目" }).click();
    await page.getByText("診療情報提供料の算定連携").waitFor();

    await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "宛先マスタ" }).waitFor();
    await page.getByRole("heading", { name: "テンプレート" }).waitFor();
    assert.ok(await page.getByRole("button", { name: "保存" }).count() >= 2);

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(hasHorizontalOverflow, false, "referral web must not create desktop horizontal overflow");
  } finally {
    await browser.close().catch(() => null);
  }
} finally {
  server.kill("SIGTERM");
}

console.log("Referral web Next UI smoke passed");

async function installApiMocks(page) {
  await page.route("**/api/platform/v1/auth/session", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      authenticated: true,
      accessToken: "test-access-token",
      csrfToken: "test-csrf",
      session: {
        orgId: "org_test",
        organizationCode: "prod-test",
        memberId: "member_keishi",
        loginId: "keishi",
        displayName: "keishi",
        globalRoles: ["org_admin"],
        productRoles: { referral: ["admin"] },
        mfaVerified: true
      }
    })
  }));

  await page.route("**/api/referral/v1/referral/bootstrap**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(mockBootstrap())
  }));
}

function mockBootstrap() {
  return {
    patients: [{
      patientId: "patient_1",
      displayName: "山田 太郎",
      externalPatientIds: ["P001"]
    }],
    facilities: [{
      facilityId: "facility_1",
      displayName: "ハルナスクリニック"
    }],
    departments: [{
      departmentId: "department_1",
      displayName: "内科"
    }],
    recipients: [{
      recipientId: "recipient_1",
      institutionName: "紹介先病院",
      departmentName: "消化器内科",
      doctorName: "佐藤 先生",
      fax: "03-0000-0000",
      phone: "03-0000-0001",
      address: "東京都"
    }],
    templates: [{
      templateId: "template_1",
      templateType: "specialist_referral",
      title: "専門医紹介",
      body: "ご高診をお願いいたします。"
    }],
    referrals: [{
      referralId: "referral_1",
      patientId: "patient_1",
      facilityId: "facility_1",
      departmentId: "department_1",
      authorMemberId: "member_keishi",
      status: "draft",
      documentType: "clinical_information",
      urgency: "routine",
      title: "診療情報提供書",
      purpose: "精査依頼",
      clinicalSummary: "腹痛の精査をお願いします。",
      diagnoses: ["腹痛"],
      medications: ["アセトアミノフェン"],
      allergies: [],
      requestedAction: "ご高診をお願いいたします。",
      patientSnapshot: { displayName: "山田 太郎" },
      facilitySnapshot: { displayName: "ハルナスクリニック" },
      departmentSnapshot: { displayName: "内科" },
      authorMemberSnapshot: { displayName: "keishi" },
      recipientInstitutionSnapshot: { displayName: "紹介先病院", departmentName: "消化器内科" },
      recipientDoctorSnapshot: { displayName: "佐藤 先生" },
      reviewChecklist: [{ key: "recipient", label: "宛先", status: "passed", message: "" }],
      attachments: [],
      replies: [],
      feeLinkage: { status: "not_linked" },
      updatedAt: "2026-06-20T00:00:00.000Z"
    }]
  };
}

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
      if (response.status < 500) {
        return;
      }
    } catch {
      // Retry until Next finishes compiling.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}.\n${serverOutput}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
