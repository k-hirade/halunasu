import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexUrl = pathToFileURL(join(root, "index.html")).href;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(indexUrl);

  assert.equal(await text(page, "#login-form h1"), "ログイン");

  await page.locator("#login-gate").evaluate((element) => element.classList.add("hidden"));
  await page.locator("#app-shell").evaluate((element) => element.classList.remove("hidden"));

  assert.equal(await page.locator(".site-nav-wrap").count(), 1);
  assert.equal(await text(page, ".dashboard-header h1"), "算定一覧");
  assert.equal(await text(page, "#start-fee-session-button"), "算定記録を作成");

  await page.evaluate(() => {
    showDetailRoute();
    state.facilities = [{ facilityId: "fac_demo", displayName: "ハルナスデモクリニック", medicalInstitutionCode: "001" }];
    renderFacilities();
    state.orderRows = [createEmptyOrderRow()];
    renderOrderEditor();
  });

  assert.equal(await page.locator("#facility-field").evaluate((element) => element.classList.contains("is-hidden")), true);
  assert.equal(await page.locator(".order-editor-row").count(), 1);

  await page.locator('[data-order-field="orderType"]').selectOption("lab");
  await page.locator('[data-order-field="localName"]').fill("血液検査");
  await page.locator('[data-order-field="standardCode"]').fill("160000410");
  await page.locator('[data-order-field="quantity"]').fill("1");

  assert.equal(await page.locator("#ordersText").inputValue(), "lab|血液検査|160000410|1");

  await page.setViewportSize({ width: 390, height: 900 });
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(hasHorizontalOverflow, false);
} finally {
  await browser.close();
}

console.log("Fee web UI smoke passed");

async function text(page, selector) {
  return (await page.locator(selector).textContent()).trim();
}
