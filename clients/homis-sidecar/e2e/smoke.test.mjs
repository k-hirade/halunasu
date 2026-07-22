import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const requiredEnvironment = [
  "HOMIS_SIDECAR_E2E_ORG_CODE",
  "HOMIS_SIDECAR_E2E_LOGIN_ID",
  "HOMIS_SIDECAR_E2E_PASSWORD",
  "HOMIS_SIDECAR_E2E_TOTP_SECRET"
];
const enabled = process.env.HOMIS_SIDECAR_E2E === "1"
  && requiredEnvironment.every((name) => process.env[name]);

test("patient 1006 can authorize, auto-read, and calculate through the side panel", {
  skip: enabled ? false : "Set HOMIS_SIDECAR_E2E=1 and STG credential environment variables"
}, async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const extensionPath = path.resolve(here, "../extension");
  const profilePath = path.join(os.tmpdir(), `homis-sidecar-e2e-${crypto.randomUUID()}`);
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  try {
    const mockUrl = process.env.HOMIS_SIDECAR_E2E_MOCK_URL
      || "http://localhost:8899/homic/?pid=patient_detail&patient_id=1006";
    const mockPage = await context.newPage();
    await mockPage.goto(mockUrl);
    await mockPage.locator("#pdetail_karte[data-record-id]").waitFor();

    const extensionId = "nhbmaniknlcaaelpaoogepmkhphmmjof";
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.getByRole("button", { name: "接続を開始" }).click();
    await panel.locator("#device-code").filter({ hasText: /[A-Z2-9]{4}-[A-Z2-9]{4}/ }).waitFor();
    const approvalUrl = await panel.locator("#approval-link").getAttribute("href");
    assert.ok(approvalUrl);

    const approvalPage = await context.newPage();
    await approvalPage.goto(approvalUrl);
    await approvalPage.locator("#organizationCode").fill(process.env.HOMIS_SIDECAR_E2E_ORG_CODE);
    await approvalPage.locator("#loginId").fill(process.env.HOMIS_SIDECAR_E2E_LOGIN_ID);
    await approvalPage.locator("#password").fill(process.env.HOMIS_SIDECAR_E2E_PASSWORD);
    await approvalPage.getByRole("button", { name: "ログイン" }).click();
    await approvalPage.locator("#mfaCode").fill(totp(process.env.HOMIS_SIDECAR_E2E_TOTP_SECRET));
    await approvalPage.getByRole("button", { name: "確認", exact: true }).click();
    await approvalPage.getByRole("heading", { name: "HOMIS連携端末" }).waitFor();
    await approvalPage.getByRole("button", { name: "承認", exact: true }).click();

    await panel.locator("#connection-badge").filter({ hasText: "接続済み" }).waitFor({ timeout: 30_000 });
    await panel.locator("#preview-patient").filter({ hasText: "1006" }).waitFor();
    assert.equal(await panel.locator('input[name="setting"][value="home_visit"]').isChecked(), true);
    assert.match(await panel.locator("#setting-copy").textContent(), /画面の.+定期.+定期訪問/);
    assert.equal(await panel.locator('input[name="same-building"][value="outside"]').isChecked(), true);
    assert.match(await panel.locator("#same-building-copy").textContent(), /個人宅.+同一建物以外/);

    await panel.locator("#extract-button").click();
    await panel.locator("#extract-button").filter({ hasText: "再読み取り" }).waitFor();
    assert.equal(await panel.locator('input[name="setting"][value="home_visit"]').isChecked(), true);
    assert.equal(await panel.locator('input[name="same-building"][value="outside"]').isChecked(), true);

    const switchedMockUrl = new URL(mockUrl);
    switchedMockUrl.searchParams.set("patient_id", "1001");
    await mockPage.goto(switchedMockUrl.toString());
    await mockPage.locator("#pdetail_karte[data-record-id]").waitFor();
    await panel.locator("#preview-patient").filter({ hasText: "1001" }).waitFor();

    await mockPage.goto(mockUrl);
    await mockPage.locator("#pdetail_karte[data-record-id]").waitFor();
    await panel.locator("#preview-patient").filter({ hasText: "1006" }).waitFor();
    assert.equal(await panel.locator('input[name="setting"][value="home_visit"]').isChecked(), true);
    assert.equal(await panel.locator('input[name="same-building"][value="outside"]').isChecked(), true);

    await panel.getByRole("button", { name: "算定案を作成" }).click();
    await panel.locator("#result-section").waitFor({ state: "visible", timeout: 120_000 });
    assert.match(await panel.locator("#total-points").textContent(), /\d[\d,]*点/);
    const rows = panel.locator(".candidate-row").filter({ hasNotText: "候補はありません" });
    assert.ok(await rows.count() >= 1);
  } finally {
    await context.close();
    await rm(profilePath, { recursive: true, force: true });
  }
});

function totp(secretInput, time = Date.now()) {
  const secret = decodeBase32(secretInput);
  const counter = Math.floor(time / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const character of normalized) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}
