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
    await verifyUnregisteredLoginShowsEnrollment(browser);
    await verifyUnregisteredReloadShowsEnrollment(browser);
    await verifyEnrolledLoginShowsSixDigitChallenge(browser);
    await verifyNonPrivilegedSessionCanSkipMfa(browser);
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}

console.log("Fee web Platform auth UI smoke passed");

async function verifyUnregisteredLoginShowsEnrollment(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let enrollmentRequests = 0;
  await page.route("**/api/platform/v1/auth/session", (route) => json(route, 401, {
    error: "unauthorized",
    message: "Invalid session"
  }));
  await page.route("**/api/platform/v1/auth/login", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    assert.equal(body.organizationCode, "clinic-mfa-new");
    assert.equal(body.loginId, "admin");
    assert.equal(body.mfaCode, undefined);
    return json(route, 200, pendingAdminLogin());
  });
  await page.route("**/api/platform/v1/auth/mfa/enroll", (route) => {
    enrollmentRequests += 1;
    assert.equal(route.request().headers().authorization, "Bearer pending-access-token");
    return json(route, 201, enrollmentChallenge());
  });

  await page.goto(`${baseUrl}/sessions`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "ログイン", level: 1 }).waitFor();
  await page.getByLabel("病院コード").fill("clinic-mfa-new");
  await page.getByLabel("個人ID").fill("admin");
  await page.locator("#password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();

  await assertEnrollmentScreen(page);
  assert.equal(enrollmentRequests, 1);
  assert.equal(await page.getByRole("heading", { name: "算定一覧" }).count(), 0);
  await context.close();
}

async function verifyUnregisteredReloadShowsEnrollment(browser) {
  const context = await browser.newContext();
  await context.addCookies([{ name: "halunasu_csrf", value: "pending-csrf-token", url: baseUrl }]);
  const page = await context.newPage();
  let enrollmentRequests = 0;
  await page.route("**/api/platform/v1/auth/session", (route) => json(route, 200, {
    authenticated: true,
    session: pendingAdminSession(),
    accessToken: "pending-access-token"
  }));
  await page.route("**/api/platform/v1/auth/mfa/enroll", (route) => {
    enrollmentRequests += 1;
    return json(route, 201, enrollmentChallenge());
  });

  await page.goto(`${baseUrl}/sessions`, { waitUntil: "domcontentloaded" });
  await assertEnrollmentScreen(page);
  assert.equal(enrollmentRequests, 1);
  assert.equal(await page.getByRole("heading", { name: "算定一覧" }).count(), 0);
  await context.close();
}

async function verifyEnrolledLoginShowsSixDigitChallenge(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginBodies = [];
  await page.route("**/api/platform/v1/auth/session", (route) => json(route, 401, {
    error: "unauthorized",
    message: "Invalid session"
  }));
  await page.route("**/api/platform/v1/auth/login", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    loginBodies.push(body);
    if (!body.mfaCode) {
      return json(route, 401, {
        error: "mfa_required",
        message: "MFA code is required"
      });
    }
    assert.equal(body.mfaCode, "123456");
    return json(route, 200, verifiedAdminLogin());
  });
  await installMinimalFeeMocks(page);

  await page.goto(`${baseUrl}/sessions`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("病院コード").fill("clinic-mfa-ready");
  await page.getByLabel("個人ID").fill("admin");
  await page.locator("#password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();

  await page.getByRole("heading", { name: "確認コード", level: 1 }).waitFor();
  assert.equal(await page.getByLabel("6桁コード").count(), 1);
  assert.equal(await page.getByAltText("認証アプリ登録用QRコード").count(), 0);
  assert.equal(await page.getByLabel("シークレット").count(), 0);
  await page.getByLabel("6桁コード").fill("123456");
  await page.getByRole("button", { name: "確認" }).click();
  await page.getByRole("heading", { name: "算定一覧" }).waitFor();

  assert.equal(loginBodies.length, 2);
  assert.equal(loginBodies[0].mfaCode, undefined);
  assert.equal(loginBodies[1].mfaCode, "123456");
  await context.close();
}

async function verifyNonPrivilegedSessionCanSkipMfa(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/api/platform/v1/auth/session", (route) => json(route, 200, {
    authenticated: true,
    session: {
      orgId: "org_staff",
      memberId: "mem_staff",
      organizationCode: "clinic-staff",
      loginId: "clerk",
      globalRoles: ["staff"],
      productRoles: { fee: ["medical_clerk"] },
      mfaRequired: false,
      mfaEnrolled: false,
      mfaVerified: false
    }
  }));
  await installMinimalFeeMocks(page);

  await page.goto(`${baseUrl}/sessions`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "算定一覧" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "認証アプリを登録" }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "確認コード" }).count(), 0);
  await context.close();
}

async function assertEnrollmentScreen(page) {
  await page.getByRole("heading", { name: "認証アプリを登録", level: 1 }).waitFor();
  assert.equal(await page.getByAltText("認証アプリ登録用QRコード").count(), 1);
  assert.equal(await page.getByLabel("シークレット").inputValue(), "JBSWY3DPEHPK3PXP");
  assert.equal(await page.getByLabel("6桁コード").count(), 1);
}

async function installMinimalFeeMocks(page) {
  await page.route("**/api/fee/v1/fee/bootstrap**", (route) => json(route, 200, {
    patients: [],
    facilities: [],
    departments: [],
    masterStatus: { available: true }
  }));
  await page.route("**/api/fee/v1/fee/sessions**", (route) => json(route, 200, {
    feeSessions: [],
    page: 1,
    pageSize: 20,
    totalCount: 0,
    totalPages: 1
  }));
}

function pendingAdminLogin() {
  return {
    session: pendingAdminSession(),
    csrfToken: "pending-csrf-token",
    accessToken: "pending-access-token"
  };
}

function pendingAdminSession() {
  return {
    orgId: "org_admin",
    memberId: "mem_admin",
    organizationCode: "clinic-mfa-new",
    loginId: "admin",
    globalRoles: ["org_admin"],
    productRoles: { fee: ["admin"] },
    mfaRequired: true,
    mfaEnrolled: false,
    mfaVerified: false
  };
}

function verifiedAdminLogin() {
  return {
    session: {
      ...pendingAdminSession(),
      organizationCode: "clinic-mfa-ready",
      mfaEnrolled: true,
      mfaVerified: true
    },
    csrfToken: "verified-csrf-token",
    accessToken: "verified-access-token"
  };
}

function enrollmentChallenge() {
  return {
    mfa: {
      status: "pending",
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUrl: "otpauth://totp/Halunasu:admin?secret=JBSWY3DPEHPK3PXP",
      qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgo="
    }
  };
}

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
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
