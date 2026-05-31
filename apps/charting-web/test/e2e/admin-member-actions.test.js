import assert from "node:assert/strict";
import test from "node:test";
import {
  adminRoutes,
  appUrl,
  installGatewayMocks,
  withPage
} from "./helpers/e2e-utils.js";

test("member permissions screen exposes safe action modals", { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await installGatewayMocks(page, adminRoutes());
    await page.goto(appUrl("/admin?section=members"), { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "権限管理" }).waitFor({ state: "visible" });
    const row = page.locator(".admin-member-row").filter({ hasText: "五志 太郎" }).first();
    await row.getByText("病院管理者").waitFor({ state: "visible" });
    const roleChips = row.locator(".member-role-chip-list .member-role-chip");
    assert.ok(await roleChips.count() >= 2);
    const firstRoleBox = await roleChips.nth(0).boundingBox();
    const secondRoleBox = await roleChips.nth(1).boundingBox();
    assert.ok(firstRoleBox);
    assert.ok(secondRoleBox);
    assert.ok(secondRoleBox.y > firstRoleBox.y);

    const promptValueOverflow = await row.locator(".member-prompt-assignment .admin-select-value").evaluate((element) => getComputedStyle(element).overflow);
    assert.equal(promptValueOverflow, "hidden");

    await row.getByRole("button", { name: "権限変更" }).click();
    await page.getByRole("heading", { name: "権限を変更" }).waitFor({ state: "visible" });
    await page.getByRole("checkbox", { name: "病院管理者" }).uncheck();
    await page.getByRole("button", { name: "権限を保存" }).click();
    await page.getByText("五志 太郎の権限を変更しました。").waitFor({ state: "visible" });

    await row.getByLabel("五志 太郎のプロンプト割当").click();
    await page.getByRole("option", { name: /^病院標準/ }).click();
    await page.getByText("プロンプト割当を保存しました。").waitFor({ state: "visible" });

    await row.getByRole("button", { name: "その他" }).click();
    await page.getByRole("heading", { name: "五志 太郎の操作" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: /パスワード再設定/ }).click();
    await page.getByRole("heading", { name: "パスワード再設定" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "安全なパスワードを作る" }).click();
    const generated = await page.getByLabel("新しいパスワード").inputValue();
    assert.ok(generated.length >= 18);
    await page.getByRole("button", { name: "コピー" }).click();
    assert.equal(await page.evaluate(() => window.__lastClipboardText || ""), generated);
    await page.getByRole("button", { name: "再設定する" }).click();
    await page.getByText("この画面を閉じると再表示できません。").waitFor({ state: "visible" });
    await page.locator(".admin-modal-footer").getByRole("button", { name: "閉じる", exact: true }).click();

    await row.getByRole("button", { name: "その他" }).click();
    await page.getByRole("heading", { name: "五志 太郎の操作" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: /アカウントを停止/ }).click();
    await page.getByRole("heading", { name: "アカウントを停止" }).waitFor({ state: "visible" });
    await page.getByText("ログインできなくなります").waitFor({ state: "visible" });
  });
});
