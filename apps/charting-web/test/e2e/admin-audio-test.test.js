import assert from "node:assert/strict";
import test from "node:test";
import {
  adminRoutes,
  appUrl,
  assertNoPageHorizontalOverflow,
  installGatewayMocks,
  withPage
} from "./helpers/e2e-utils.js";

test("audio test settings validates microphone input without audio API calls", { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    const calls = await installGatewayMocks(page, adminRoutes());
    await page.goto(appUrl("/admin?section=audio-test"), { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "音声テスト" }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "マイク入力テスト" }).waitFor({ state: "visible" });
    await assertNoPageHorizontalOverflow(page, "audio test settings");
    await page.getByRole("button", { name: "テスト停止" }).waitFor({ state: "visible" });

    await page.getByRole("button", { name: "既定に保存" }).click();
    await page.getByText("このパソコンの既定マイクとして保存しました。").waitFor({ state: "visible" });
    await page.getByText("医療機関").waitFor({ state: "detached" });
    await page.getByText("入力がありません").waitFor({ state: "detached" });
    await page.getByText("入力は適正です").waitFor({ state: "detached" });
    await page.getByText("詳細テスト: 5秒録音して再生").waitFor({ state: "detached" });

    assert.equal(calls.some((call) => call.path.includes("audio-test")), false);
  });
});
