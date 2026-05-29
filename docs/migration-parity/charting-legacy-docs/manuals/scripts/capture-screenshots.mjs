import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const manualsDir = path.resolve(scriptDir, "..");
const outputDir = path.resolve(process.env.MANUAL_SCREENSHOT_DIR || path.join(manualsDir, "assets/screenshots/v1"));

const config = {
  webBaseUrl: trimTrailingSlash(process.env.MANUAL_WEB_BASE_URL || "http://localhost:3000"),
  gatewayBaseUrl: trimTrailingSlash(process.env.MANUAL_GATEWAY_BASE_URL || "http://localhost:8081"),
  organizationCode: process.env.MANUAL_ORG_CODE || "clinic_tokyo_001",
  loginId: process.env.MANUAL_LOGIN_ID || "admin",
  password: process.env.MANUAL_PASSWORD || "Manual-password-1!",
  mfaSecret: String(process.env.MANUAL_MFA_SECRET || "").trim()
};

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(value) {
  const normalized = String(value || "")
    .replace(/=+$/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();
  let bits = 0;
  let buffer = 0;
  const bytes = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);

    if (index === -1) {
      throw new Error("Invalid base32 value.");
    }

    buffer = (buffer << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateTotpCode(secret, { now = Date.now(), periodSeconds = 30, digits = 6 } = {}) {
  const counter = Math.floor(now / 1000 / periodSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    (((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)) %
    10 ** digits;

  return String(code).padStart(digits, "0");
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch {
    throw new Error("Playwright is not installed. Run `npm install --save-dev playwright` and `npx playwright install chromium`.");
  }
}

async function screenshot(page, fileName) {
  const filePath = path.join(outputDir, fileName);
  await page.screenshot({
    path: filePath,
    fullPage: true,
    animations: "disabled"
  });
  console.log(`Wrote ${path.relative(process.cwd(), filePath)}`);
}

async function clickIfVisible(locator, timeout = 1200) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function waitForAny(page, patterns, timeout = 15000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeout) {
    for (const pattern of patterns) {
      try {
        const locator = page.getByText(pattern, { exact: false }).first();
        await locator.waitFor({ state: "visible", timeout: 500 });
        return locator;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error(`None of the expected texts appeared: ${patterns.join(", ")}`);
}

async function callSessionApi(page, sessionId, route, body = {}) {
  return page.evaluate(async ({ gatewayBaseUrl, sessionId: currentSessionId, route: currentRoute, body: currentBody }) => {
    const token = window.localStorage.getItem("medical.operatorAccessToken.v2");
    const csrfCookie = document.cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("soaplane_operator_csrf="));
    const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.slice("soaplane_operator_csrf=".length)) : "";
    const response = await fetch(`${gatewayBaseUrl}/api/v1/sessions/${currentSessionId}${currentRoute}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(currentBody)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`API ${currentRoute} failed: ${response.status} ${text}`);
    }

    return response.json();
  }, {
    gatewayBaseUrl: config.gatewayBaseUrl,
    sessionId,
    route,
    body
  });
}

async function login(page) {
  await page.goto(config.webBaseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#operatorOrganizationCode").waitFor({ state: "visible", timeout: 15000 });
  await screenshot(page, "login.png");

  await page.fill("#operatorOrganizationCode", config.organizationCode);
  await page.fill("#operatorLoginId", config.loginId);
  await page.fill("#operatorPassword", config.password);
  await page.getByRole("button", { name: "ログイン" }).click();

  try {
    await page.getByRole("heading", { name: "診療セッション" }).waitFor({ state: "visible", timeout: 4000 });
    return;
  } catch {
    // Fall through to MFA handling.
  }

  if (await page.getByRole("heading", { name: "認証アプリを登録" }).isVisible().catch(() => false)) {
    const secret = (await page.locator("#operatorMfaSecret").inputValue().catch(() => "")) || config.mfaSecret;

    if (!secret) {
      throw new Error("MFA enrollment is required but no TOTP secret is available.");
    }

    await page.fill("#operatorMfaCode", generateTotpCode(secret));
    await page.getByRole("button", { name: "確認" }).click();
  } else if (await page.getByRole("heading", { name: "確認コード" }).isVisible().catch(() => false)) {
    if (!config.mfaSecret) {
      throw new Error("MFA verification is required. Set MANUAL_MFA_SECRET or reset MFA enrollment first.");
    }

    await page.fill("#operatorMfaCode", generateTotpCode(config.mfaSecret));
    await page.getByRole("button", { name: "確認" }).click();
  }

  await page.getByRole("heading", { name: "診療セッション" }).waitFor({ state: "visible", timeout: 15000 });
}

async function createSession(page) {
  await screenshot(page, "sessions.png");
  await page.getByRole("button", { name: "診療を開始" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 15000 });
  const sessionId = new URL(page.url()).pathname.split("/").filter(Boolean).pop();
  await page.getByRole("heading", { name: "診療記録" }).waitFor({ state: "visible", timeout: 15000 });
  await clickIfVisible(page.getByRole("button", { name: "閉じる" }));
  await screenshot(page, "encounter-before-recording.png");
  return sessionId;
}

async function capturePairing(page, context, sessionId) {
  const pairingButton = page.getByRole("button", { name: /QR \/ 接続|iPhoneを接続|録音スマホを接続/ }).first();
  const openedPairing = await clickIfVisible(pairingButton, 1500);

  if (!openedPairing) {
    return;
  }

  const choseMobile = await clickIfVisible(page.getByText("iPhoneで録音", { exact: true }).first());
  if (!choseMobile) {
    await page.getByRole("heading", { name: "録音スマホを接続してください" }).waitFor({ state: "visible", timeout: 10000 });
  }

  await page.getByRole("heading", { name: "録音スマホを接続してください" }).waitFor({ state: "visible", timeout: 10000 });
  await screenshot(page, "encounter-qr.png");

  const pairing = await page.evaluate((currentSessionId) => {
    const raw = window.sessionStorage.getItem(`medical.pairing.${currentSessionId}`);
    return raw ? JSON.parse(raw) : null;
  }, sessionId);

  if (!pairing?.pairingId || !pairing?.token) {
    throw new Error("Pairing token was not found in sessionStorage.");
  }

  const mobilePage = await context.newPage();
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await context.grantPermissions(["microphone"], { origin: config.webBaseUrl });
  await mobilePage.goto(`${config.webBaseUrl}/mobile/join#pairingId=${encodeURIComponent(pairing.pairingId)}&token=${encodeURIComponent(pairing.token)}`, {
    waitUntil: "domcontentloaded"
  });
  await waitForAny(mobilePage, ["録音開始待ち", "録音準備中", "マイクを許可してください", "録音用スマホ"], 20000);
  await mobilePage.waitForTimeout(1500);
  await screenshot(mobilePage, "mobile-recorder.png");
  await mobilePage.close();

  await clickIfVisible(page.getByRole("button", { name: "閉じる" }));
}

async function captureRecordingAndSoap(page, sessionId) {
  const localRecordButton = page.getByRole("button", { name: "この端末で録音" });
  const hasDirectLocalRecord = await localRecordButton.isVisible().catch(() => false);

  if (!hasDirectLocalRecord) {
    const changeRecordingMethodButton = page.getByRole("button", { name: "録音方法変更" });
    const openedChoice = await clickIfVisible(changeRecordingMethodButton, 1500);

    if (openedChoice) {
      await page.getByRole("button", { name: "このPCで録音" }).click();
    }
  }

  await page.getByRole("button", { name: "この端末で録音" }).click();
  await waitForAny(page, ["この端末で録音中", "録音中"], 15000);
  await screenshot(page, "encounter-recording.png");

  await page.getByRole("button", { name: "録音停止" }).click();
  await page.getByRole("button", { name: "録音を停止" }).click();
  await waitForAny(page, ["録音を停止しました", "SOAP下書きを作成", "次の操作を選んでください"], 15000);
  await page.getByRole("button", { name: "SOAP下書きを作成" }).click();
  await Promise.race([
    page.getByText("診療記録の内容を確認してください", { exact: false }).first().waitFor({ state: "visible", timeout: 30000 }),
    page.getByRole("button", { name: "確定する" }).waitFor({ state: "visible", timeout: 30000 }),
    page.locator(".editor-textarea--soap-output").first().waitFor({ state: "visible", timeout: 30000 })
  ]);
  await screenshot(page, "encounter-soap-ready.png");
}

async function captureAdmin(page) {
  await page.goto(`${config.webBaseUrl}/admin?section=members`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "権限管理" }).waitFor({ state: "visible", timeout: 15000 });
  await screenshot(page, "admin-members.png");

  await page.goto(`${config.webBaseUrl}/admin?section=formats`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "プロンプト設定" }).waitFor({ state: "visible", timeout: 15000 });
  await screenshot(page, "admin-prompts.png");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream"
    ]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 1
    });
    await context.grantPermissions(["microphone"], { origin: config.webBaseUrl });

    const page = await context.newPage();
    await login(page);
    const sessionId = await createSession(page);
    try {
      await capturePairing(page, context, sessionId);
    } catch (error) {
      console.warn(`Skipping pairing screenshots: ${error.message || error}`);
    }
    await captureRecordingAndSoap(page, sessionId);
    await captureAdmin(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
