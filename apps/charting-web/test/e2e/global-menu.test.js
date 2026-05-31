import assert from "node:assert/strict";
import test from "node:test";
import {
  adminRoutes,
  appUrl,
  encounterRoutes,
  installGatewayMocks,
  withPage
} from "./helpers/e2e-utils.js";

test("global menu centralizes clinical and settings navigation", { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await installGatewayMocks(page, [...adminRoutes(), ...encounterRoutes()]);
    await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "書き起こし" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "メニューを開く" }).click();
    await page.getByRole("link", { name: /診療セッション/ }).waitFor({ state: "visible" });
    const promptsLink = page.getByRole("link", { name: /^プロンプト設定/ });
    const membersLink = page.getByRole("link", { name: /^権限管理/ });
    const audioTestLink = page.getByRole("link", { name: /^音声テスト/ });
    await promptsLink.waitFor({ state: "visible" });
    await membersLink.waitFor({ state: "visible" });
    await audioTestLink.waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("設定画面を開く").count(), 0);
  });
});

test("global settings drawer scrolls independently", { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await installGatewayMocks(page, [...adminRoutes(), ...encounterRoutes()]);
    await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "書き起こし" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "メニューを開く" }).click();
    const drawerNav = page.locator(".admin-nav-drawer .admin-sidebar-nav");
    await drawerNav.waitFor({ state: "visible" });
    const overflowY = await drawerNav.evaluate((element) => getComputedStyle(element).overflowY);
    assert.equal(overflowY, "auto");

    const accountLink = drawerNav.getByRole("link", { name: /^アカウント/ });
    await accountLink.scrollIntoViewIfNeeded();
    await accountLink.click();
    await page.waitForURL(/section=account/);
    await page.getByRole("button", { name: /施設管理画面を開く/ }).waitFor({ state: "visible" });
  }, { viewport: { width: 1280, height: 420 } });
});
