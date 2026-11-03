// 実際の platform-api / eye-api（メモリストア）と Next 開発サーバーを起動し、
// ログイン → 初診作成・確定 → 再診（前回引き継ぎ・差分）→ 経過 → 印刷 → 設定 → 権限 を通しで確認する。
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  await page.getByRole("heading", { name: /本日の患者/u }).waitFor();

  await page.getByLabel("患者検索").fill("見本");
  await page.locator(".patient-row").filter({ hasText: "見本 花子" }).click();
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
  await page.getByRole("button", { name: "反映", exact: true }).click();
  assert.equal(await page.getByLabel("数量").inputValue(), "2");
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
  // Enter で 右眼 矯正視力 → 右眼 眼圧 → 左眼 裸眼視力 と進む
  await page.getByLabel("右眼 矯正視力").fill("0.8");
  await page.getByLabel("右眼 矯正視力").press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "右眼 眼圧");
  await page.keyboard.type("23");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "左眼 裸眼視力");
  await page.getByText("21 mmHg を超えています").waitFor();
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await page.getByText("右眼の検査値が未確認です。").first().waitFor();
  await page.getByRole("button", { name: "右眼を確認" }).click();
  assert.equal(await page.getByRole("button", { name: "左眼を確認" }).count(), 0, "an eye without values needs no confirmation");
  await page.locator(".encounter-side .readiness").getByText("右眼の検査値が未確認です。").waitFor({ state: "detached" });
  // 前回から引き継いだ処方は、確定ダイアログで内容を見てから確定する
  await page.locator(".rx-row.is-carried").getByText("前回から引き継ぎ").waitFor();
  await page.locator(".encounter-side .readiness").getByText("前回から引き継いだ処方 1件が未確認です。").waitFor();
  const changes = await page.locator(".changes").innerText();
  assert.match(changes, /右眼 矯正視力[\s\S]*1\.0[\s\S]*0\.8/u);
  assert.match(changes, /右眼 眼圧[\s\S]*18[\s\S]*23/u);
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.getByRole("dialog").getByText("前回から引き継ぎ").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "内容を確認して確定する" }).click();
  await page.getByText("確定 v1").first().waitFor();
  assert.equal(await page.locator(".rx-row.is-carried").count(), 0, "finalizing confirms carried-over prescriptions");
  const encounterUrl = page.url();

  await page.getByRole("link", { name: /カルテ一覧/ }).click();
  // 患者ページ: 前回の要点（前回差つき）→ 経過（グラフ + 1 受診 1 行の表）
  await page.locator(".trend-svg").waitFor();
  await page.getByText("アレルギー: ペニシリン系（発疹）").first().waitFor();
  assert.equal(await page.locator(".visit-rows .visit-row").count(), 2);
  assert.equal((await page.locator(".pt-eye-od .pt-delta").last().innerText()).trim(), "↑5", "IOP change against the previous finalized visit");
  assert.match(await page.locator(".visit-rows .visit-row").first().innerText(), /0\.8[\s\S]*23/u);
  assert.equal(await page.locator(".trend-svg .mark-started").count() > 0, true, "drop start is marked on the time axis");
  await page.locator('summary[aria-label="その他の操作"]').click();
  await page.getByRole("button", { name: /この患者のデータを出力/u }).waitFor();
  await page.locator('summary[aria-label="その他の操作"]').click();
  await page.locator(".visit-rows .visit-row").last().click();
  await page.waitForURL(/\/encounters\//u);
  await page.goBack();
  await page.locator(".trend-svg").waitFor();

  const printPage = await context.newPage();
  await printPage.goto(`${encounterUrl}/print`);
  await printPage.getByRole("button", { name: "印刷する" }).waitFor();
  assert.equal(await printPage.locator(".print-sketches polyline").count() > 0, true, "copied sketch strokes are printed");
  await printPage.close();

  // 設定: 薬剤を追加 → 1本で何日分の表示 → 既存の薬剤を編集 → 停止・再開
  await page.goto(`${baseUrl}/settings`);
  await page.getByRole("button", { name: "＋ 薬剤を追加" }).click();
  const drugPanel = page.getByRole("complementary", { name: "薬剤の編集" });
  await drugPanel.getByLabel("薬剤名").fill("ヒアレイン点眼液0.1%");
  await drugPanel.getByLabel("1日の回数").fill("6");
  await drugPanel.getByLabel("1本あたりの滴数").fill("120");
  await drugPanel.getByText("両眼 約10日分").waitFor();
  await drugPanel.getByRole("button", { name: "保存", exact: true }).click();
  await drugPanel.getByText("保存しました").waitFor();
  const hyaleinRow = page.locator(".master-row").filter({ hasText: "ヒアレイン点眼液0.1%" });
  await hyaleinRow.filter({ hasText: "1日6回" }).waitFor();
  await drugPanel.getByRole("button", { name: "閉じる", exact: true }).click();
  await hyaleinRow.click();
  await drugPanel.getByLabel("1日の回数").fill("4");
  await drugPanel.getByRole("button", { name: "保存", exact: true }).click();
  await hyaleinRow.filter({ hasText: "1日4回" }).waitFor();
  await drugPanel.getByRole("button", { name: "停止する" }).click();
  await page.locator(".master-inactive").getByRole("button", { name: /停止中/ }).waitFor();
  await drugPanel.getByRole("button", { name: "再開する" }).click();
  await drugPanel.getByRole("button", { name: "停止する" }).waitFor();
  assert.equal(await page.locator(".master-inactive").count(), 0, "a resumed drug leaves the stopped group");
  // 保存していない変更があると、別の項目へ移る前に確認する
  await drugPanel.getByLabel("既定の用法").fill("1日4回");
  await page.locator(".settings-nav-item", { hasText: "操作記録" }).click();
  await page.getByText("保存していない変更があります。", { exact: false }).first().waitFor();
  await page.getByRole("button", { name: "変更を破棄して移動" }).click();
  await page.waitForURL(/#audit$/u);
  await page.getByRole("cell", { name: "カルテを確定" }).first().waitFor();
  await page.getByRole("cell", { name: "ヒアレイン点眼液0.1%" }).first().waitFor();
  assert.match(await page.locator(".audit-range-line").innerText(), /の記録/u);
  await page.getByRole("group", { name: "種類で絞り込む" }).getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("cell", { name: "薬剤設定を保存" }).first().waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll(".audit-event")].some((cell) => cell.textContent === "カルテを確定"));
  await page.getByRole("group", { name: "種類で絞り込む" }).getByRole("button", { name: "すべて", exact: true }).click();
  await page.getByLabel("患者で絞り込む").fill("見本");
  await page.getByLabel("患者で絞り込む").press("Enter");
  await page.locator(".audit-patient-chip, .audit-patient-choices").first().waitFor();
  if (await page.locator(".audit-patient-choices").count()) await page.locator(".audit-patient-choices").getByRole("button", { name: /見本 花子/ }).click();
  await page.locator(".audit-patient-chip").filter({ hasText: "見本 花子" }).waitFor();
  await page.getByRole("link", { name: "見本 花子" }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".audit-range-line")?.textContent.includes("読み込み中"));
  assert.equal(await page.getByRole("cell", { name: "薬剤設定を保存" }).count(), 0, "the patient filter hides settings changes");

  // 画像・紙カルテの取り込み（開発用のメモリ保管で同じ流れを通す）
  const fixtures = mkdtempSync(join(tmpdir(), "eye-smoke-"));
  const pngPath = join(fixtures, "oct.png");
  writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const jpegPath = join(fixtures, "paper.jpg");
  writeFileSync(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
  await page.goto(`${baseUrl}/`);
  await page.getByLabel("患者検索").fill("見本");
  await page.locator(".patient-row").filter({ hasText: "見本 花子" }).click();
  await page.getByRole("heading", { name: /^画像/u }).waitFor();
  // 取り込みは「＋取込」からダイアログで行う
  async function uploadFile(path, fields) {
    await page.getByRole("button", { name: "＋取込" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("ファイル", { exact: true }).setInputFiles(path);
    await dialog.getByLabel("ファイルの種類").selectOption(fields.kind);
    if (fields.eye !== undefined) await dialog.getByLabel("ファイルの眼").selectOption(fields.eye);
    if (fields.takenOn) await dialog.getByLabel("検査日").fill(fields.takenOn);
    await dialog.getByLabel("ファイルの題名").fill(fields.title);
    await dialog.getByRole("button", { name: "取り込む", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
  await uploadFile(pngPath, { kind: "oct", title: "OCT 黄斑" });
  await page.getByRole("button", { name: "OCT 黄斑" }).click();
  await page.locator(".dialog-viewer img.file-preview").waitFor();
  await page.getByRole("button", { name: "閉じる" }).click();
  await uploadFile(pngPath, { kind: "oct", eye: "od", takenOn: "2026-05-01", title: "OCT 前回" });
  await uploadFile(jpegPath, { kind: "paper_chart", title: "紙カルテ 2019" });
  // 右列は種類ごとの最新 1 枚だけをサムネイルで出す
  await page.getByRole("button", { name: "紙カルテ 2019" }).waitFor();
  assert.equal(await page.locator(".thumb-grid .thumb").count(), 2);
  await page.locator(".thumb-grid img.thumb-img").first().waitFor();
  await page.getByRole("button", { name: "紙カルテ 2019" }).click();
  await page.locator(".paper-summary textarea").fill("2019年 緑内障と診断。ラタノプロスト開始。");
  await page.getByRole("button", { name: "要約を保存" }).click();
  await page.getByRole("button", { name: "要約を確認済みにする" }).click();
  await page.getByText(/医師確認済み（/u).first().waitFor();
  await page.getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("link", { name: "比較 ›" }).click();
  await page.getByRole("heading", { name: "画像の比較" }).waitFor();
  // 患者帯（アレルギー）・件数つきの種類チップ・既定は「前回 vs 最新」・片側だけ送る
  await page.getByText("アレルギー: ペニシリン系（発疹）").first().waitFor();
  await page.locator(".cmp-grid img.file-preview").nth(1).waitFor();
  assert.match(await page.locator(".cmp-chip").first().innerText(), /OCT\s*2/u);
  assert.equal(await page.locator(".cmp-chip").filter({ hasText: "紙カルテ" }).count(), 0, "paper charts are not compared");
  assert.deepEqual(await page.locator(".cmp-pane-rel").allInnerTexts(), ["前回", "最新"]);
  await page.getByRole("button", { name: "左の面を次の日付へ" }).click();
  assert.deepEqual(await page.locator(".cmp-pane-rel").allInnerTexts(), ["最新", "最新"]);
  await page.getByRole("button", { name: "左の面を前の日付へ" }).click();
  assert.deepEqual(await page.locator(".cmp-pane-rel").allInnerTexts(), ["前回", "最新"]);
  await page.getByRole("link", { name: "← 患者ページ" }).click();
  await page.locator(".trend-svg").waitFor();

  // 定型文とセットを登録して、新しいカルテで使う（定型文は複数行、作った後に表示名を直す）
  await page.goto(`${baseUrl}/settings#phrases`);
  await page.getByRole("button", { name: "＋ 定型文を追加" }).click();
  const phrasePanel = page.getByRole("complementary", { name: "定型文の編集" });
  await phrasePanel.getByLabel("差し込む欄").selectOption("plan");
  await phrasePanel.getByLabel("本文").fill("点眼継続。\n次回同様。");
  await phrasePanel.getByRole("button", { name: "保存", exact: true }).click();
  await phrasePanel.getByText("保存しました").waitFor();
  await phrasePanel.getByLabel("表示名").fill("継続");
  await phrasePanel.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".master-row").filter({ hasText: "継続" }).filter({ hasText: "次回同様。" }).waitFor();
  await page.locator(".settings-nav-item", { hasText: "セット" }).click();
  await page.waitForURL(/#sets$/u);
  await page.getByRole("button", { name: "＋ セットを追加" }).click();
  const setPanel = page.getByRole("complementary", { name: "セットの編集" });
  await setPanel.getByLabel("セット名").fill("緑内障 定期");
  await setPanel.getByRole("button", { name: "＋ 検査" }).click();
  assert.equal(await setPanel.getByLabel("検査1", { exact: true }).inputValue(), "", "adding a test row does not pick a test by itself");
  await setPanel.getByRole("button", { name: "保存", exact: true }).click();
  await setPanel.getByText("検査が選ばれていない行があります").waitFor();
  await setPanel.getByLabel("検査1", { exact: true }).selectOption({ index: 1 });
  await setPanel.getByRole("button", { name: "保存", exact: true }).click();
  await setPanel.getByText("保存しました").waitFor();
  await page.locator(".master-row").filter({ hasText: "緑内障 定期" }).filter({ hasText: "検査1" }).waitFor();

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
  assert.match(await page.getByRole("textbox", { name: "方針", exact: true }).inputValue(), /点眼継続。\n次回同様。/u);
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
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
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
  const row = page.locator(".flow-row").filter({ hasText: "試験 一郎" });
  await page.locator(".flow-group.status-booked .flow-row").filter({ hasText: "試験 一郎" }).waitFor();
  await row.getByRole("button", { name: "受付する" }).click();
  await page.locator(".flow-group.status-checked_in .flow-row").filter({ hasText: "試験 一郎" }).waitFor();

  // 予約なし・未登録の当日受付 → 患者登録（行の「…」メニューから）
  await page.getByRole("button", { name: "当日受付" }).click();
  await page.getByLabel("患者を検索").fill("飛込 花子");
  await page.getByRole("button", { name: "受け付ける" }).click();
  const walkIn = page.locator(".flow-row").filter({ hasText: "飛込 花子" });
  await walkIn.waitFor();
  assert.equal((await walkIn.locator(".flow-slot").innerText()).trim(), "#2");
  await walkIn.locator("summary").click();
  await walkIn.getByRole("button", { name: "患者登録" }).click();
  await page.getByRole("button", { name: "登録して受付に紐づける" }).click();
  await walkIn.getByText("未登録").waitFor({ state: "detached" });

  // 段階を進める（行の右端のボタンは 1 つだけ）。人数チップで絞り込める
  await row.getByRole("button", { name: "検査開始" }).click();
  await page.locator(".flow-group.status-in_exam .flow-row").filter({ hasText: "試験 一郎" }).waitFor();
  await row.getByRole("button", { name: "検査終了" }).click();
  await page.locator(".flow-group.status-waiting_doctor .flow-row").filter({ hasText: "試験 一郎" }).waitFor();
  await page.getByRole("button", { name: /^診察待ち/u }).click();
  assert.equal(await page.locator(".flow-row").count(), 1, "the count chip filters the list to one stage");
  await page.getByRole("button", { name: /^すべて/u }).click();
  assert.equal(await page.getByRole("button", { name: /^すべて/u }).getAttribute("aria-pressed"), "true");

  // 会計連携: 状態ごとの一覧。未連携だけを下のバーから一括で CSV にして連携済みにする
  await page.getByRole("link", { name: "会計連携" }).click();
  const pendingRow = page.locator(".bill-status-pending .bill-row").filter({ hasText: "見本 花子" }).first();
  await pendingRow.waitFor();
  await page.locator(".bill-status-drafts .bill-row").first().waitFor();
  assert.match(await pendingRow.locator(".bill-summary").innerText(), /処方\d/u);
  assert.equal(await page.getByRole("button", { name: /全件 CSV/u }).isVisible(), false, "the all-day CSV is tucked away in the menu");
  // 行を開くと区分ごとの品目。連絡票は 1 人 1 枚で、その人だけを印刷する
  await pendingRow.locator(".flow-row-open").click();
  const detail = page.locator(".bill-detail").first();
  await detail.locator(".bill-items").waitFor();
  await page.evaluate(() => {
    window.__printed = [];
    window.print = () => window.__printed.push(document.querySelectorAll(".bill-slip").length);
  });
  await detail.getByRole("button", { name: "この人の連絡票を印刷" }).click();
  await page.waitForFunction(() => window.__printed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__printed), [1]);
  // 全件 CSV は「…」から、確認してから
  await page.locator("summary[aria-label=\"会計連携のその他の操作\"]").click();
  await page.getByRole("button", { name: /全件 CSV/u }).click();
  await page.getByRole("dialog").getByText(/取込には使わないでください/u).waitFor();
  const [allDay] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "確認用に保存する" }).click()]);
  assert.match(allDay.suggestedFilename(), /-all\.csv$/u);
  const selbar = page.locator(".bill-selbar");
  assert.match(await selbar.innerText(), /人を選択中/u);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    selbar.getByRole("button", { name: "CSV を出力して連携済みにする" }).click()
  ]);
  assert.match(download.suggestedFilename(), /^eye-billing-\d{4}-\d{2}-\d{2}-/u);
  await page.getByText(/人を連携済みにしました。/u).waitFor();
  await selbar.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /^▶ 連携済み/u }).click();
  await page.locator(".bill-status-handed_off .bill-row").filter({ hasText: "見本 花子" }).first().waitFor();
  // その回の CSV を取り直せる（連携したときと同じ中身）
  await page.getByRole("button", { name: /連携の記録/u }).click();
  const [again] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "この回の CSV" }).first().click()]);
  assert.equal(readFileSync(await again.path(), "utf8"), readFileSync(await download.path(), "utf8"));
  // 日付を変えると通知は消え、今日でないことを示す
  await page.getByRole("button", { name: "前日" }).click();
  await page.getByText(/今日ではありません/u).waitFor();
  assert.equal(await page.getByText(/人を連携済みにしました。/u).count(), 0);
  await page.getByRole("button", { name: "今日", exact: true }).click();

  // 要再連携: 前回の品目と違う行は差分チップを出し、差分を見てから 1 人ずつ再連携する（前回の品目は応答を差し替えて作る）
  const dayRoute = /\/v1\/eye\/billing\/day\?/u;
  await page.route(dayRoute, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const target = body.encounters.find((item) => item.handoff.state === "handed_off" && item.items.length > 0);
    if (target) {
      target.handoff = {
        ...target.handoff,
        state: "changed",
        previousItems: [...target.items.slice(1), { category: "処方", code: "", name: "旧点眼薬", eye: "ou", quantity: 1, unit: "本", days: null, route: "院外", usage: "", note: "" }],
        previousDiagnoses: []
      };
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const changedRow = page.locator(".bill-status-changed .bill-row").first();
  await changedRow.locator(".bill-chip.is-removed").filter({ hasText: "旧点眼薬" }).waitFor();
  assert.equal(await page.locator(".bill-status-changed input[type=checkbox]").count(), 0, "rows that need another handoff are never bulk-selected");
  await changedRow.getByRole("button", { name: "差分を見る" }).click();
  await page.locator(".bill-diff-row.is-removed").filter({ hasText: "旧点眼薬" }).waitFor();
  await page.locator(".bill-diff-row.is-added").first().waitFor();
  await page.getByText(/前回分（v\d+）を取り消すか直してから/u).waitFor();
  const [redo] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "この人だけ CSV を出力して再連携" }).click()]);
  assert.match(redo.suggestedFilename(), /^eye-billing-/u);
  await page.getByText(/再連携しました。/u).waitFor();
  await page.unrouteAll({ behavior: "wait" });

  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function runOrthoptistFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const page = await context.newPage();
  await login(page, "orthoptist");
  await page.getByLabel("患者検索").fill("試験");
  await page.locator(".patient-row").filter({ hasText: "試験 一郎" }).click();
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
  // 管理者でない人は設定を見るだけ（追加・保存はできず、管理の項目は出ない）
  await page.goto(`${baseUrl}/settings#audit`);
  await page.getByRole("heading", { name: /よく使う薬剤/u }).waitFor();
  assert.equal(await page.getByRole("button", { name: "＋ 薬剤を追加" }).count(), 0);
  assert.equal(await page.locator(".settings-nav-item", { hasText: "操作記録" }).count(), 0);
  await page.locator(".master-row").first().click();
  await page.getByRole("complementary", { name: "薬剤の編集" }).getByText("変更は管理者が行います。").waitFor();
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0);
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
