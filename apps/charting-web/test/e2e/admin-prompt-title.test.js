import assert from "node:assert/strict";
import test from "node:test";
import {
  adminRoutes,
  appUrl,
  installGatewayMocks,
  withPage
} from "./helpers/e2e-utils.js";

test("prompt creation uses a unique default title and blocks duplicates", { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await installGatewayMocks(page, adminRoutes());
    await page.goto(appUrl("/admin?section=prompts"), { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "プロンプト設定" }).waitFor({ state: "visible" });
    await page.getByText("新しいプロンプト(2)", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "プロンプトを作成" }).click();

    const nameInput = page.locator(".prompt-name-field input").first();
    await nameInput.waitFor({ state: "visible" });
    assert.equal(await nameInput.inputValue(), "新しいプロンプト(3)");

    await nameInput.fill("新しいプロンプト");
    await page.getByText("同じ名前のプロンプトが既にあります。別の名前にしてください。").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "下書きを保存" }).isDisabled(), true);

    await nameInput.fill("新しいプロンプト(3)");
    await page.getByText("同じ病院内で同じ名前は使えません。").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "下書きを保存" }).click();

    await page.getByRole("heading", { name: "プロンプト名を確認" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "名前を編集する" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "このまま保存する" }).waitFor({ state: "visible" });
  });
});
