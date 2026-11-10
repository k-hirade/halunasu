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
    await runReceptionResponsiveChecks(browser);
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
  // 開発サーバーの左下の表示（Next の開発用バッジ）が、左のペインの下端のボタンに重ならないように隠す。実行時エラーは pageerror で拾う
  await context.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(style);
    });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page, "director");
  await page.getByRole("heading", { name: "診察", exact: true }).waitFor();
  // ヘッダー（デジカルの形）: 左に画面名・医療機関名、右のアイコンの患者リストが現在地
  assert.equal((await page.locator(".eh-screen").innerText()).trim(), "診察");
  assert.equal(await page.locator(".eh-tool-list").getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("textbox", { name: "患者検索" }).count(), 0, "no inline search field in the header");
  await assertNavFits(page);

  // 患者検索: 「/」でモーダルが開き、入力欄にカーソルがある。ひらがな・名だけ・生年月日（和暦）で当たり、結果に生年月日が出る
  await page.locator("body").press("/");
  const searchDialog = page.getByRole("dialog", { name: "患者検索" });
  await searchDialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "検索する語", "the search input has focus on open");
  for (const query of ["みほん", "ハナコ", "S31.3.12", "1956/3/12"]) {
    await searchDialog.getByLabel("検索する語").fill(query);
    await searchDialog.locator(".ps-row").filter({ hasText: "見本 花子" }).filter({ hasText: "S31" }).waitFor();
  }
  // 日本語入力の変換確定の Enter では患者を開かない
  await searchDialog.getByLabel("検索する語").dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true });
  await page.waitForTimeout(300);
  assert.equal(new URL(page.url()).pathname, "/", "an IME Enter must not open a patient");
  // Esc で閉じる
  await page.keyboard.press("Escape");
  await searchDialog.waitFor({ state: "detached" });

  // ヘルプ: カルテ以外の画面では共通のキー一覧
  await page.getByRole("button", { name: "ショートカット・ヘルプ" }).click();
  await page.getByRole("dialog", { name: "ショートカット" }).getByText("患者検索を開く").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "ショートカット" }).waitFor({ state: "detached" });

  // 暗室表示・施設管理は利用者メニューの中。切り替えは端末に保存される
  await page.locator(".eh-user-button").click();
  await page.locator(".eh-user-list").getByRole("link", { name: "施設管理" }).waitFor();
  await page.getByRole("button", { name: /暗室表示/u }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await page.evaluate(() => window.localStorage.getItem("halunasu-eye-dark")), "1");
  await page.getByRole("button", { name: /暗室表示/u }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.locator(".eh-user-button").click();

  // キーボードだけで開く: 「/」→ 入力 → ↓↑ → Enter
  await page.locator("body").press("/");
  await page.keyboard.type("見本");
  await searchDialog.locator(".ps-row.is-active").filter({ hasText: "見本 花子" }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await searchDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "初診カルテを作成" }).click();
  await page.getByRole("textbox", { name: "主訴・所見", exact: true }).waitFor();
  assert.equal((await page.locator(".eh-screen").innerText()).trim(), "カルテ");
  // カルテの画面では、ヘッダーのヘルプがカルテのショートカット一覧を出す
  await page.getByRole("button", { name: "ショートカット・ヘルプ" }).click();
  await page.getByRole("dialog", { name: "ショートカット" }).getByRole("heading", { name: "左のタブ" }).waitFor();
  await page.getByRole("dialog", { name: "ショートカット" }).getByRole("button", { name: "閉じる" }).click();
  // デジカルの 3 ペイン: 左「患者の情報」・中央「本日のカルテ」・右「オーダー」と右下の操作
  for (const name of ["患者の情報", "オーダー"]) assert.equal(await page.getByRole("complementary", { name }).isVisible(), true, `${name} pane is visible at 1366px`);
  await page.getByRole("toolbar", { name: "カルテの操作" }).getByRole("button", { name: /次へ/u }).waitFor();
  assert.equal(await page.getByRole("tab", { name: /^診療履歴/u }).getAttribute("aria-selected"), "true", "the history tab is the default left tab");
  const firstEncounterId = page.url().split("/").at(-1);
  // 診療日・区分は見出しの［✎］
  await page.getByRole("button", { name: /^診療日・区分を変える/u }).click();
  await page.getByRole("dialog").getByLabel("診療日", { exact: true }).fill("2026-07-28");
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
  await page.locator(".chart-date").filter({ hasText: "2026/07/28" }).waitFor();
  await page.getByRole("button", { name: "＋ 主訴" }).click();
  await page.getByRole("textbox", { name: "主訴", exact: true }).fill("緑内障の定期検査");
  // 検査値は検査ページで入る（ここでは記録を API で入れる）。カルテには読み取りの帯で出る
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await addExamRecord(page, firstEncounterId, {
    vision: { far: { od: { corrected: "1.0" }, os: { corrected: "0.9" } } },
    iop: { od: { readings: [18], method: "nct" }, os: { readings: [16], method: "nct" } },
    pupil: { od: { sizeMm: 3, reaction: "brisk" } },
    keratometry: { od: { k1: 43.25, k2: 44, axis: 175 } },
    binocular: { rapd: "none", alignment: "exo", alignmentNote: "10Δ" }
  });
  await page.reload();
  await page.locator(".exam-band").getByText(/RV=/u).first().waitFor();
  assert.match(await page.locator(".exam-band").innerText(), /1\.0[\s\S]*18[\s\S]*16/u);
  await page.getByRole("link", { name: "検査入力を開く" }).waitFor();
  await page.getByRole("button", { name: "アレルギー・病名" }).click();
  await page.getByRole("button", { name: "アレルギーを追加" }).click();
  await page.getByLabel("原因").fill("ペニシリン系");
  await page.getByLabel("症状").fill("発疹");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await page.getByText("アレルギー: ペニシリン系（発疹）").first().waitFor();
  // 病名タブ（Shift+-）→ B で新規登録。マスター検索の行の［主病］で登録し、ダイアログは開いたまま
  await page.locator(".chart-head").click();
  await page.keyboard.press("Shift+Minus");
  assert.equal(await page.getByRole("tab", { name: "病名" }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("b");
  const dxDialog = page.getByRole("dialog", { name: "傷病名新規登録" });
  await dxDialog.getByLabel("傷病名を検索").fill("開放隅角緑内障");
  await dxDialog.locator(".dx-add-row").filter({ hasText: /^原発開放隅角緑内障/u }).first().getByRole("button", { name: "主病" }).click();
  await dxDialog.getByText(/登録しました: 原発開放隅角緑内障（主病）/u).waitFor();
  await dxDialog.getByRole("button", { name: "閉じる" }).click();
  await page.locator(".dx-table").getByText("原発開放隅角緑内障").waitFor();
  assert.match(await page.locator(".dx-table .dx-code").first().innerText(), /^\d+$/u, "a master code is kept");
  // 編集: 修飾語（右）と補足
  await page.getByRole("button", { name: "原発開放隅角緑内障を編集" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "右", exact: true }).click();
  await page.getByRole("dialog").getByLabel("傷病名補足").fill("視野進行なし");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await page.locator(".dx-table").getByText("右原発開放隅角緑内障").waitFor();
  await page.locator(".chart-head-dx").getByText(/原発開放隅角緑内障/u).waitFor();
  // 次回（週）と次回予定（トプコン: 項目 × 部位、全て右）
  await page.getByLabel("次回まで（週）").fill("12");
  await page.getByRole("group", { name: "予定のプリセット" }).getByRole("button", { name: "視・圧", exact: true }).click();
  await page.getByRole("group", { name: "部位を一括で変える" }).getByRole("button", { name: "全て右" }).click();
  assert.equal(await page.getByRole("group", { name: "視力検査の部位" }).getByRole("button", { name: "右" }).getAttribute("aria-pressed"), "true");
  // 処方: 数字キー 3 で投薬 → 公開マスターを検索して押すと、新しい Rp として入る
  await page.locator(".chart-head").click();
  await page.keyboard.press("3");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "オーダーを検索");
  await page.keyboard.type("ラタノプロスト");
  await page.locator(".order-item").filter({ hasText: /ラタノプロスト点眼液/u }).first().click();
  const firstRp = page.locator(".rp-group.is-rx").first();
  await firstRp.getByText(/ラタノプロスト/u).first().waitFor();
  await firstRp.locator('summary[aria-label="用法"]').click();
  await firstRp.getByRole("group", { name: "1日の回数" }).getByRole("button", { name: "1回" }).click();
  await firstRp.locator('summary[aria-label="用法"]').click();
  await firstRp.getByRole("button", { name: /目安\d+本 反映/u }).click();
  assert.equal(await firstRp.getByLabel("数量").inputValue(), "2");
  // 束を押して選択中にすると、次に選んだ薬は同じ Rp に入る（用法・眼もそろう）
  await firstRp.locator(".rp-name").first().click();
  await page.locator(".rp-group.is-rx.is-selected").waitFor();
  await page.getByLabel("オーダーを検索").fill("チモロール");
  await page.locator(".order-item").filter({ hasText: /チモロール/u }).first().click();
  assert.equal(await page.locator(".rp-group.is-rx").count(), 1, "the drug joined the selected Rp");
  assert.equal(await firstRp.locator(".rp-row:not(.is-comment)").count(), 2);
  // 区分バッジのメニューからコメント行
  await firstRp.locator('summary[aria-label="点眼の操作"]').first().click();
  await page.getByRole("button", { name: "コメントを追加（処方箋に載せる）" }).click();
  await firstRp.getByLabel("コメント", { exact: true }).fill("後発品変更不可");
  // 検査: 7 で検査 → 院内の検査の一覧から入れる（予定）→ 実施
  await page.locator(".chart-head").click();
  await page.keyboard.press("7");
  // 検索語は区分を変えても残る（デジカルと同じ。全てに切り替えて同じ語で探せる）ので消してから一覧を見る
  assert.equal(await page.getByLabel("オーダーを検索").inputValue(), "チモロール");
  await page.getByLabel("オーダーを検索").fill("");
  await page.locator(".order-item").filter({ hasText: "視力検査" }).first().click();
  const orderRp = page.locator(".rp-group.is-order").first();
  await orderRp.getByText("視力検査").waitFor();
  await orderRp.getByRole("button", { name: "実施" }).click();
  await orderRp.locator(".order-status-performed").waitFor();
  // 主訴・所見（1 つの自由記載）。入力中は 1 文字のショートカットが効かない
  const findingsText = page.getByRole("textbox", { name: "主訴・所見", exact: true });
  await findingsText.fill("右眼の霧視。前房清明。");
  await findingsText.press("1");
  assert.equal(await page.getByRole("tab", { name: "セット" }).getAttribute("aria-selected"), "false", "digit keys do nothing while typing");
  await findingsText.press("Backspace");
  // 眼別の所見（従来の欄。空なら＋チップ）。「空欄を異常なし」は追加の欄を埋めない
  await page.getByRole("button", { name: "＋ 眼別の所見" }).click();
  await page.getByRole("button", { name: "＋ C/D 比" }).click();
  await page.getByLabel("右眼 C/D 比").fill("0.7");
  await page.getByRole("button", { name: "＋ その他" }).click();
  await page.getByLabel("右眼 その他", { exact: true }).fill("眼瞼腫脹なし");
  await page.getByRole("textbox", { name: "両眼・全体" }).fill("全身状態良好");
  await page.getByRole("button", { name: "空欄を異常なし", exact: true }).click();
  assert.equal(await page.getByLabel("左眼 前眼部").inputValue(), "異常なし");
  assert.equal(await page.getByLabel("左眼 その他", { exact: true }).inputValue(), "", "normal-fill must not touch the added findings");
  // 方針・説明・同意（＋チップ）と点眼アドヒアランス（処方の下）
  await page.getByRole("button", { name: "＋ 評価・方針" }).click();
  await page.getByRole("textbox", { name: "方針", exact: true }).fill("点眼継続");
  await page.getByRole("button", { name: "＋ 説明・同意" }).click();
  await page.getByRole("button", { name: "散瞳後の注意" }).click();
  await page.getByLabel("同意", { exact: true }).selectOption("not_required");
  await page.getByRole("group", { name: "点眼アドヒアランス" }).getByRole("button", { name: "時々忘れる" }).click();
  // シェーマ: ［シェーマ追加］→ 下絵の格子 → 描画ダイアログ → 保存すると縮小図
  await page.getByRole("button", { name: "シェーマ追加" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "右眼眼底" }).click();
  await drawStroke(page);
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await page.locator(".sketch-strip .sketch-thumb polyline").first().waitFor();
  // 既往・全身疾患・内服は主訴・所見の上に 1 行で出し、同じ編集ダイアログで直す
  await page.locator(".history-line-bar").getByText(/未記入/u).waitFor();
  await page.getByRole("button", { name: "既往・内服を編集" }).click();
  await page.getByRole("dialog").getByLabel("全身既往・内服").fill("糖尿病\nワーファリン内服");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await page.locator(".history-line-bar").getByText("糖尿病、ワーファリン内服").waitFor();
  // ショートカット一覧（?）
  await page.locator(".chart-head").click();
  await page.keyboard.press("Shift+Slash");
  await page.getByRole("dialog", { name: "ショートカット" }).getByText("次へ（確定 → 受付の状態 → 次の患者）").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
  await assertEditorPopoversFit(page);
  await assertEditorResponsiveB(page);
  // S で保存
  await page.keyboard.press("s");
  await page.getByText("保存しました。").waitFor({ timeout: 15_000 });
  // Q（次へ）: 警告一覧（止めない）→ 受付の状態（受付が無ければ確定だけ）
  await page.keyboard.press("q");
  const warnings = page.getByRole("dialog", { name: /警告一覧/u });
  await warnings.getByText("右眼の検査値が未確認です。").waitFor();
  await warnings.getByRole("button", { name: "確認して次へ" }).click();
  const statusDialog = page.getByRole("dialog", { name: "患者ステータス選択" });
  await statusDialog.getByText("受付なし").waitFor();
  await statusDialog.getByRole("button", { name: "決定" }).click();
  await page.getByText("確定 v1").first().waitFor();
  await page.locator(".exam-confirmed").first().waitFor();
  // 確定済みの直接編集: そのまま書くと修正になり、次へで新しい版（v2）になる。版履歴から前の版を開ける
  await page.getByText(/このまま直すと修正になり/u).waitFor();
  await findingsText.fill("右眼の霧視。前房清明。");
  await page.getByRole("textbox", { name: "方針", exact: true }).fill("点眼継続。");
  await page.getByText(/確定済み v1 を修正中です/u).waitFor({ timeout: 15_000 });
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.getByRole("dialog", { name: /警告一覧|カルテを確定します/u }).getByRole("button", { name: /次へ/u }).click();
  await page.getByRole("dialog", { name: "患者ステータス選択" }).getByRole("button", { name: "決定" }).click();
  await page.getByText("確定 v2").first().waitFor();
  await page.getByRole("button", { name: /^版履歴/u }).first().click();
  assert.equal(await page.getByRole("dialog", { name: "版履歴" }).getByRole("link", { name: /^v\d$/u }).count(), 2, "both versions are kept");
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
  // 印刷: 追加の項目は入力があるときだけ行を出す
  const firstPrint = await context.newPage();
  await firstPrint.goto(`${page.url()}/print`);
  const firstSheet = await firstPrint.locator(".chart-sheet").innerText();
  for (const text of ["3mm 対光反射 迅速", "K1 43.25D K2 44.00D Ax175°", "RAPD", "外斜位 10Δ", "C/D 比", "0.7", "眼瞼腫脹なし", "全身状態良好", "散瞳後の注意 同意不要", "時々忘れる", "右眼の霧視。前房清明。", "後発品変更不可"]) {
    assert.ok(firstSheet.includes(text), `the chart print shows ${text}`);
  }
  assert.equal(firstSheet.includes("眼球運動"), false, "empty added rows are not printed");
  await firstPrint.close();

  await page.getByRole("link", { name: /カルテ一覧/ }).click();
  await page.getByRole("button", { name: /本日のカルテを作成/ }).click();
  await page.locator(".history-card").first().waitFor();
  const revisitId = page.url().split("/").at(-1);
  // 再診: 測定値は写らない。所見の自由記載・眼別の所見は写り、C/D 比は写さず前回値をヒントに出す。説明・同意も写さない
  await page.locator(".exam-band").getByText("検査値はまだありません。").waitFor();
  assert.equal(await page.getByRole("textbox", { name: "主訴・所見", exact: true }).inputValue(), "右眼の霧視。前房清明。");
  assert.equal(await page.getByLabel("右眼 その他", { exact: true }).inputValue(), "眼瞼腫脹なし");
  assert.equal(await page.getByLabel("右眼 C/D 比").inputValue(), "", "C/D is re-measured");
  assert.equal(await page.locator(".findings-hint").filter({ hasText: "前回 0.7" }).count(), 1);
  await page.getByRole("button", { name: "＋ 説明・同意" }).waitFor();
  // 引き継いだ処方は Rp ごと「引継」（未確認）。次回予定はオーダーの「前回予定」として入る
  assert.equal(await page.locator(".rp-group.is-rx.is-carried").count(), 1);
  await page.locator(".rp-group.is-order").getByText("前回予定").first().waitFor();
  // 学習リスト（確定したカルテから）: 投薬タブの空の検索に、よく使う処方の束が出る
  await page.getByRole("tab", { name: "投薬" }).click();
  await page.locator(".order-bundle").filter({ hasText: /ラタノプロスト/u }).first().waitFor();
  // 診療履歴: すべて開いたカード。束を押すと複写（同じ処方は重ねない）、下絵だけの複写、ドラッグ＆ドロップ
  const card = page.locator(".history-card").first();
  await card.locator(".history-group").filter({ hasText: /ラタノプロスト/u }).click();
  await page.getByText(/同じ処方はすでにあるため重ねていません。/u).waitFor();
  const sketchCount = await page.locator(".sketch-strip .sketch-thumb").count();
  await card.getByRole("button", { name: "図だけ" }).first().click();
  assert.equal(await page.locator(".sketch-strip .sketch-thumb").count(), sketchCount + 1, "copying the template adds a blank sketch");
  const orderCount = await page.locator(".rp-group.is-order .rp-row").count();
  await card.locator(".history-group.is-order").first().dragTo(page.locator(".chart-col-acts .chart-col-head"));
  await page.getByText(/検査・処置を複写しました|同じ検査・処置はすでにあるため/u).first().waitFor();
  assert.ok(await page.locator(".rp-group.is-order .rp-row").count() >= orderCount, "dropping an order group copies it");
  // 検査値（API で入れた記録）を帯から確認する
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await addExamRecord(page, revisitId, { vision: { far: { od: { corrected: "0.8" } } }, iop: { od: { readings: [23, 24, 22], method: "nct" } }, refraction: { od: { sphere: -1.25 } } });
  await page.reload();
  await page.locator(".exam-iop.is-high").getByText(/23 \/ 24 \/ 22（平均 23）/u).waitFor();
  await page.getByRole("button", { name: "右眼を確認" }).click();
  await page.locator(".exam-confirmed").first().waitFor();
  assert.equal(await page.getByRole("button", { name: "左眼を確認" }).count(), 0, "an eye without values needs no confirmation");
  // 前回との差分（診療履歴のツール行）
  await page.getByRole("button", { name: /^前回との差分/u }).click();
  const changes = await page.locator(".changes").innerText();
  assert.match(changes, /右眼 矯正視力[\s\S]*1\.0[\s\S]*0\.8/u);
  assert.match(changes, /右眼 眼圧[\s\S]*18[\s\S]*23/u);
  // 左「検査」タブ: 視力・眼圧の表。値を押すと主訴・所見に日付付きで書き込む
  await page.locator(".chart-head").click();
  await page.keyboard.press("Shift+Digit6");
  await page.locator(".exam-history-table").first().waitFor();
  await page.getByRole("table", { name: "眼圧" }).getByRole("button", { name: "18" }).click();
  assert.match(await page.getByRole("textbox", { name: "主訴・所見", exact: true }).inputValue(), /07\/28\(火\) 右眼 眼圧 18/u);
  // 薬歴: 薬剤 × 年月の ✓ を押すと診療履歴のそのカルテへ
  await page.keyboard.press("Shift+Digit8");
  await page.locator(".drug-matrix").getByRole("button", { name: /ラタノプロスト/u }).first().click();
  await page.locator(".history-card.is-highlighted").waitFor();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.getByRole("dialog", { name: /警告一覧/u }).getByText("前回から引き継ぎ").first().waitFor();
  await page.getByRole("dialog", { name: /警告一覧/u }).getByRole("button", { name: /次へ/u }).click();
  await page.getByRole("dialog", { name: "患者ステータス選択" }).getByRole("button", { name: "決定" }).click();
  await page.getByText("確定 v1").first().waitFor();
  assert.equal(await page.locator(".rp-group.is-carried").count(), 0, "finalizing confirms carried-over prescriptions");
  const encounterUrl = page.url();

  await page.getByRole("link", { name: /カルテ一覧/ }).click();
  // 患者ページ: カルテ概要（2 列 × 4 段）→ 経過（グラフ + 1 受診 1 行の表）
  await page.locator(".trend-svg").waitFor();
  await page.getByText("アレルギー: ペニシリン系（発疹）").first().waitFor();
  assert.equal(await page.locator(".visit-rows .visit-row").count(), 2);
  assert.match(await page.locator(".ps-iop").innerText(), /<R>\s*23/u, "the summary shows the latest finalized IOP");
  assert.match(await page.locator(".ps-va").innerText(), /RV=[\s\S]*0\.8/u);
  assert.match(await page.locator(".visit-rows .visit-row").first().innerText(), /0\.8[\s\S]*23/u);
  assert.equal(await page.locator(".trend-svg .mark-started").count() > 0, true, "drop start is marked on the time axis");
  // 視力眼圧タブ: 表 2 つ（視力・眼圧）＋ グラフ 2 つ。系列はチェックで切り替える
  await page.getByRole("tab", { name: "視力眼圧" }).click();
  await page.locator(".vi-chart.is-iop .series-od .dot").first().waitFor();
  assert.match(await page.locator(".vi-table-wrap.is-iop tbody tr").first().innerText(), /23/u);
  assert.match(await page.locator(".vi-table-wrap").first().locator("tbody tr").first().innerText(), /0\.8/u);
  await page.getByRole("checkbox", { name: "眼圧(右)" }).uncheck();
  assert.equal(await page.locator(".vi-chart.is-iop .series-od .dot").count(), 0, "unchecking a series hides it");
  await page.getByRole("tab", { name: "カルテ概要" }).click();
  await page.locator('summary[aria-label="その他の操作"]').click();
  await page.getByRole("button", { name: /この患者のデータを出力/u }).waitFor();
  await page.locator('summary[aria-label="その他の操作"]').click();
  await page.locator(".visit-rows .visit-row").last().click();
  await page.waitForURL(/\/encounters\//u);
  await page.goBack();
  await page.locator(".trend-svg").waitFor();

  const printPage = await context.newPage();
  await printPage.goto(`${encounterUrl}/print`);
  await printPage.getByRole("button", { name: "印刷", exact: true }).waitFor();
  assert.equal(await printPage.locator(".print-sketches polyline").count() > 0, true, "copied sketch strokes are printed");
  assert.equal(await printPage.locator(".print-watermark").count(), 0, "a finalized chart prints without the draft watermark");
  assert.match(await printPage.locator(".cs-table").innerText(), /0\.8/u);
  await printPage.getByRole("link", { name: "← カルテに戻る" }).waitFor();
  await printPage.close();

  // 設定（デジカルの施設管理と同じ形）: 最初は医療機関情報。［編集］のダイアログで入れた値が紙に載る
  await page.goto(`${baseUrl}/settings`);
  await page.getByRole("heading", { name: "医療機関情報" }).waitFor();
  assert.deepEqual(await page.locator(".settings-nav-item").allInnerTexts().then((items) => items.map((text) => text.replace(/\d+$/u, "").trim())), ["医療機関情報", "利用者", "セット", "定型文", "よく使う薬剤", "データ出力", "操作記録"]);
  await page.getByRole("button", { name: "✎ 編集" }).click();
  const facilityDialog = page.getByRole("dialog", { name: "医療機関情報の編集" });
  await facilityDialog.getByLabel("医療機関名").fill("スモーク眼科クリニック");
  await facilityDialog.getByLabel("郵便番号").fill("1000001");
  await facilityDialog.getByLabel("住所").fill("東京都千代田区千代田1-1");
  await facilityDialog.getByLabel("電話番号").fill("03-1234-5678");
  await facilityDialog.getByLabel("FAX番号").fill("03-1234-5679");
  await facilityDialog.getByLabel("管理者").fill("院長 一郎");
  await facilityDialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("医療機関情報を保存しました。", { exact: false }).waitFor();
  await facilityDialog.waitFor({ state: "detached" });
  await page.locator(".kv-row").filter({ hasText: "郵便番号" }).getByText("100-0001").waitFor();
  await page.locator(".kv-row").filter({ hasText: "FAX番号" }).getByText("03-1234-5679").waitFor();
  // ヘッダー左は「施設管理 ＋ 医療機関名」（保存するとすぐ変わる）
  assert.equal((await page.locator(".eh-screen").innerText()).trim(), "施設管理");
  await page.locator(".eh-clinic").filter({ hasText: "スモーク眼科クリニック" }).waitFor();
  const facilityPrint = await context.newPage();
  await facilityPrint.goto(`${encounterUrl}/print`);
  await facilityPrint.locator(".cs-facility").filter({ hasText: "スモーク眼科クリニック" }).waitFor();
  await facilityPrint.close();

  // 薬剤を追加（薬剤名は公開マスターから探せる）→ 1本で何日分の表示 → 既存の薬剤を編集 → 停止・再開
  await page.locator(".settings-nav-item", { hasText: "よく使う薬剤" }).click();
  await page.waitForURL(/#drugs$/u);
  await page.getByRole("button", { name: "＋ 薬剤を追加" }).click();
  const drugPanel = page.getByRole("dialog", { name: "薬剤の編集" });
  await drugPanel.getByLabel("薬剤名").fill("ヒアレイン");
  await drugPanel.locator(".master-search-option").first().waitFor();
  assert.match(await drugPanel.locator(".master-search-option").first().innerText(), /ヒアレイン/u, "the public drug master is searched");
  await drugPanel.getByLabel("薬剤名").fill("ヒアレイン点眼液0.1%");
  await drugPanel.getByLabel("薬剤名").press("Escape");
  assert.equal(await drugPanel.count(), 1, "Escape in the drug search closes only the suggestions");
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
  // 保存していない変更があると、閉じる前に確認する
  await drugPanel.getByLabel("既定の用法").fill("1日4回");
  await drugPanel.getByRole("button", { name: "閉じる", exact: true }).click();
  await drugPanel.getByText("保存していない変更があります。", { exact: false }).waitFor();
  await drugPanel.getByRole("button", { name: "変更を破棄" }).click();
  await drugPanel.waitFor({ state: "detached" });
  await page.locator(".settings-nav-item", { hasText: "操作記録" }).click();
  await page.waitForURL(/#audit$/u);
  await page.getByRole("cell", { name: "カルテを確定" }).first().waitFor();
  await page.getByRole("cell", { name: "ヒアレイン点眼液0.1%" }).first().waitFor();

  // 印刷用の氏名: 未設定なら表示名から役割の（ ）を除いた名前、設定すると処方箋・カルテの印刷に出る
  const finalizedOptical = await context.newPage();
  await finalizedOptical.goto(`${encounterUrl}/optical`);
  await finalizedOptical.locator(".rx-sign-name").waitFor();
  assert.equal((await finalizedOptical.locator(".rx-sign-name").innerText()).replace("印", "").trim(), "院長", "the role in parentheses is not printed");
  assert.match(await finalizedOptical.locator(".rx-no").innerText(), /No\. \d{8}-[0-9A-F]{6}-1/u, "the prescription number comes from the encounter and version");
  // 利用者（施設管理の利用者管理と同じ列）。［編集］で印刷用の氏名を決める
  await page.locator(".settings-nav-item", { hasText: "利用者" }).click();
  await page.waitForURL(/#users$/u);
  await page.locator(".master-head.user-cols").getByText("ログイン ID").waitFor();
  await page.locator(".master-row").filter({ hasText: "院長" }).first().click();
  const staffPanel = page.getByRole("dialog", { name: "利用者の編集" });
  await staffPanel.getByLabel("印刷用の氏名").fill("山田 一郎");
  await staffPanel.getByText("紙には「山田 一郎」と出ます。", { exact: false }).waitFor();
  await staffPanel.getByRole("button", { name: "保存", exact: true }).click();
  await staffPanel.getByText("保存しました").waitFor();
  await page.locator(".master-row").filter({ hasText: "山田 一郎" }).waitFor();
  assert.equal(await staffPanel.getByRole("button", { name: "停止する" }).count(), 0, "staff rows cannot be stopped");
  await staffPanel.getByRole("button", { name: "閉じる", exact: true }).click();
  await finalizedOptical.reload();
  await finalizedOptical.locator(".rx-sign-name").filter({ hasText: "山田 一郎" }).waitFor();
  await finalizedOptical.goto(`${encounterUrl}/print`);
  await finalizedOptical.locator(".cs-visit").filter({ hasText: "記載医 山田 一郎" }).waitFor();
  await finalizedOptical.close();
  await page.locator(".settings-nav-item", { hasText: "操作記録" }).click();
  await page.waitForURL(/#audit$/u);
  await page.getByRole("cell", { name: "印刷用の氏名を保存" }).first().waitFor();
  await page.getByRole("cell", { name: "医療機関情報を保存" }).first().waitFor();
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
  await openPatientFromSearch(page, "見本", "見本 花子");
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
  // 表示モード: OU（同じ日の右眼・左眼）と時系列（同じ眼を古い順に横へ）
  await page.getByRole("button", { name: "OU", exact: true }).click();
  await page.locator(".cmp-ou-date").waitFor();
  assert.deepEqual(await page.locator(".cmp-grid .cmp-pane-rel").allInnerTexts(), ["右眼", "左眼"]);
  await page.getByRole("button", { name: "時系列", exact: true }).click();
  assert.equal(await page.locator(".cmp-series-item").count(), 2);
  await page.getByRole("button", { name: "比較", exact: true }).click();
  await page.locator(".cmp-strip").waitFor();
  await page.getByRole("link", { name: "← 患者ページ" }).click();
  await page.locator(".trend-svg").waitFor();

  // 定型文とセットを登録して、新しいカルテで使う（定型文は複数行、作った後に表示名を直す）
  await page.goto(`${baseUrl}/settings#phrases`);
  await page.getByRole("button", { name: "＋ 定型文を追加" }).click();
  const phrasePanel = page.getByRole("dialog", { name: "定型文の編集" });
  // 差し込む欄は SOAP の区分ごと。追加の自由記載欄も選べる
  assert.equal(await phrasePanel.locator('optgroup[label^="O"] option[value="findings.other"]').count(), 1);
  assert.equal(await phrasePanel.locator('option[value="counselling.note"]').count(), 1);
  await phrasePanel.getByLabel("差し込む欄").selectOption("plan");
  await phrasePanel.getByLabel("本文").fill("点眼継続。\n次回同様。");
  await phrasePanel.getByRole("button", { name: "保存", exact: true }).click();
  await phrasePanel.getByText("保存しました").waitFor();
  await phrasePanel.getByLabel("表示名").fill("継続");
  await phrasePanel.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".master-row").filter({ hasText: "継続" }).filter({ hasText: "次回同様。" }).waitFor();
  await phrasePanel.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.locator(".settings-nav-item", { hasText: "セット" }).click();
  await page.waitForURL(/#sets$/u);
  await page.getByRole("button", { name: "＋ セットを追加" }).click();
  const setPanel = page.getByRole("dialog", { name: "セットの編集" });
  await setPanel.getByLabel("セット名").fill("緑内障 定期");
  await setPanel.getByRole("button", { name: "＋ 検査" }).click();
  assert.equal(await setPanel.getByLabel("検査1", { exact: true }).inputValue(), "", "adding a test row does not pick a test by itself");
  await setPanel.getByRole("button", { name: "保存", exact: true }).click();
  await setPanel.getByText("検査が選ばれていない行があります").waitFor();
  await setPanel.getByLabel("検査1", { exact: true }).selectOption({ index: 1 });
  await setPanel.getByRole("button", { name: "保存", exact: true }).click();
  await setPanel.getByText("保存しました").waitFor();
  await page.locator(".master-row").filter({ hasText: "緑内障 定期" }).filter({ hasText: "検査1" }).waitFor();
  await setPanel.getByRole("button", { name: "閉じる", exact: true }).click();
  // フォルダは入れ子にできる（デジカルのセットのフォルダ）。選んでいるフォルダが親の既定になる
  const folderDialog = page.getByRole("dialog", { name: "フォルダを追加" });
  await page.getByRole("button", { name: "＋ フォルダ" }).click();
  await folderDialog.getByLabel("フォルダ名").fill("緑内障");
  await folderDialog.getByRole("button", { name: "保存", exact: true }).click();
  await folderDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "＋ フォルダ" }).click();
  assert.equal(await folderDialog.getByLabel("親フォルダ").locator("option:checked").innerText(), "緑内障");
  await folderDialog.getByLabel("フォルダ名").fill("点眼");
  await folderDialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".set-list-head h3").filter({ hasText: "緑内障 / 点眼" }).waitFor();
  // セットをフォルダへ移し、病名（公開マスターから）と主訴・所見を足す
  await page.locator(".set-tree-item", { hasText: "すべて" }).click();
  await page.locator(".master-row").filter({ hasText: "緑内障 定期" }).locator(".master-row-open").click();
  await setPanel.getByLabel("フォルダ").selectOption({ index: 2 });
  await setPanel.getByRole("button", { name: "＋ 傷病名" }).click();
  await setPanel.getByLabel("傷病名1", { exact: true }).fill("開放隅角緑内障");
  await setPanel.locator(".master-search-option").first().click();
  assert.match(await setPanel.getByLabel("傷病名1", { exact: true }).inputValue(), /緑内障/u);
  await setPanel.getByLabel("主訴・所見").fill("視野 安定");
  await setPanel.getByRole("button", { name: "保存", exact: true }).click();
  await setPanel.getByText("保存しました").waitFor();
  await setPanel.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.locator(".master-row").filter({ hasText: "緑内障 定期" }).filter({ hasText: "緑内障 / 点眼" }).waitFor();
  // フォルダの中で作ったセットは先頭に入り、▲▼ で並べ替えられる
  await page.locator(".set-tree-item", { hasText: "点眼" }).click();
  await page.getByRole("button", { name: "＋ セットを追加" }).click();
  await setPanel.getByLabel("セット名").fill("緑内障 追加");
  await setPanel.getByRole("button", { name: "保存", exact: true }).click();
  await setPanel.getByText("保存しました").waitFor();
  await setPanel.getByRole("button", { name: "閉じる", exact: true }).click();
  const setNames = () => page.locator(".set-list .master-row .master-name strong").allInnerTexts();
  await page.waitForFunction(() => document.querySelectorAll(".set-list .master-row").length === 2);
  assert.deepEqual(await setNames(), ["緑内障 追加", "緑内障 定期"]);
  await page.getByRole("button", { name: "緑内障 追加 を下へ" }).click();
  await page.waitForFunction(() => document.querySelector(".set-list .master-row .master-name strong")?.textContent === "緑内障 定期");
  await page.reload();
  await page.locator(".set-tree-item", { hasText: "点眼" }).click();
  assert.deepEqual(await setNames(), ["緑内障 定期", "緑内障 追加"], "the order is saved");

  await page.goto(`${baseUrl}/`);
  await openPatientFromSearch(page, "見本", "見本 花子");
  await page.getByRole("heading", { name: "経過" }).waitFor();
  await page.getByRole("button", { name: /本日のカルテを作成/ }).click();
  // セット（右のオーダー、1 キー）: フォルダの木から押すと中央に入る
  await page.getByRole("textbox", { name: "主訴・所見", exact: true }).waitFor();
  await page.locator(".chart-head").click();
  await page.keyboard.press("1");
  // 設定で入れ子のフォルダ（緑内障 / 点眼）に入れたセットは、そのフォルダを開いてから押す
  await page.locator("details.set-folder:not([open]) > summary", { hasText: "点眼" }).click();
  await page.getByRole("button", { name: /緑内障 定期/ }).click();
  await page.getByText("セット「緑内障 定期」を追加しました。").waitFor();
  await page.locator(".rp-group.is-order").first().waitFor();
  await page.getByRole("tab", { name: "定型文" }).click();
  await page.locator(".phrase-row").getByRole("button", { name: "挿入" }).click();
  assert.match(await page.getByRole("textbox", { name: "方針", exact: true }).inputValue(), /点眼継続。\n次回同様。/u);
  // 現在のカルテからセット（フォルダもその場で作る）→ セットタブの先頭に入る
  await page.getByRole("button", { name: "セット登録" }).click();
  const setDialog = page.getByRole("dialog", { name: /セット登録/u });
  await setDialog.getByLabel("セット名").fill("緑内障 再診 Do");
  await setDialog.getByRole("button", { name: "＋ フォルダ" }).click();
  await setDialog.getByLabel("新しいフォルダ名").fill("緑内障");
  await setDialog.getByRole("button", { name: "追加", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="フォルダ"]')?.value, null, { timeout: 10_000 });
  await setDialog.getByRole("button", { name: "保存" }).click();
  await page.getByText("セット「緑内障 再診 Do」を保存しました。").waitFor();
  await page.locator(".set-folder").filter({ hasText: "緑内障" }).getByRole("button", { name: /緑内障 再診 Do/u }).waitFor();
  // 眼鏡処方（右のオーダーの「眼鏡・CL」から処置・行為に入れる）
  await page.getByRole("tab", { name: "眼鏡・CL" }).click();
  await page.getByRole("button", { name: /眼鏡処方箋/u }).click();
  await page.getByLabel("右眼 S", { exact: true }).fill("-2");
  await page.getByLabel("左眼 S", { exact: true }).fill("-1.5");
  await page.getByLabel("瞳孔間距離").fill("62");
  // 詳細（素材・コート・カラー・装用方法）は畳んである。入れたら紙に ■ で出る
  assert.equal(await page.getByLabel("素材", { exact: true }).count(), 0, "optical details start collapsed");
  await page.getByRole("button", { name: /詳細（素材・コート・カラー・装用方法）/u }).click();
  await page.getByLabel("素材", { exact: true }).selectOption("polycarbonate");
  await page.getByLabel("コート", { exact: true }).fill("UVカット");
  await page.getByLabel("装用方法", { exact: true }).selectOption("always");
  await page.getByText("今回眼鏡処方箋を発行する").click();
  await page.getByRole("link", { name: "眼鏡処方箋を印刷" }).waitFor();
  assert.equal(await page.locator("#sec-optical .readiness .is-blocker").count(), 0);
  // 区分バッジのメニュー「左右に分ける」: 両眼の Rp を右眼・左眼の 2 つの Rp にする
  const carriedRp = page.locator(".rp-group.is-rx").first();
  await carriedRp.locator("summary.rp-badge").first().click();
  await page.getByRole("button", { name: "左右に分ける" }).click();
  assert.equal(await page.locator(".rp-group.is-rx").nth(0).getByRole("button", { name: "R", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".rp-group.is-rx").nth(1).getByRole("button", { name: "L", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  const opticalPage = await context.newPage();
  await opticalPage.goto(`${page.url()}/optical`);
  await opticalPage.getByRole("heading", { name: "眼鏡処方箋" }).waitFor();
  assert.equal(await opticalPage.getByText("-2.00").count() > 0, true);
  // 未確定のカルテの処方箋は、紙にも透かしが入り、医師名は空欄（最後に保存した人を医師として出さない）
  await opticalPage.getByRole("button", { name: "下書きとして印刷" }).waitFor();
  assert.equal(await opticalPage.locator(".sheet .print-watermark").count(), 1);
  assert.equal((await opticalPage.locator(".rx-sign-name").innerText()).replace("印", "").trim(), "");
  assert.match(await opticalPage.locator(".rx-values").innerText(), /62/u);
  assert.deepEqual(await opticalPage.locator(".rx-form .rx-choice.is-on").allInnerTexts(), ["■ポリカーボネート", "■単焦点", "■遠用", "■常時"], "selected details are printed as ■");
  await opticalPage.locator(".rx-form .rx-fill").filter({ hasText: "UVカット" }).waitFor();
  await opticalPage.getByRole("button", { name: "A5" }).click();
  assert.equal(await opticalPage.locator(".sheet.sheet-a5").count(), 1);
  const draftChart = await context.newPage();
  await draftChart.goto(`${page.url()}/print`);
  await draftChart.getByRole("button", { name: "下書きとして印刷" }).waitFor();
  assert.equal(await draftChart.locator(".sheet .print-watermark").count(), 1, "a draft chart prints with the watermark");
  await draftChart.close();
  await opticalPage.close();

  // 紹介状を作成・確定・印刷（左の「ファイル」タブの文書から）
  await page.getByRole("tab", { name: "ファイル" }).click();
  await page.locator(".docs-create > summary").first().click();
  await page.getByRole("button", { name: "紹介状を作成" }).click();
  await page.getByRole("heading", { name: /診療情報提供書/ }).waitFor();
  // 医療機関情報の入力が差出人に入る
  await page.locator(".doc-preview-pane .ls-from").filter({ hasText: "スモーク眼科クリニック" }).filter({ hasText: "FAX 03-1234-5679" }).waitFor();
  const documentUrl = page.url();
  assert.match(await page.locator("textarea.document-body").inputValue(), /アレルギー・副作用歴】\nペニシリン系（発疹）/u);
  // 紹介目的が空の紹介状は確定できない
  await page.locator(".doc-checks").getByText("紹介目的が空です。").waitFor();
  await page.getByRole("button", { name: "確定する" }).click();
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: "確定する" }).isDisabled(), true);
  await page.getByRole("dialog").getByRole("button", { name: "戻って編集" }).click();
  // 印刷プレビューは保存してから開く（打った直後の入力も紙に出る）。下書きは紙にも透かし
  await page.getByLabel("宛先 医療機関").fill("県立中央病院");
  // 敬称: 未設定は従来どおり「先生 御侍史」。「御中」にすると施設宛ての宛名になる
  await page.locator(".doc-preview-pane .ls-to-doctor").filter({ hasText: "ご担当 先生 御侍史" }).waitFor();
  await page.getByLabel("宛先 敬称").selectOption("御中");
  await page.locator(".doc-preview-pane .ls-to-inst").filter({ hasText: "県立中央病院 御中" }).waitFor();
  assert.equal(await page.locator(".doc-preview-pane .ls-to-doctor").count(), 0, "no doctor line when addressed to the institution");
  await page.getByRole("button", { name: "印刷プレビュー" }).click();
  await page.waitForURL(/\/documents\/[^/]+\/print$/u);
  await page.locator(".sheet").getByText("県立中央病院").waitFor();
  await page.locator(".sheet .ls-to-inst").filter({ hasText: "県立中央病院 御中" }).waitFor();
  assert.equal(await page.locator(".sheet .print-watermark").count(), 1);
  await page.getByRole("button", { name: "下書きとして印刷" }).waitFor();
  await page.getByRole("link", { name: "← 文書に戻る" }).click();
  await page.waitForURL(documentUrl);
  await page.getByRole("textbox", { name: "紹介目的", exact: true }).fill("緑内障の精査をお願いいたします。");
  assert.match(await page.locator("textarea.document-body").inputValue(), /【紹介目的】\n緑内障の精査をお願いいたします。\n/u);
  await page.locator(".doc-preview-pane .ls-grid").getByText("緑内障の精査をお願いいたします。").waitFor();
  // カルテから挿入: 既にある本文は変えず、末尾（カーソル位置）に足すだけ
  const bodyBefore = await page.locator("textarea.document-body").inputValue();
  await page.getByRole("button", { name: "＋カルテから挿入" }).click();
  await page.getByRole("button", { name: /^選んだ [1-9]\d* 件をカーソル位置に挿入$/u }).click();
  const bodyAfter = await page.locator("textarea.document-body").inputValue();
  assert.equal(bodyAfter.startsWith(bodyBefore), true, `inserting keeps the existing text\n${JSON.stringify(bodyBefore)}\n${JSON.stringify(bodyAfter)}`);
  assert.equal(bodyAfter.length > bodyBefore.length, true);
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "確定する" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "確定する" }).click();
  await page.getByRole("button", { name: "複製して修正" }).waitFor();
  await page.locator(".doc-done").getByRole("button", { name: "印刷する" }).waitFor();
  assert.equal(await page.locator("textarea.document-body").count(), 0, "a finalized document is shown read-only");
  const letter = await context.newPage();
  await letter.goto(`${documentUrl}/print`);
  await letter.locator(".sheet").getByText("県立中央病院").waitFor();
  await letter.getByRole("button", { name: "印刷", exact: true }).waitFor();
  assert.equal(await letter.locator(".print-watermark").count(), 0);
  await letter.close();
  // 複製した下書きは破棄できる（一覧から消える）
  await page.getByRole("button", { name: "複製して修正" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/documents/") && url.href !== documentUrl);
  await page.locator('summary[aria-label="文書のその他の操作"]').click();
  await page.getByRole("button", { name: "下書きを破棄" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "破棄する" }).click();
  await page.waitForURL(/\/patients\//u);

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

  // デジカルの受付一覧: フラットな 1 枚の表（段階ごとのまとまり・人数チップはない）。列の順はデジカルと同じ
  const table = page.getByRole("table", { name: "受付一覧" });
  await table.waitFor();
  assert.equal(await page.locator(".flow-chips, .flow-group").count(), 0, "no grouped list and no count chips");
  const headers = await table.locator("thead .rc-sort").allInnerTexts();
  assert.deepEqual(headers.map((text) => text.replace(/[▲▼↕]/gu, "").trim()).slice(0, 8), ["番号", "予約時間", "受付時間", "ステータス", "患者番号", "氏名", "生年月日", "年齢"]);
  assert.deepEqual(headers.map((text) => text.replace(/[▲▼↕]/gu, "").trim()).slice(-4), ["会計", "進捗", "散瞳", "待ち時間"]);
  await page.getByText("全 0件").waitFor();

  // 予約（2 列のダイアログ）: 予約状況の枠を押すと予約日・予約時間に入る。医師・診療科を選ぶ
  await page.getByRole("button", { name: "予約を追加" }).click();
  const booking = page.getByRole("dialog", { name: "予約登録" });
  await booking.getByText("患者を選ぶと、その人の予約が出ます。").waitFor();
  await booking.getByLabel("患者を検索").fill("試験");
  await booking.getByRole("button", { name: /試験 一郎/ }).click();
  await booking.getByText("予約はありません。").waitFor();
  await booking.getByRole("button", { name: "予約状況" }).click();
  const jst = new Date(Date.now() + 9 * 3600000);
  await booking.getByRole("button", { name: new RegExp(`^${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日\\(.\\) 9:30 予約0件$`, "u") }).click();
  assert.equal(await booking.getByLabel("予約時間").inputValue(), "09:30", "a slot in the booking grid fills the time");
  await booking.getByLabel("医師").selectOption({ label: "医師" });
  await booking.getByLabel("診療科").fill("眼科");
  await booking.getByRole("button", { name: "登録", exact: true }).click();
  const row = page.locator(".rc-row").filter({ hasText: "試験 一郎" });
  await row.waitFor();
  assert.equal(await statusOf(row), "booked");
  assert.equal((await row.locator(".rc-col-no").innerText()).trim(), "-");
  assert.equal((await row.locator(".rc-col-time").innerText()).trim(), "09:30");
  await row.locator(".rc-col-doctor").getByText("医師").waitFor();
  // 予約済をステータスのプルダウンで受付中にすると受付になる（番号 001）
  await row.getByLabel("試験 一郎 のステータス").selectOption("checked_in");
  await waitForStatus(row, "checked_in");
  assert.equal((await row.locator(".rc-col-no").innerText()).trim(), "001");

  // 予約なし・未登録の当日受付 → 患者登録（行の「…」メニューから）
  await page.getByRole("button", { name: "当日受付" }).click();
  await page.getByLabel("患者を検索").fill("飛込 花子");
  await page.getByRole("dialog", { name: "当日受付" }).getByRole("button", { name: "登録", exact: true }).click();
  const walkIn = page.locator(".rc-row").filter({ hasText: "飛込 花子" });
  await walkIn.waitFor();
  assert.equal((await walkIn.locator(".rc-col-no").innerText()).trim(), "002");
  await walkIn.locator("summary").click();
  await walkIn.getByRole("button", { name: "患者登録" }).click();
  // 共通の登録ダイアログ: 項目はデジカルの順（患者番号が先頭）。フリガナは必須で、ひらがなはカタカナにそろえる
  const registerDialog = page.getByRole("dialog", { name: /患者登録/u });
  assert.equal(await registerDialog.evaluate((node) => document.activeElement === node.querySelector("#reg-number")), true, "the patient number comes first");
  assert.equal(await registerDialog.getByRole("button", { name: "登録して受付に紐づける" }).isDisabled(), true, "kana is required");
  assert.equal(await registerDialog.getByRole("button", { name: "登録して受付", exact: true }).count(), 0, "linking an existing reception has no second reception button");
  await registerDialog.getByLabel("フリガナ").fill("とびこみ はなこ");
  await registerDialog.getByLabel("フリガナ").blur();
  assert.equal(await registerDialog.getByLabel("フリガナ").inputValue(), "トビコミ ハナコ");
  await registerDialog.getByText("保険証・資格確認はレセコンで登録します。").waitFor();
  await registerDialog.getByRole("button", { name: "登録して受付に紐づける" }).click();
  await walkIn.getByText("未登録").waitFor({ state: "detached" });

  // ステータスはプルダウンでどこへでも（処置中・不在・予約済へ戻す）。受付し直しても番号は最初のまま
  const menu = await walkIn.locator("select.rc-status option").allInnerTexts();
  assert.deepEqual(menu, ["予約済", "受付中", "診察待", "診察中", "検査中", "処置中", "会計待", "会計済", "再計待", "不在", "取消"]);
  for (const status of ["in_treatment", "absent", "booked", "checked_in"]) {
    await walkIn.getByLabel("飛込 花子 のステータス").selectOption(status);
    await waitForStatus(walkIn, status);
  }
  assert.equal((await walkIn.locator(".rc-col-no").innerText()).trim(), "002", "the queue number stays from the first check-in");

  // 受付メモ・患者メモ: セルを押すと小さなダイアログ
  await row.getByRole("button", { name: /試験 一郎 の受付メモ/u }).click();
  await page.getByRole("dialog", { name: /受付メモ/u }).getByLabel("受付メモ").fill("保険証確認");
  await page.getByRole("dialog", { name: /受付メモ/u }).getByRole("button", { name: "登録" }).click();
  await row.locator(".rc-col-receptionMemo").getByText("保険証確認").waitFor();
  await row.getByRole("button", { name: /試験 一郎 の患者メモ/u }).click();
  await page.getByRole("dialog", { name: /患者メモ/u }).getByLabel("患者メモ").fill("耳が遠い");
  await page.getByRole("dialog", { name: /患者メモ/u }).getByRole("button", { name: "登録" }).click();
  await row.locator(".rc-col-patientMemo").getByText("耳が遠い").waitFor();
  assert.equal((await row.locator(".rc-col-previous").innerText()).trim(), "初");

  // 絞り込み: ステータスを外すと「表示数 / 全数件」、表示する列は端末に記憶する。×で解除
  await page.getByRole("button", { name: "▼ 絞り込み" }).click();
  const filter = page.getByRole("dialog", { name: "絞り込み" });
  await filter.getByRole("checkbox", { name: /受付中/u }).uncheck();
  await page.getByText("0 / 2件").waitFor();
  await filter.getByRole("checkbox", { name: "待ち時間" }).uncheck();
  assert.equal(await table.locator("th.rc-col-wait").count(), 0);
  assert.deepEqual(JSON.parse(await page.evaluate(() => window.localStorage.getItem("halunasu-eye-reception-columns"))), ["wait"]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "絞り込みを解除" }).click();
  await page.getByText("全 2件").waitFor();
  await page.reload();
  await row.waitFor();
  assert.equal(await table.locator("th.rc-col-wait").count(), 0, "hidden columns are remembered on this device");
  await page.getByRole("button", { name: "▼ 絞り込み" }).click();
  await filter.getByRole("checkbox", { name: "待ち時間" }).check();
  await page.keyboard.press("Escape");
  // 見出しで並べ替え（氏名はカナ順）
  await table.getByRole("button", { name: /^氏名/u }).click();
  assert.equal(await table.locator("th.rc-col-name").getAttribute("aria-sort"), "ascending");
  assert.deepEqual((await table.locator("tbody .rc-kana").allInnerTexts()).map((text) => text.trim()), ["シケン イチロウ", "トビコミ ハナコ"]);
  await table.getByRole("button", { name: /^番号/u }).click();

  // 患者検索のモーダル（ヘッダーの虫めがね）: 行に［表示］［編集］［受付］［予約］、右上に［新規患者登録］
  const search = await searchPatient(page, "しけん");
  const found = search.locator(".ps-row").filter({ hasText: "試験 一郎" });
  await found.waitFor();
  // モーダルから新規登録: 入力した語が登録欄に入り、似た患者があれば警告が出る。Esc は登録だけを閉じる
  await search.getByRole("button", { name: "新規患者登録" }).click();
  const headerDialog = page.getByRole("dialog", { name: "新規患者を登録" });
  assert.equal(await headerDialog.getByLabel("フリガナ").inputValue(), "シケン");
  await headerDialog.getByText("似た患者がいます").waitFor();
  await headerDialog.locator(".register-similar").getByText("試験 一郎").waitFor();
  await page.keyboard.press("Escape");
  await headerDialog.waitFor({ state: "detached" });
  await search.waitFor();
  await found.getByText("耳が遠い").waitFor();
  for (const name of ["表示", "編集", "受付", "予約"]) await found.getByRole("button", { name, exact: true }).waitFor();
  // 新規患者登録 → ［登録して受付］で受付登録へ続け、受付一覧に行が増える
  await search.getByLabel("検索する語").fill("とうろく たろう");
  await search.getByRole("button", { name: "新規患者登録" }).click();
  const newPatient = page.getByRole("dialog", { name: "新規患者を登録" });
  assert.equal(await newPatient.getByLabel("フリガナ").inputValue(), "トウロク タロウ");
  await newPatient.getByLabel("氏名").fill("登録 太郎");
  await newPatient.getByLabel("都道府県").selectOption("東京都");
  await newPatient.getByLabel("電話番号1").fill("03-1234-5678");
  await newPatient.getByRole("button", { name: "登録して受付", exact: true }).click();
  const receive = page.getByRole("dialog", { name: "受付登録" });
  await receive.getByRole("button", { name: "登録", exact: true }).click();
  await search.waitFor({ state: "detached" });
  const added = page.locator(".rc-row").filter({ hasText: "登録 太郎" });
  await added.waitFor();
  assert.equal((await added.locator(".rc-col-no").innerText()).trim(), "003");

  // 状態を進める（検査中 → 診察待）
  await row.getByLabel("試験 一郎 のステータス").selectOption("in_exam");
  await waitForStatus(row, "in_exam");
  await row.getByLabel("試験 一郎 のステータス").selectOption("waiting_doctor");
  await waitForStatus(row, "waiting_doctor");
  // 予約状況の画面（受付の［予約状況］から）: 週 × 時間の表に件数が出る
  await page.getByRole("link", { name: "予約状況" }).click();
  await page.getByRole("heading", { name: "予約状況", exact: true }).waitFor();
  await page.getByRole("button", { name: new RegExp(`^${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日\\(.\\) 9:30 予約1件$`, "u") }).waitFor();
  await page.getByRole("link", { name: "受付一覧へ" }).click();
  await row.waitFor();

  // 会計: 会計待で確定済みの行に［会計］。確認 → 1 人分の連携（POST /billing/send）→ CSV を保存（一覧と応答を差し替えて確かめる）
  await page.route(/\/v1\/eye\/appointments\?date=/u, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const target = body.appointments.find((item) => item.patientName === "飛込 花子");
    if (target) {
      target.status = "checkout";
      target.displayStatus = "checkout";
      body.encountersByPatient[target.patientId] = { encounterId: "enc_smoke", status: "finalized", exam: {}, orders: [] };
    }
    await route.fulfill({ response, json: body });
  });
  let sent = null;
  await page.route(/\/v1\/eye\/billing\/send$/u, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { handoff: { handoffId: "ebh_smoke1" }, csv: "区分,名称\n", appointment: null, appointmentMoved: true, appointmentError: null } });
  });
  await page.reload();
  await walkIn.getByRole("button", { name: "会計", exact: true }).click();
  await page.getByRole("alertdialog", { name: /レセコンへ会計情報を渡しますか/u }).waitFor();
  const [handoffCsv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "渡す", exact: true }).click()]);
  assert.match(handoffCsv.suggestedFilename(), /^eye-billing-\d{4}-\d{2}-\d{2}-smoke1\.csv$/u);
  assert.equal(sent.encounterId, "enc_smoke");
  assert.ok(sent.appointmentId, "the reception is sent so the API can mark it paid");
  await page.getByText(/会計情報を渡しました/u).waitFor();
  await page.unrouteAll({ behavior: "wait" });

  // 会計連携（デジカルの会計と同じく 1 人ずつ）: 行の［連携］→ 確認 → CSV を保存して連携済。受付の順の平らな表
  await page.getByRole("link", { name: "会計連携" }).click();
  const billRow = (state, name) => page.locator(`.bill-row-wrap[data-state="${state}"]`).filter({ hasText: name }).first();
  const pendingRow = billRow("pending", "見本 花子");
  await pendingRow.waitFor();
  await page.locator('.bill-row-wrap[data-state="draft"]').first().waitFor();
  assert.match(await pendingRow.locator(".bill-summary").innerText(), /処方\d/u);
  assert.equal(await page.getByRole("button", { name: /全件 CSV/u }).isVisible(), false, "the all-day CSV is tucked away in the menu");
  assert.equal(await page.locator(".bill-selbar").count(), 0, "nobody is selected for the bulk handoff at first");
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
  // 1 人ずつ連携。確認は Esc でやめられる
  const sendDialog = page.getByRole("dialog", { name: /会計情報をレセコンへ渡しますか/u });
  await pendingRow.getByRole("button", { name: "見本 花子 を連携" }).click();
  await sendDialog.locator(".bill-items").waitFor();
  await page.keyboard.press("Escape");
  await sendDialog.waitFor({ state: "detached" });
  await pendingRow.getByRole("button", { name: "見本 花子 を連携" }).click();
  let [latestDownload] = await Promise.all([page.waitForEvent("download"), sendDialog.getByRole("button", { name: "連携する" }).click()]);
  assert.match(latestDownload.suggestedFilename(), /^eye-billing-\d{4}-\d{2}-\d{2}-/u);
  await page.getByText(/見本 花子さんを連携しました。/u).waitFor();
  await billRow("handed_off", "見本 花子").locator(".bill-state").filter({ hasText: "連携済" }).waitFor();
  // 残りの未連携は、選んでまとめて連携もできる（補助）
  if (await page.locator('.bill-row-wrap[data-state="pending"]').count()) {
    await page.getByLabel("未連携の全員を選ぶ").check();
    const selbar = page.locator(".bill-selbar");
    assert.match(await selbar.innerText(), /人を選択中/u);
    [latestDownload] = await Promise.all([page.waitForEvent("download"), selbar.getByRole("button", { name: "まとめて連携（CSV）" }).click()]);
    await page.getByText(/人をまとめて連携しました。/u).waitFor();
    await selbar.waitFor({ state: "detached" });
  }
  // その回の CSV を取り直せる（連携したときと同じ中身）
  await page.getByRole("button", { name: /連携の記録/u }).click();
  const [again] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "この回の CSV" }).first().click()]);
  assert.equal(readFileSync(await again.path(), "utf8"), readFileSync(await latestDownload.path(), "utf8"));
  // 日付を変えると通知は消え、今日でないことを示す
  await page.getByRole("button", { name: "前日" }).click();
  await page.getByText(/今日ではありません/u).waitFor();
  assert.equal(await page.getByText(/連携しました。/u).count(), 0);
  await page.getByRole("button", { name: "今日", exact: true }).click();

  // 再計待: 前回の品目と違う行は差分チップを出し、差分を見てから［再連携］する（前回の品目は応答を差し替えて作る）
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
  const changedRow = page.locator('.bill-row-wrap[data-state="changed"]').first();
  await changedRow.locator(".bill-chip.is-removed").filter({ hasText: "旧点眼薬" }).waitFor();
  await changedRow.locator(".bill-state").filter({ hasText: "再計待" }).waitFor();
  assert.equal(await page.locator('.bill-row-wrap[data-state="changed"] input[type=checkbox]').count(), 0, "rows that need another handoff are never bulk-selected");
  await page.getByRole("button", { name: /^再計待/u }).click();
  assert.equal(await page.locator(".bill-rows > .bill-row-wrap").count(), await page.locator('.bill-rows > .bill-row-wrap[data-state="changed"]').count(), "the tab shows only rows waiting for another handoff");
  await changedRow.locator(".flow-row-open").click();
  await page.locator(".bill-diff-row.is-removed").filter({ hasText: "旧点眼薬" }).waitFor();
  await page.locator(".bill-diff-row.is-added").first().waitFor();
  await page.getByText(/前回分（v\d+）を取り消すか直してから/u).waitFor();
  await changedRow.locator(".bill-actions").getByRole("button", { name: /を再連携$/u }).click();
  const resendDialog = page.getByRole("dialog", { name: /もう一度レセコンへ渡しますか/u });
  await resendDialog.getByText(/−旧点眼薬/u).waitFor();
  const [redo] = await Promise.all([page.waitForEvent("download"), resendDialog.getByRole("button", { name: "再連携する" }).click()]);
  assert.match(redo.suggestedFilename(), /^eye-billing-/u);
  await page.getByText(/再連携しました。/u).waitFor();
  await page.unrouteAll({ behavior: "wait" });

  // ログアウトは利用者メニューの中。病院コードは端末に覚え、次回は入力を省く
  await page.locator(".eh-user-button").click();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.locator(".operator-gate-remembered").getByText(LOCAL_ORGANIZATION_CODE).waitFor();
  assert.equal(await page.getByLabel("病院コード").count(), 0);
  await page.getByRole("button", { name: "変更" }).click();
  await page.getByLabel("病院コード").waitFor();

  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function runOrthoptistFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page, "orthoptist");
  // 診察: 受付で検査を終えた患者が「診察待ち」に出て、ナビに人数が出る。要対応のチップで一覧を切り替える
  // 患者一覧: 最初は「診察待」のタブ。行を 1 回押すと右に概要（カルテは開かない）
  await page.getByRole("heading", { name: "診察", exact: true }).waitFor();
  const waitingRow = page.locator(".cl-row.stage-waiting").filter({ hasText: "試験 一郎" });
  await waitingRow.waitFor();
  assert.equal(await page.getByRole("tab", { name: /^診察待/u }).getAttribute("aria-selected"), "true");
  assert.equal((await page.locator(".eh-tool-list .eh-badge").innerText()).trim(), "1");
  assert.equal(await page.locator(".eh-tool-list").getAttribute("aria-label"), "患者リスト（診察）（診察待 1人）");
  // 施設管理は管理者だけ（視能訓練士の利用者メニューには出ない）
  await page.locator(".eh-user-button").click();
  await page.locator(".eh-user-list").getByRole("button", { name: "ログアウト" }).waitFor();
  assert.equal(await page.locator(".eh-user-list").getByRole("link").count(), 0, "non-admins have no 施設管理 entry");
  await page.locator(".eh-user-button").click();
  await waitingRow.click();
  const summary = page.getByRole("region", { name: /^カルテ概要/u });
  await summary.getByRole("button", { name: "診察開始" }).waitFor();
  await summary.locator(".ps-info").getByText("試験 一郎").waitFor();
  assert.equal(new URL(page.url()).pathname, "/", "a single click must not open the chart");
  assert.equal(await waitingRow.getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("button", { name: "次の患者" }).isEnabled(), true);
  await page.getByRole("tab", { name: /^未確定カルテ/u }).click();
  await page.getByRole("region", { name: "未確定カルテ" }).waitFor();
  await page.getByRole("tab", { name: /^全て/u }).click();
  await page.locator(".cl-row").filter({ hasText: "試験 一郎" }).waitFor();
  await openPatientFromSearch(page, "試験", "試験 一郎");
  await page.getByRole("button", { name: "初診カルテを作成" }).click();
  await page.getByRole("heading", { name: "検査", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /次へ/u }).count(), 0, "orthoptists cannot finalize");
  await page.getByText("確定は医師が行います").waitFor();
  const encounterUrl = page.url();

  // 当日受付（受付済）を 1 件作り、検査ページの「検査終了 → 診察待ちへ」で進める
  await page.goto(`${baseUrl}/reception`);
  await page.getByRole("button", { name: "当日受付" }).click();
  await page.getByLabel("患者を検索").fill("試験");
  await page.getByRole("dialog").getByRole("button", { name: /試験 一郎/u }).click();
  await page.getByRole("dialog", { name: "当日受付" }).getByRole("button", { name: "登録", exact: true }).click();
  await waitForRowStatuses(page, "試験 一郎", (values) => values.includes("checked_in"));

  // 検査入力: 記録の行（検査日・時刻・検者・登録）→ 大タブ 11 個 → 本文。下は「確定系 … キャンセル … 保存して戻る … 保存して次へ」
  await page.goto(`${encounterUrl}/exam`);
  await page.getByRole("heading", { name: "検査入力" }).waitFor();
  assert.deepEqual(await page.locator(".rd-tab").allInnerTexts(), ["視力", "眼圧", "屈折", "角膜曲率", "眼位", "両眼視", "色覚", "立体視", "調節", "前眼部", "その他"]);
  await page.getByRole("button", { name: "検査終了 → 診察待ちへ" }).waitFor();
  assert.deepEqual(await page.locator(".rd-bar-buttons .btn").allInnerTexts(), ["検査終了 → 診察待ちへ", "キャンセル", "保存して戻る", "保存して次へ"]);
  assert.equal(await page.locator(".rd-device").count(), 3, "kerato / refraction / tonometer reference panels");
  // 視力の表: 行 = 遠見 R/L/B・近見 R/L/B。Enter は行の順（裸眼 → 矯正 → S → C → A → RG → 次の行）
  await page.getByLabel("遠見 右眼 裸眼視力").click();
  await page.keyboard.type("0.3");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "遠見 右眼 矯正視力");
  await page.keyboard.type("0.7");
  await page.keyboard.press("Enter");
  await page.keyboard.type("-");
  assert.equal(await page.getByLabel("遠見 右眼 球面").inputValue(), "-", "a lone minus sign must stay while typing");
  await page.keyboard.type("2.5");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "遠見 右眼 円柱");
  assert.equal(await page.getByLabel("遠見 右眼 球面").inputValue(), "-2.50");
  await page.keyboard.type("-0.75");
  await page.keyboard.press("Enter");
  await page.keyboard.type("180");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "遠見 右眼 RG");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "遠見 左眼 裸眼視力");
  assert.equal(await page.getByLabel("遠見 両眼 球面").count(), 0, "the B rows hold VA only");
  await page.getByLabel("近見 両眼 矯正視力").fill("1.0");
  // 視力の候補に「矯正不能（n.c.）」がある
  assert.equal(await page.locator('#va-values option[value="n.c."]').count(), 1);
  // 眼圧: 3 回と平均（自動計算）・測定方法・時刻
  await page.getByRole("tab", { name: "眼圧" }).click();
  await page.getByLabel("右眼 眼圧 1回目").fill("14");
  await page.getByLabel("右眼 眼圧 2回目").fill("15");
  await page.getByLabel("右眼 眼圧 3回目").fill("15");
  assert.match(await page.locator('[aria-label="右眼 眼圧の平均"]').innerText(), /^14\.7/u);
  await page.getByLabel("眼圧の測定方法").selectOption("nct");
  await page.getByLabel("眼圧の測定時刻").fill("09:05");
  // 登録で「その時刻の記録」が 1 件できる
  await page.getByLabel("検査時刻").fill("09:00");
  await page.getByText("未登録の入力があります").waitFor();
  await page.getByRole("button", { name: "登録", exact: true }).click();
  await page.locator(".rd-record-chip").filter({ hasText: "09:00" }).waitFor();
  await page.getByText("未登録の入力があります").waitFor({ state: "detached" });
  assert.equal(await page.locator(".rd-tab.has-values").count(), 2, "tabs with values are marked");
  // 同じ日の 2 件目（散瞳後など）: 眼位の 9 方向と Worth 4 灯（図のボタン）
  await page.getByRole("button", { name: "＋ 新しい記録" }).click();
  await page.getByRole("tab", { name: "視力" }).click();
  assert.equal(await page.getByLabel("遠見 右眼 裸眼視力").inputValue(), "", "a new record starts empty");
  await page.getByRole("tab", { name: "眼位" }).click();
  await page.getByRole("button", { name: "全て正常" }).click();
  await page.getByLabel("左上 左眼").selectOption("-2");
  assert.equal(await page.locator(".rd-nine-cell.is-abnormal").count(), 1);
  await page.getByRole("button", { name: "右上 クリア" }).click();
  assert.equal(await page.locator(".rd-nine-cell.is-normal").count(), 7);
  await page.getByRole("tab", { name: "両眼視" }).click();
  await page.getByRole("button", { name: /4灯（融像）/u }).click();
  assert.equal(await page.getByRole("button", { name: /4灯（融像）/u }).getAttribute("aria-pressed"), "true");
  await page.getByLabel("遮閉試験 近見 種類").selectOption("phoria");
  await page.getByLabel("検査時刻").fill("10:30");
  await page.getByRole("button", { name: "登録", exact: true }).click();
  await page.locator(".rd-record-chip").filter({ hasText: "10:30" }).waitFor();
  assert.equal(await page.locator(".rd-record-chip:not(.is-new)").count(), 2);
  // データ表示: 記録を検査ごとの見出しで並べる
  await page.getByRole("button", { name: "データ表示" }).click();
  const dataDialog = page.getByRole("dialog", { name: "本日の検査記録" });
  await dataDialog.getByText(/14 15 15/u).waitFor();
  await dataDialog.getByText(/4灯（融像）/u).waitFor();
  await dataDialog.getByRole("button", { name: "閉じる" }).click();
  // 前の記録に切り替えて直す → キャンセルで登録前に戻る
  await page.locator(".rd-record-chip").filter({ hasText: "09:00" }).click();
  await page.getByRole("tab", { name: "視力" }).click();
  assert.equal(await page.getByLabel("遠見 右眼 裸眼視力").inputValue(), "0.3");
  await page.getByLabel("遠見 右眼 裸眼視力").fill("0.4");
  await page.getByRole("button", { name: "キャンセル" }).click();
  assert.equal(await page.getByLabel("遠見 右眼 裸眼視力").inputValue(), "0.3");

  // 本日の検査: 追加 → 押して実施（値を入れても自動では実施にしない）
  await page.getByRole("button", { name: "＋ 検査を追加" }).click();
  await page.locator(".checklist-choices").getByRole("button", { name: "視力検査" }).click();
  await page.locator(".checklist-row").filter({ hasText: "視力検査" }).getByText("値あり").waitFor();
  assert.equal(await page.locator(".checklist-row .order-status-performed").count(), 0, "entering values must not mark orders performed");
  await page.getByRole("button", { name: "視力検査を実施済みにする" }).click();
  await page.locator(".checklist-row .order-status-performed").waitFor();

  // 散瞳: ボタン 1 つ + 眼の選択。散瞳オーダーは自動で実施にしない
  await page.locator(".checklist-choices").getByRole("button", { name: "ほかの検査" }).click();
  await page.locator(".checklist-choices").getByRole("button", { name: "散瞳", exact: true }).click();
  await page.getByRole("button", { name: "散瞳開始" }).click();
  await page.getByText(/散瞳中（両眼） 0分/u).waitFor();
  assert.equal(await page.locator(".checklist-row").filter({ hasText: "散瞳" }).locator(".order-status-performed").count(), 0);
  await page.getByRole("button", { name: "散瞳オーダーを実施にする" }).click();
  await page.locator(".checklist-row").filter({ hasText: "散瞳" }).locator(".order-status-performed").waitFor();
  // （受付の「散瞳中」の組に入らないよう、散瞳は取り消してから検査終了を確かめる）
  await page.getByRole("button", { name: "散瞳を取り消す" }).click();
  await page.getByRole("button", { name: "散瞳開始" }).waitFor();

  // 申し送り: 定型チップは末尾に追記
  await page.getByRole("textbox", { name: "スタッフメモ" }).fill("左眼は固視が不安定");
  await page.getByRole("button", { name: "CL装用中" }).click();
  assert.equal(await page.getByRole("textbox", { name: "スタッフメモ" }).inputValue(), "左眼は固視が不安定\nCL装用中");
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });

  // 検査終了: 保存 → 値のある眼を確認 → 受付を「診察待ち」へ
  const finish = page.getByRole("button", { name: "検査終了 → 診察待ちへ" });
  await finish.waitFor();
  await finish.click();
  await page.waitForURL(/\/reception$/u);
  await waitForRowStatuses(page, "試験 一郎", (values) => values.includes("waiting_doctor") && !values.includes("checked_in"));
  await page.goto(`${encounterUrl}/exam`);
  await page.locator(".exam-bar-eye.is-done").filter({ hasText: "R" }).waitFor();
  assert.equal(await page.locator(".exam-bar-eye.is-empty").filter({ hasText: "L" }).count(), 1, "an eye without values is not confirmed");
  // 該当する受付がなければ、確認だけにして受付は動かさない
  await page.getByRole("button", { name: "検査値を確認する" }).waitFor();
  // 保存して次へ: 次に検査する患者（受付中・検査中）の検査入力へ。いなければ、その旨を出して留まる
  await page.getByRole("button", { name: "保存して次へ" }).click();
  const examPath = new URL(`${encounterUrl}/exam`).pathname;
  await Promise.race([
    page.getByText("次に検査する患者はいません").waitFor(),
    page.waitForURL((url) => url.pathname.endsWith("/exam") && url.pathname !== examPath)
  ]);
  if (new URL(page.url()).pathname !== examPath) await page.getByRole("heading", { name: "検査入力" }).waitFor();
  // 管理者でない人は設定を見るだけ（追加・保存はできず、管理の項目は出ない）。医療機関情報は見られるが直せない
  await page.goto(`${baseUrl}/settings#audit`);
  await page.getByRole("heading", { name: "医療機関情報" }).waitFor();
  await page.locator(".kv-row").filter({ hasText: "医療機関名" }).getByText("スモーク眼科クリニック").waitFor();
  assert.equal(await page.getByRole("button", { name: "✎ 編集" }).count(), 0);
  assert.equal(await page.locator(".settings-nav-item", { hasText: "操作記録" }).count(), 0);
  assert.equal(await page.locator(".settings-nav-item", { hasText: "利用者" }).count(), 0);
  await page.locator(".settings-nav-item", { hasText: "よく使う薬剤" }).click();
  await page.getByRole("heading", { name: /よく使う薬剤/u }).waitFor();
  assert.equal(await page.getByRole("button", { name: "＋ 薬剤を追加" }).count(), 0);
  await page.locator(".master-row").first().click();
  await page.getByRole("dialog", { name: "薬剤の編集" }).getByText("変更は管理者が行います。").waitFor();
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0);
  await page.keyboard.press("Escape");

  // パスワード変更（利用者メニュー）。この流れの最後に行い、ほかの流れの利用者には影響させない。
  // 2 つ目の端末（別のブラウザ）のログインは、変更のあと無効になる
  const otherDevice = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const otherPage = await otherDevice.newPage();
  await login(otherPage, "orthoptist");
  await otherPage.getByRole("heading", { name: "診察", exact: true }).waitFor();
  const newPassword = "orthoptist-new-password-2026";
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: "診察", exact: true }).waitFor();
  await page.locator(".eh-user-button").click();
  await page.locator(".eh-user-list").getByRole("button", { name: "パスワード変更" }).click();
  const passwordDialog = page.getByRole("dialog", { name: "パスワード変更" });
  await passwordDialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "pw-currentPassword", "the current password field has focus on open");
  await passwordDialog.getByText(/12文字以上/u).waitFor();
  const currentField = passwordDialog.getByLabel("現在のパスワード", { exact: true });
  const newField = passwordDialog.getByLabel("新しいパスワード", { exact: true });
  const confirmField = passwordDialog.getByLabel("新しいパスワード（確認）", { exact: true });
  // 空のまま押すと、欄の案内が role=alert で出る
  await passwordDialog.getByRole("button", { name: "変更する" }).click();
  await passwordDialog.getByRole("alert").getByText("現在のパスワードを入力してください。").waitFor();
  assert.equal(await currentField.getAttribute("aria-invalid"), "true");
  // 短い・確認が違う は送る前に止める
  await currentField.fill(LOCAL_PASSWORD);
  await newField.fill("short-pass");
  await confirmField.fill("short-pass");
  await passwordDialog.getByRole("button", { name: "変更する" }).click();
  await passwordDialog.getByRole("alert").getByText(/12文字以上で入力してください/u).waitFor();
  await newField.fill(newPassword);
  await confirmField.fill(`${newPassword}x`);
  await passwordDialog.getByRole("button", { name: "変更する" }).click();
  await passwordDialog.getByRole("alert").getByText("確認のパスワードが一致しません。").waitFor();
  // 表示・非表示の切り替え
  assert.equal(await newField.getAttribute("type"), "password");
  await passwordDialog.getByRole("button", { name: "新しいパスワードを表示" }).click();
  assert.equal(await newField.getAttribute("type"), "text");
  await passwordDialog.getByRole("button", { name: "新しいパスワードを隠す" }).click();
  assert.equal(await newField.getAttribute("type"), "password");
  // Caps Lock の案内
  await currentField.focus();
  await page.evaluate(() => {
    document.getElementById("pw-currentPassword").dispatchEvent(new KeyboardEvent("keyup", { key: "A", bubbles: true, modifierCapsLock: true }));
  });
  await passwordDialog.getByText("Caps Lock がオンです").waitFor();
  assert.match(await currentField.getAttribute("aria-describedby"), /pw-caps/u);
  await newField.focus();
  await passwordDialog.getByText("Caps Lock がオンです").waitFor({ state: "detached" });
  // 現在のパスワードが違うとサーバーが断る（パスワードは変わらない）
  await currentField.fill("wrong-password-2026");
  await confirmField.fill(newPassword);
  await passwordDialog.getByRole("button", { name: "変更する" }).click();
  await passwordDialog.getByRole("alert").getByText("現在のパスワードが正しくありません。").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "pw-currentPassword");
  // 正しく入れると変わり、この端末はログインしたまま
  await currentField.fill(LOCAL_PASSWORD);
  await passwordDialog.getByRole("button", { name: "変更する" }).click();
  await passwordDialog.getByRole("status").getByText(/パスワードを変更しました。この端末はログインしたままです/u).waitFor();
  await passwordDialog.getByRole("button", { name: "閉じる" }).click();
  await passwordDialog.waitFor({ state: "detached" });
  // 新しいトークンで eye-api が読める（画面の移動）・再読み込みしてもログインしたまま（cookie も新しい）
  await page.getByRole("link", { name: "受付画面", exact: true }).click();
  await page.getByRole("heading", { name: "受付", exact: true }).waitFor();
  await page.locator(".rc-row").filter({ hasText: "試験 一郎" }).first().waitFor();
  await page.reload();
  await page.locator(".rc-row").filter({ hasText: "試験 一郎" }).first().waitFor();
  assert.equal(await page.getByLabel("個人ID").count(), 0, "still signed in after reload");
  // ほかの端末は再読み込みでログイン画面に戻る
  await otherPage.reload();
  await otherPage.getByLabel("個人ID").waitFor();
  await otherDevice.close();
  // ログアウト → 古いパスワードでは入れず、新しいパスワードで入れる
  await page.locator(".eh-user-button").click();
  await page.locator(".eh-user-list").getByRole("button", { name: "ログアウト" }).click();
  await page.getByLabel("個人ID").waitFor();
  await page.getByLabel("個人ID").fill("orthoptist");
  await page.getByLabel("ログイン用パスワード", { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.getByRole("alert").getByText(/ログイン用パスワードが正しくありません/u).waitFor();
  await login(page, "orthoptist", newPassword);
  await page.getByRole("heading", { name: "診察", exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  await context.close();
}

async function login(page, loginId, password = LOCAL_PASSWORD) {
  await page.goto(baseUrl);
  await page.getByLabel("個人ID").waitFor();
  // 病院コードを端末に覚えているときは入力欄が出ない
  if (await page.getByLabel("病院コード").count()) await page.getByLabel("病院コード").fill(LOCAL_ORGANIZATION_CODE);
  await page.getByLabel("個人ID").fill(loginId);
  await page.getByLabel("ログイン用パスワード", { exact: true }).fill(password);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.getByLabel("6桁コード").fill(currentLocalTotp());
  await page.getByRole("button", { name: "確認" }).click();
}

// 受付一覧の行のステータス（プルダウンの値）
async function statusOf(row) {
  return row.locator("select.rc-status").inputValue();
}

async function waitForStatus(row, status) {
  await row.locator(`select.rc-status.is-${status}`).waitFor();
  assert.equal(await statusOf(row), status);
}

// 同じ氏名の行（同じ患者の複数の受付）のステータスが条件を満たすまで待つ
async function waitForRowStatuses(page, name, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let values = [];
  while (Date.now() - started < timeoutMs) {
    values = await page.locator(".rc-row").filter({ hasText: name }).locator("select.rc-status").evaluateAll((nodes) => nodes.map((node) => node.value));
    if (predicate(values)) return values;
    await page.waitForTimeout(200);
  }
  throw new Error(`${name}: statuses ${values.join(",")} did not reach the expected state`);
}

// ヘッダーは 1 行・高さ 40px・画面の幅いっぱい（ロゴは左端の余白 16px 以内）。左（画面名）と右（アイコン）が重ならず、横にあふれない。
// 767px 以下はロゴ・画面名・検索・メニューだけ
async function assertNavFits(page) {
  const original = page.viewportSize();
  for (const width of [390, 768, 900, 1024, 1280, 1713]) {
    await page.setViewportSize({ width, height: original.height });
    const bar = await page.locator(".eh-bar").boundingBox();
    const brand = await page.locator(".eh-brand").boundingBox();
    const left = await page.locator(".eh-left").boundingBox();
    const right = await page.locator(".eh-right").boundingBox();
    assert.ok(Math.abs(bar.height - (width < 768 ? 48 : 40)) <= 1, `header height at ${width}px is ${bar.height}`);
    assert.ok(brand.x <= 16, `logo starts at ${brand.x}px at ${width}px`);
    assert.ok(left.x + left.width <= right.x + 1, `header left and right overlap at ${width}px`);
    assert.ok(right.x + right.width <= width + 1, `header overflows at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `page scrolls sideways at ${width}px`);
    assert.equal(await page.getByRole("button", { name: "患者検索（/）" }).isVisible(), true, `search icon is visible at ${width}px`);
    assert.equal(await page.locator(".eh-menu-button").isVisible(), width < 768, `menu button visibility at ${width}px`);
    if (width < 768) {
      // メニューに同じ行き先が並び、現在地が分かる
      await page.locator(".eh-menu-button").click();
      const menu = page.getByRole("navigation", { name: "メイン（メニュー）" });
      for (const name of [/^受付画面/u, /^患者リスト/u, /^会計連携/u]) await menu.getByRole("link", { name }).waitFor();
      assert.equal(await menu.getByRole("link", { name: /^患者リスト/u }).getAttribute("aria-current"), "page");
      await page.locator(".eh-menu").getByRole("link", { name: "施設管理" }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the open menu does not scroll sideways");
      await page.locator(".eh-menu-button").click();
    }
  }
  await page.setViewportSize(original);
}

// 共通の位置合わせ（components/popover-placement.js）と、ダイアログの高さの上限:
// 操作帯の「…」・印刷のメニューが画面の左右にはみ出さない。横向きスマホの高さでも、ダイアログは画面に収まり、
// 下のボタンまでスクロールで届く。
async function assertEditorPopoversFit(page) {
  const original = page.viewportSize();
  const insideViewport = async (selector, label) => {
    const box = await page.locator(selector).boundingBox();
    const view = page.viewportSize();
    assert.ok(box && box.x >= 0 && box.x + box.width <= view.width + 1 && box.y >= 0 && box.y + box.height <= view.height + 1, `${label} fits in ${view.width}x${view.height}: ${JSON.stringify(box)}`);
  };
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator(".actionbar-more > summary").click();
  await insideViewport(".actionbar-more > .more-menu-list", "the action bar … menu");
  await page.locator(".actionbar-more > summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".actionbar-print > summary").click();
  await insideViewport(".actionbar-print > .more-menu-list", "the print menu");
  await page.locator(".actionbar-print > summary").click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator(".chart-head").click();
  await page.keyboard.press("Shift+Slash");
  const dialog = page.getByRole("dialog", { name: "ショートカット" });
  await dialog.waitFor();
  await insideViewport(".dialog-backdrop > .dialog", "the shortcut dialog");
  const close = dialog.getByRole("button", { name: "閉じる" });
  await close.scrollIntoViewIfNeeded();
  await insideViewport(".dialog-backdrop .dialog-actions", "the dialog buttons");
  await close.click();
  await page.setViewportSize(original);
}

// ヘッダーの虫めがねで患者検索のモーダルを開き、語を入れる
async function searchPatient(page, query) {
  await page.getByRole("button", { name: "患者検索（/）" }).click();
  const dialog = page.getByRole("dialog", { name: "患者検索" });
  await dialog.getByLabel("検索する語").fill(query);
  return dialog;
}

// 患者検索のモーダルで探して、その行の［表示］で患者のカルテを開く
async function openPatientFromSearch(page, query, name) {
  const dialog = await searchPatient(page, query);
  await dialog.locator(".ps-row").filter({ hasText: name }).getByRole("button", { name: "表示", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

// 画面の中から eye-api を呼ぶ（ログインの Cookie と CSRF をそのまま使う）。検査値は検査ページの担当なので、カルテの確認用に記録を直接入れる。
async function addExamRecord(page, encounterId, values) {
  return page.evaluate(async ({ encounterId, values }) => {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )halunasu_csrf=([^;]*)/u) || [])[1] || "");
    const call = async (method, path, body) => {
      const response = await fetch(`/api/eye${path}`, { method, credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${JSON.stringify(payload).slice(0, 200)}`);
      return payload;
    };
    const current = await call("GET", `/v1/eye/encounters/${encounterId}`);
    return call("POST", `/v1/eye/encounters/${encounterId}/exam-records`, { expectedRevision: current.encounter.revision, values });
  }, { encounterId, values });
}

async function drawStroke(page) {
  const canvas = page.locator(".sketch-dialog .sketch-canvas").first();
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
  await page.locator(".sketch-dialog .sketch-canvas polyline").first().waitFor();
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

// ---- 受付まわりのレスポンシブ（領域 A）----
// 受付一覧の固定列・スマホのカード、絞り込みの［閉じる］、予約状況のダイアログ、患者検索のモーダルの位置を確かめる。
// 受付の流れ（runReceptionFlow）で作った当日の受付を使う。
async function runReceptionResponsiveChecks(browser) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const inside = async (locator, label) => {
    const box = await locator.boundingBox();
    const view = page.viewportSize();
    assert.ok(box && box.x >= -1 && box.x + box.width <= view.width + 1 && box.y >= -1 && box.y + box.height <= view.height + 1, `${label} fits in ${view.width}x${view.height}: ${JSON.stringify(box)}`);
    return box;
  };
  await login(page, "clerk");
  // 二段階認証の確認が済んでヘッダーが出るまで待ってから移る（すぐに移るとログイン画面に戻ることがある）
  await page.locator("header.eh").waitFor();
  await page.goto(`${baseUrl}/reception`);
  const table = page.getByRole("table", { name: "受付一覧" });
  const firstRow = page.locator(".rc-row").first();
  await firstRow.waitFor();

  // 1024: 診療科・医師・患者メモの列は既定で隠れ、行の［予約］［…］は右端に固定されて画面の中にある
  assert.equal(await table.locator("th.rc-col-doctor").count(), 0, "the doctor column is hidden by default below 1366px");
  await inside(firstRow.locator(".rc-col-actions summary"), "the row … button");
  // 横にスクロールしても氏名の列は左に残る
  await page.locator(".rc-table-wrap").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const wrapBox = await page.locator(".rc-table-wrap").boundingBox();
  const nameBox = await firstRow.locator("td.rc-col-name").boundingBox();
  assert.ok(nameBox.x >= wrapBox.x - 1 && nameBox.x + nameBox.width <= wrapBox.x + wrapBox.width, `the name column stays visible while scrolled: ${JSON.stringify(nameBox)}`);

  // 絞り込み: 1100px 以下は背景を暗くし、［閉じる］は見出しの行（画面の中）にある
  await page.getByRole("button", { name: "▼ 絞り込み" }).click();
  const filter = page.getByRole("dialog", { name: "絞り込み" });
  await page.locator(".rc-filter-backdrop").waitFor();
  await inside(filter.getByRole("button", { name: "閉じる" }), "the filter close button");
  await filter.getByRole("button", { name: "閉じる" }).click();
  await filter.waitFor({ state: "detached" });

  // 横向きスマホの高さ: 予約状況はダイアログの中身と入れ替わり、週の表が画面の中でスクロールする
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "予約を追加" }).click();
  const booking = page.getByRole("dialog", { name: "予約登録" });
  await booking.getByRole("button", { name: "予約状況" }).click();
  const grid = booking.locator(".bk-grid-scroll");
  const gridBox = await inside(grid, "the week grid");
  assert.ok(gridBox.height >= 120, `the week grid has room: ${gridBox.height}px`);
  await inside(booking, "the booking dialog");
  await booking.getByRole("button", { name: "閉じる" }).click();
  await inside(booking.getByRole("button", { name: "キャンセル" }), "the booking dialog buttons");
  await booking.getByRole("button", { name: "キャンセル" }).click();

  // スマホ縦: 受付一覧はカードになり、ページは横にはみ出さない。行の「…」メニューも画面の中
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.localStorage.removeItem("halunasu-eye-reception-columns"));
  await page.reload();
  await firstRow.waitFor();
  assert.equal(await firstRow.evaluate((element) => getComputedStyle(element).display), "flex", "reception rows are cards on phones");
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), "no horizontal page scroll on phones");
  await page.getByLabel("並べ替え").waitFor();
  await firstRow.locator(".rc-col-actions summary").click();
  await inside(firstRow.locator(".more-menu-list"), "the row menu on a phone");
  await firstRow.locator(".rc-col-actions summary").click();

  // 患者検索のモーダル: 上に寄せて出し、結果の件数が変わっても入力欄の位置は変わらない
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: "患者検索（/）" }).click();
  const search = page.getByRole("dialog", { name: "患者検索" });
  const input = search.getByLabel("検索する語");
  await search.locator(".ps-row").first().waitFor();
  const before = await input.boundingBox();
  await input.fill("試験");
  await search.locator(".ps-caption").filter({ hasText: /\d+件/u }).waitFor();
  const after = await input.boundingBox();
  assert.ok(Math.abs(after.y - before.y) <= 1, `the search input does not jump: ${before.y} -> ${after.y}`);
  await page.keyboard.press("Escape");

  assert.deepEqual(pageErrors, []);
  await context.close();
}

// ---- カルテ編集のレスポンシブ（docs/eye-ux/responsive-issues-20261110.md の B） ----
// スマホ縦: 患者の帯は 2 段・操作帯は 1 段、帯から開く編集ダイアログはヘッダーより手前。
// スマホ横（高さ 390）: 3 ペインにせず、左右とも引き出し・ページ全体のスクロールになる。
// 1024px: 用法のメニューの回数のチップ（1回〜6回）が縦 1 列にならない。
async function assertEditorResponsiveB(page) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const phone = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    banner: document.querySelector(".chart-topbar").getBoundingClientRect().height,
    bar: document.querySelector(".chart-actionbar").getBoundingClientRect().height
  }));
  assert.ok(phone.overflow <= 1, `the chart does not scroll sideways at 390px: ${JSON.stringify(phone)}`);
  assert.ok(phone.banner <= 120, `the patient banner is 2 rows at 390px: ${JSON.stringify(phone)}`);
  assert.ok(phone.bar <= 72, `the action bar is 1 row at 390px: ${JSON.stringify(phone)}`);
  await page.locator(".chart-topbar").getByRole("button", { name: "アレルギー・病名" }).click();
  const profile = page.getByRole("dialog", { name: "アレルギー・病名・既往" });
  await profile.waitFor();
  const front = await page.evaluate(() => {
    const dialog = document.querySelector("[aria-labelledby='profile-heading']");
    const heading = dialog.querySelector("h2").getBoundingClientRect();
    const hit = document.elementFromPoint(heading.left + 8, heading.top + heading.height / 2);
    return { inBody: dialog.parentElement.parentElement === document.body, onTop: Boolean(hit && dialog.contains(hit)) };
  });
  assert.ok(front.inBody && front.onTop, `the banner profile dialog is drawn above the header: ${JSON.stringify(front)}`);
  await profile.getByRole("button", { name: "キャンセル" }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  await page.locator(".encounter-actions").getByRole("button", { name: "患者の情報", exact: true }).waitFor();
  const landscape = await page.evaluate(() => ({
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 100,
    rightFixed: getComputedStyle(document.querySelector(".chart-right")).position === "fixed",
    leftFixed: getComputedStyle(document.querySelector(".chart-left")).position === "fixed"
  }));
  assert.ok(landscape.pageScrolls && landscape.rightFixed && landscape.leftFixed, `844x390 uses the phone layout (page scroll, both drawers): ${JSON.stringify(landscape)}`);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(300);
  const usage = page.locator(".rp-group.is-rx summary[aria-label='用法']").first();
  if (await usage.count()) {
    await usage.scrollIntoViewIfNeeded();
    await usage.click();
    const rows = await page.locator(".usage-menu[open] .usage-times .btn").evaluateAll((buttons) => new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size);
    assert.ok(rows <= 2, `the usage times chips sit in a row (rows: ${rows})`);
    await usage.click();
  }
  await page.setViewportSize(original);
}
