// 実際の platform-api / eye-api（メモリストア）と Next 開発サーバーを起動し、
// ログイン → 初診作成・確定 → 再診（前回引き継ぎ・差分）→ 経過 → 印刷 → 設定 → 権限 を通しで確認する。
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(root, "../..");
const { LOCAL_ORGANIZATION_CODE, LOCAL_PASSWORD, currentLocalTotp, startLocalEyeStack } = await import(resolve(repositoryRoot, "scripts/dev_eye_stack.mjs"));

const [platformPort, eyePort, webPort] = await Promise.all([findOpenPort(), findOpenPort(), findOpenPort()]);
const stack = await startLocalEyeStack({ platformPort, eyePort });
const baseUrl = `http://127.0.0.1:${webPort}`;
const server = spawn("npx", ["next", "dev", "--hostname", "127.0.0.1", "--port", String(webPort)], {
  cwd: root,
  env: {
    ...process.env,
    HALUNASU_ENV: "local",
    PLATFORM_PROXY_TARGET: `http://127.0.0.1:${platformPort}`,
    EYE_PROXY_TARGET: `http://127.0.0.1:${eyePort}`,
    NEXT_PUBLIC_PLATFORM_BASE_URL: "/api/platform",
    NEXT_PUBLIC_EYE_BASE_URL: "/api/eye",
    NEXT_TELEMETRY_DISABLED: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

try {
  await waitForHttp(baseUrl, 60_000);
  const browser = await launchBrowser();
  try {
    await runDoctorFlow(browser);
    await runReceptionFlow(browser);
    await runOrthoptistFlow(browser);
  } finally {
    await browser.close().catch(() => null);
  }
} catch (error) {
  console.error(serverOutput.slice(-4000));
  throw error;
} finally {
  server.kill("SIGTERM");
  await stack.close();
}

console.log("Eye web UI smoke passed");

async function runDoctorFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page, "director");
  await page.getByRole("heading", { name: "受診一覧" }).waitFor();

  await page.getByRole("link", { name: /見本 花子/ }).click();
  await page.getByRole("button", { name: "初診カルテを作成" }).click();
  await page.getByRole("heading", { name: "検査", exact: true }).waitFor();
  await page.getByLabel("診療日").fill("2026-07-28");
  await page.getByRole("textbox", { name: "主訴", exact: true }).fill("緑内障の定期検査");
  await page.getByLabel("右眼 矯正視力").fill("1.0");
  await page.getByLabel("左眼 矯正視力").fill("0.9");
  await page.getByLabel("右眼 眼圧", { exact: true }).fill("18");
  await page.getByLabel("左眼 眼圧", { exact: true }).fill("16");
  await page.getByRole("button", { name: "アレルギー・病名" }).click();
  await page.getByRole("button", { name: "アレルギーを追加" }).click();
  await page.getByLabel("原因").fill("ペニシリン系");
  await page.getByLabel("症状").fill("発疹");
  await page.getByRole("button", { name: "傷病名を追加" }).click();
  await page.getByRole("combobox", { name: "傷病名" }).fill("原発開放隅角緑内障");
  await page.getByLabel("開始日").fill("2026-07-28");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await page.getByText("アレルギー: ペニシリン系（発疹）").first().waitFor();
  await page.locator(".dx-list").getByText("原発開放隅角緑内障").waitFor();
  await page.getByRole("textbox", { name: "方針", exact: true }).fill("点眼継続");
  await page.getByLabel("次回まで（週）").fill("12");
  await page.getByRole("button", { name: "処方を追加" }).click();
  await page.getByRole("combobox", { name: "薬剤名", exact: true }).fill("ラタノプロスト点眼液0.005%");
  await page.getByLabel("1日の回数").fill("1");
  await page.getByRole("button", { name: "2本を反映" }).click();
  await page.getByRole("button", { name: "シェーマを追加" }).click();
  await drawStroke(page);
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "右眼を確認" }).click();
  await page.getByRole("button", { name: "左眼を確認" }).click();
  await page.getByText(/確認済み（/u).nth(1).waitFor();
  await page.getByRole("button", { name: "確定する" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "確定する" }).click();
  await page.getByText("確定 v1").first().waitFor();

  await page.getByRole("link", { name: /カルテ一覧/ }).click();
  await page.getByRole("button", { name: /本日のカルテを作成/ }).click();
  await page.getByRole("heading", { name: "前回との比較" }).waitFor();
  await page.locator(".history-card").first().waitFor();
  assert.equal(await page.getByLabel("右眼 眼圧", { exact: true }).inputValue(), "", "measurements must not be copied");
  assert.equal(await page.getByRole("combobox", { name: "薬剤名", exact: true }).inputValue(), "ラタノプロスト点眼液0.005%");
  await page.getByLabel("右眼 矯正視力").fill("0.8");
  await page.getByLabel("右眼 眼圧", { exact: true }).fill("23");
  await page.getByText("21 mmHg を超えています").waitFor();
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await page.getByText("右眼の検査値が未確認です。").first().waitFor();
  await page.getByRole("button", { name: "右眼を確認" }).click();
  assert.equal(await page.getByRole("button", { name: "左眼を確認" }).count(), 0, "an eye without values needs no confirmation");
  await page.locator(".encounter-side .readiness .is-blocker").first().waitFor({ state: "detached" });
  const changes = await page.locator(".changes").innerText();
  assert.match(changes, /右眼 矯正視力[\s\S]*1\.0[\s\S]*0\.8/u);
  assert.match(changes, /右眼 眼圧[\s\S]*18[\s\S]*23/u);
  await page.getByRole("button", { name: "確定する" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "確定する" }).click();
  await page.getByText("確定 v1").first().waitFor();
  const encounterUrl = page.url();

  await page.getByRole("link", { name: /カルテ一覧/ }).click();
  await page.getByRole("img", { name: "眼圧の推移" }).waitFor();
  await page.getByText("アレルギー: ペニシリン系（発疹）").first().waitFor();
  assert.equal(await page.locator(".history-row").count(), 2);

  const printPage = await context.newPage();
  await printPage.goto(`${encounterUrl}/print`);
  await printPage.getByRole("button", { name: "印刷する" }).waitFor();
  assert.equal(await printPage.locator(".print-sketches polyline").count() > 0, true, "copied sketch strokes are printed");
  await printPage.close();

  await page.goto(`${baseUrl}/settings`);
  await page.locator("form.add-row").getByLabel("薬剤名").fill("ヒアレイン点眼液0.1%");
  await page.getByLabel("1本あたりの滴数").fill("120");
  await page.locator("form.add-row").filter({ has: page.getByLabel("1本あたりの滴数") }).getByRole("button", { name: "追加" }).click();
  await page.getByText("を保存しました").waitFor();
  await page.getByText("カルテを確定").first().waitFor();

  // 画像・紙カルテの取り込み（開発用のメモリ保管で同じ流れを通す）
  const fixtures = mkdtempSync(join(tmpdir(), "eye-smoke-"));
  const pngPath = join(fixtures, "oct.png");
  writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const jpegPath = join(fixtures, "paper.jpg");
  writeFileSync(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
  await page.goto(`${baseUrl}/`);
  await page.getByLabel("患者検索").fill("見本");
  await page.locator(".patient-row").filter({ hasText: "見本 花子" }).click();
  await page.getByRole("heading", { name: "画像・ファイル" }).waitFor();
  await page.getByLabel("ファイル", { exact: true }).setInputFiles(pngPath);
  await page.getByLabel("ファイルの種類").selectOption("oct");
  await page.getByLabel("ファイルの題名").fill("OCT 黄斑");
  await page.getByRole("button", { name: "取り込む" }).click();
  await page.getByRole("button", { name: "OCT 黄斑" }).click();
  await page.locator(".dialog-viewer img.file-preview").waitFor();
  await page.getByRole("button", { name: "閉じる" }).click();
  await page.getByLabel("ファイル", { exact: true }).setInputFiles(jpegPath);
  await page.getByLabel("ファイルの種類").selectOption("paper_chart");
  await page.getByLabel("ファイルの題名").fill("紙カルテ 2019");
  await page.getByRole("button", { name: "取り込む" }).click();
  await page.getByRole("button", { name: "紙カルテ 2019" }).click();
  await page.locator(".paper-summary textarea").fill("2019年 緑内障と診断。ラタノプロスト開始。");
  await page.getByRole("button", { name: "要約を保存" }).click();
  await page.getByRole("button", { name: "要約を確認済みにする" }).click();
  await page.getByText(/医師確認済み（/u).first().waitFor();
  await page.getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("link", { name: "比較表示" }).click();
  await page.getByRole("heading", { name: /画像の比較/ }).waitFor();
  await page.locator(".compare-grid img.file-preview").first().waitFor();
  await page.goto(`${baseUrl}/settings`);

  // 定型文とセットを登録して、新しいカルテで使う
  await page.getByLabel("差し込む欄").selectOption("plan");
  await page.getByLabel("定型文").fill("点眼継続。次回同様。");
  await page.locator("form.add-row").filter({ has: page.getByLabel("定型文") }).getByRole("button", { name: "追加" }).click();
  await page.getByRole("cell", { name: "点眼継続。次回同様。" }).waitFor();
  await page.getByRole("button", { name: "セットを追加" }).click();
  await page.getByLabel("セット名").fill("緑内障 定期");
  await page.locator(".set-editor").getByRole("button", { name: "検査を追加" }).click();
  await page.locator(".set-editor").getByRole("button", { name: "セットを保存" }).click();
  await page.getByText("緑内障 定期").first().waitFor();

  await page.goto(`${baseUrl}/`);
  await page.getByLabel("患者検索").fill("見本");
  await page.locator(".patient-row").filter({ hasText: "見本 花子" }).click();
  await page.getByRole("heading", { name: "経過" }).waitFor();
  await page.getByRole("button", { name: /本日のカルテを作成/ }).click();
  await page.getByRole("tab", { name: "候補" }).click();
  await page.getByRole("button", { name: /緑内障 定期/ }).click();
  await page.getByText("セット「緑内障 定期」を追加しました。").waitFor();
  await page.locator(".order-row").first().waitFor();
  await page.locator(".phrase-row").getByRole("button", { name: "挿入" }).click();
  assert.match(await page.getByRole("textbox", { name: "方針", exact: true }).inputValue(), /点眼継続。次回同様。/u);
  // 眼鏡処方
  await page.getByLabel("眼鏡・CL の種類").selectOption("glasses");
  await page.getByLabel("右眼 S", { exact: true }).fill("-2");
  await page.getByLabel("左眼 S", { exact: true }).fill("-1.5");
  await page.getByLabel("瞳孔間距離").fill("62");
  await page.getByText("今回眼鏡処方箋を発行する").click();
  await page.getByRole("link", { name: "眼鏡処方箋を印刷" }).waitFor();
  assert.equal(await page.locator("#optical-heading ~ div .readiness .is-blocker").count(), 0);
  await page.getByRole("button", { name: "左右に分ける" }).first().click();
  assert.deepEqual(await page.getByRole("combobox", { name: "処方の眼" }).evaluateAll((items) => items.map((item) => item.value)).then((values) => values.slice(0, 2)), ["od", "os"]);
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  const opticalPage = await context.newPage();
  await opticalPage.goto(`${page.url()}/optical`);
  await opticalPage.getByRole("heading", { name: "眼鏡処方箋" }).waitFor();
  assert.equal(await opticalPage.getByText("-2.00").count() > 0, true);
  await opticalPage.close();

  // 紹介状を作成・確定・印刷
  await page.getByRole("tab", { name: "文書" }).click();
  await page.getByRole("button", { name: "紹介状を作成" }).click();
  await page.getByRole("heading", { name: /診療情報提供書/ }).waitFor();
  assert.match(await page.locator("textarea.document-body").inputValue(), /アレルギー・副作用歴】\nペニシリン系（発疹）/u);
  await page.getByLabel("宛先 医療機関").fill("県立中央病院");
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "確定する" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "確定する" }).click();
  await page.getByRole("button", { name: "複製して修正" }).waitFor();
  const letter = await context.newPage();
  await letter.goto(`${page.url()}/print`);
  await letter.getByText("県立中央病院").waitFor();
  await letter.close();

  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function runReceptionFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page, "clerk");
  await page.goto(`${baseUrl}/reception`);
  await page.getByRole("heading", { name: "受付", exact: true }).waitFor();

  // 予約済みの再診患者
  await page.getByRole("button", { name: "予約を追加" }).click();
  await page.getByLabel("患者を検索").fill("試験");
  await page.getByRole("button", { name: /試験 一郎/ }).click();
  await page.locator('input[type="time"]').fill("09:30");
  await page.getByRole("button", { name: "予約する" }).click();
  await page.getByRole("cell", { name: "試験 一郎" }).waitFor();
  await page.getByRole("button", { name: "受付する" }).click();
  await page.locator(".board-checked_in .board-card").filter({ hasText: "試験 一郎" }).waitFor();

  // 予約なし・未登録の当日受付 → 患者登録
  await page.getByRole("button", { name: "当日受付" }).click();
  await page.getByLabel("患者を検索").fill("飛込 花子");
  await page.getByRole("button", { name: "受け付ける" }).click();
  const walkIn = page.locator(".board-card").filter({ hasText: "飛込 花子" });
  await walkIn.waitFor();
  assert.equal((await walkIn.locator(".queue-number").innerText()).trim(), "2");
  await walkIn.getByRole("button", { name: "患者登録" }).click();
  await page.getByRole("button", { name: "登録して受付に紐づける" }).click();
  await walkIn.getByRole("button", { name: "カルテ作成" }).waitFor();

  // 進捗ボードを進める
  const card = page.locator(".board-card").filter({ hasText: "試験 一郎" });
  await card.getByRole("button", { name: "検査開始" }).click();
  await page.locator(".board-in_exam .board-card").filter({ hasText: "試験 一郎" }).waitFor();
  await card.getByRole("button", { name: "検査終了" }).click();
  await page.locator(".board-waiting_doctor .board-card").filter({ hasText: "試験 一郎" }).waitFor();

  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function runOrthoptistFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const page = await context.newPage();
  await login(page, "orthoptist");
  await page.getByRole("link", { name: /試験 一郎/ }).click();
  await page.getByRole("button", { name: "初診カルテを作成" }).click();
  await page.getByRole("heading", { name: "検査", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "確定する" }).count(), 0, "orthoptists cannot finalize");
  await page.getByText("確定は医師が行います").waitFor();

  // 検査員用の画面で値を入れて確認、散瞳を開始、オーダーを実施する
  await page.goto(`${page.url()}/exam`);
  await page.getByRole("heading", { name: "検査値" }).waitFor();
  await page.getByLabel("右眼 矯正視力").fill("0.7");
  await page.getByLabel("右眼 眼圧", { exact: true }).fill("14");
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "両眼の検査値を確認済みにする" }).click();
  await page.getByText(/確認済み（視能訓練士/u).first().waitFor();
  await page.getByRole("button", { name: "両眼散瞳を開始" }).click();
  await page.getByText(/散瞳（両眼） 0分経過/u).waitFor();
  await page.getByRole("button", { name: "オーダーを追加" }).click();
  await page.locator(".order-row").getByRole("button", { name: "実施" }).click();
  await page.locator(".order-row .order-status-performed").waitFor();
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await context.close();
}

async function login(page, loginId) {
  await page.goto(baseUrl);
  await page.getByLabel("病院コード").fill(LOCAL_ORGANIZATION_CODE);
  await page.getByLabel("個人ID").fill(loginId);
  await page.getByLabel("ログイン用パスワード", { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.getByLabel("6桁コード").fill(currentLocalTotp());
  await page.getByRole("button", { name: "確認" }).click();
}

async function drawStroke(page) {
  const canvas = page.locator(".encounter-form .sketch-canvas").first();
  // hover で画面内に入れてから座標を取り直す（固定ヘッダーの下に隠れないよう中央付近を使う）。
  await canvas.hover({ position: { x: 150, y: 150 } });
  const box = await canvas.boundingBox();
  const startX = box.x + box.width * 0.4;
  const startY = box.y + box.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(startX + step * 8, startY + step * 5);
  }
  await page.mouse.up();
  await page.locator(".encounter-form .sketch-canvas polyline").first().waitFor();
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: "chrome" });
  }
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // 起動待ち
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function findOpenPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}
