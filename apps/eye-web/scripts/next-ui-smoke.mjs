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
  await page.getByRole("heading", { name: "診察", exact: true }).waitFor();
  assert.equal(await page.locator(".eye-nav-link[aria-current=page]").innerText(), "診察");
  await assertNavFits(page);

  // 患者検索: ひらがな・名だけ・生年月日（和暦）で当たり、結果に生年月日が出る
  for (const query of ["みほん", "ハナコ", "S31.3.12", "1956/3/12"]) {
    await page.getByLabel("患者検索").fill(query);
    await page.locator(".patient-row").filter({ hasText: "見本 花子" }).filter({ hasText: "S31.3.12" }).waitFor();
  }
  // 日本語入力の変換確定の Enter では患者を開かない
  await page.getByLabel("患者検索").dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true });
  await page.waitForTimeout(300);
  assert.equal(new URL(page.url()).pathname, "/", "an IME Enter must not open a patient");

  // 暗室表示は利用者メニューの中。切り替えは端末に保存される
  await page.locator(".nav-user-button").click();
  await page.getByRole("button", { name: /暗室表示/u }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await page.evaluate(() => window.localStorage.getItem("halunasu-eye-dark")), "1");
  await page.getByRole("button", { name: /暗室表示/u }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.locator(".nav-user-button").click();

  await page.getByLabel("患者検索").fill("見本");
  await page.locator(".patient-row").filter({ hasText: "見本 花子" }).click();
  await page.getByRole("button", { name: "初診カルテを作成" }).click();
  await page.getByRole("heading", { name: "検査", exact: true }).waitFor();
  // 診療日・区分は小さなボタンの中
  await page.locator(".visit-meta > summary").click();
  await page.getByLabel("診療日", { exact: true }).fill("2026-07-28");
  await page.locator(".visit-meta > summary").click();
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
  // 空の欄は「＋」チップに畳まれている。開いたら、中身を消しても閉じない
  await page.getByRole("button", { name: "＋ スタッフメモ" }).click();
  await page.getByRole("textbox", { name: "スタッフメモ" }).fill("メモ");
  await page.getByRole("textbox", { name: "スタッフメモ" }).fill("");
  await page.locator("#sec-staff-note").waitFor();
  await page.getByRole("button", { name: "＋ シェーマ" }).click();
  await page.getByRole("button", { name: "シェーマを追加" }).click();
  await drawStroke(page);
  // SOAP の目印は見出しの名前に含めない（読み上げ・見出しの検索は従来どおり）
  await page.getByRole("heading", { name: "所見", exact: true }).waitFor();
  assert.equal(await page.locator("#findings-heading .soap-mark").innerText(), "O");
  // 既往・全身疾患・内服はカルテの主訴の上に 1 行で出し、同じ編集ダイアログで直す
  await page.locator(".history-line-bar").getByText(/未記入/u).waitFor();
  await page.getByRole("button", { name: "既往・内服を編集" }).click();
  await page.getByRole("dialog").getByLabel("全身既往・内服").fill("糖尿病\nワーファリン内服");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await page.locator(".history-line-bar").getByText("糖尿病、ワーファリン内服").waitFor();
  // 検査の追加項目（詳細の中）。Enter は右眼の項目 → 左眼の項目の順（主の検査表とは別の並び）
  await page.getByRole("button", { name: /瞳孔・眼位など/u }).click();
  await page.getByLabel("右眼 瞳孔径").fill("3");
  await page.getByLabel("右眼 瞳孔径").press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "右眼 角膜曲率 K1");
  await page.keyboard.type("43.25");
  await page.keyboard.press("Enter");
  await page.keyboard.type("44");
  await page.keyboard.press("Enter");
  await page.keyboard.type("175");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "左眼 近見視力");
  await page.getByLabel("右眼 対光反射").selectOption("brisk");
  await page.getByLabel("RAPD", { exact: true }).selectOption("none");
  await page.getByLabel("眼位", { exact: true }).selectOption("exo");
  await page.getByLabel("眼位のメモ").fill("10Δ");
  // 所見の追加の欄（空なら＋チップ）。「空欄を異常なし」は追加の欄を埋めない
  await page.getByRole("button", { name: "＋ C/D 比" }).click();
  await page.getByLabel("右眼 C/D 比").fill("0.7");
  await page.getByRole("button", { name: "＋ その他" }).click();
  await page.getByLabel("右眼 その他", { exact: true }).fill("眼瞼腫脹なし");
  await page.getByRole("button", { name: "＋ 両眼・全体" }).click();
  await page.getByRole("textbox", { name: "両眼・全体" }).fill("全身状態良好");
  await page.getByRole("button", { name: "空欄を異常なし", exact: true }).click();
  assert.equal(await page.getByLabel("左眼 前眼部").inputValue(), "異常なし");
  assert.equal(await page.getByLabel("左眼 その他", { exact: true }).inputValue(), "", "normal-fill must not touch the added findings");
  assert.equal(await page.getByLabel("左眼 C/D 比").inputValue(), "");
  // 説明・同意（P）と点眼アドヒアランス（処方の下）
  await page.getByRole("button", { name: "＋ 説明・同意" }).click();
  await page.getByRole("button", { name: "散瞳後の注意" }).click();
  await page.getByLabel("同意", { exact: true }).selectOption("not_required");
  await page.getByRole("group", { name: "点眼アドヒアランス" }).getByRole("button", { name: "時々忘れる" }).click();
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "右眼を確認" }).click();
  await page.getByRole("button", { name: "左眼を確認" }).click();
  await page.locator(".exam-confirmed").nth(1).waitFor();
  await page.getByRole("button", { name: "確定する" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "確定する" }).click();
  await page.getByText("確定 v1").first().waitFor();
  // 印刷: 追加の項目は入力があるときだけ行を出す
  const firstPrint = await context.newPage();
  await firstPrint.goto(`${page.url()}/print`);
  const firstSheet = await firstPrint.locator(".chart-sheet").innerText();
  for (const text of ["3mm 対光反射 迅速", "K1 43.25D K2 44.00D Ax175°", "RAPD", "外斜位 10Δ", "C/D 比", "0.7", "眼瞼腫脹なし", "全身状態良好", "散瞳後の注意 同意不要", "時々忘れる"]) {
    assert.ok(firstSheet.includes(text), `the chart print shows ${text}`);
  }
  assert.equal(firstSheet.includes("眼球運動"), false, "empty added rows are not printed");
  await firstPrint.close();

  await page.getByRole("link", { name: /カルテ一覧/ }).click();
  await page.getByRole("button", { name: /本日のカルテを作成/ }).click();
  await page.getByRole("tab", { name: /^過去/u }).waitFor();
  await page.locator(".history-card").first().waitFor();
  assert.equal(await page.getByLabel("右眼 眼圧", { exact: true }).inputValue(), "", "measurements must not be copied");
  // 前回コピー: 所見の自由記載は写し、C/D 比は写さず前回値をヒントに出す。説明・同意も写さない
  assert.equal(await page.getByLabel("右眼 その他", { exact: true }).inputValue(), "眼瞼腫脹なし");
  assert.equal(await page.getByLabel("右眼 C/D 比").inputValue(), "", "C/D is re-measured");
  await page.locator(".findings-hint").filter({ hasText: "前回 0.7" }).waitFor();
  await page.getByRole("button", { name: "＋ 説明・同意" }).waitFor();
  // 処方は 1 剤 1 行で表示する。押すと編集欄が開くが、開いただけでは引き継ぎの確認状態は変わらない
  assert.match(await page.locator(".rx-line").first().innerText(), /ラタノプロスト点眼液0\.005%/u);
  await page.locator(".rx-row.is-carried .rx-line").first().click();
  assert.equal(await page.getByRole("combobox", { name: "薬剤名", exact: true }).inputValue(), "ラタノプロスト点眼液0.005%");
  assert.equal(await page.locator(".rx-row.is-carried").count(), 1, "opening a carried-over prescription must not confirm it");
  await page.locator(".rx-edit").getByRole("button", { name: "閉じる" }).click();
  assert.equal(await page.locator(".rx-edit").count(), 0);
  // Enter で 右眼 矯正視力 → 右眼 眼圧 → 左眼 裸眼視力 と進む
  await page.getByLabel("右眼 矯正視力").fill("0.8");
  await page.getByLabel("右眼 矯正視力").press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "右眼 眼圧");
  await page.keyboard.type("23");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "左眼 裸眼視力");
  await page.locator('input[aria-label="右眼 眼圧"].is-high').waitFor();
  // 他覚屈折は「詳細」の中。マイナスを打った途中の状態が消えず、表示は符号付き小数 2 桁になる
  await page.getByRole("button", { name: /他覚屈折・矯正の種類・眼圧の時刻/u }).click();
  assert.equal(await page.getByLabel("右眼 瞳孔径").inputValue(), "", "pupils are not copied");
  // 眼圧を初めて入れた眼には、測定時刻（日本時間）が自動で入る。眼圧のない眼は空のまま
  assert.match(await page.getByLabel("右眼 眼圧の測定時刻", { exact: true }).inputValue(), /^\d{2}:\d{2}$/u, "IOP time is filled when the first IOP is entered");
  assert.equal(await page.getByLabel("左眼 眼圧の測定時刻", { exact: true }).inputValue(), "");
  const sphere = page.getByLabel("右眼 屈折 球面");
  await sphere.click();
  await page.keyboard.type("-");
  assert.equal(await sphere.inputValue(), "-", "a lone minus sign must stay while typing");
  await page.keyboard.type("1.25");
  await page.keyboard.press("Tab");
  assert.equal(await sphere.inputValue(), "-1.25");
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  // 値のある「詳細」は開き直しても畳まれない
  await page.reload();
  assert.equal(await page.getByLabel("右眼 屈折 球面").inputValue(), "-1.25");
  // 確定前の確認は「確定する」ボタンの件数と説明にまとめる
  await page.locator(".finalize-button .finalize-count").waitFor();
  assert.match(await page.locator(".finalize-button").getAttribute("title"), /右眼の検査値が未確認です。/u);
  await page.getByRole("button", { name: "右眼を確認" }).click();
  assert.equal(await page.getByRole("button", { name: "左眼を確認" }).count(), 0, "an eye without values needs no confirmation");
  await page.waitForFunction(() => !document.querySelector(".finalize-button")?.title.includes("右眼の検査値が未確認です。"));
  // 前回から引き継いだ処方は、確定ダイアログで内容を見てから確定する
  await page.locator(".rx-row.is-carried .rx-carried-tag").waitFor();
  assert.match(await page.locator(".finalize-button").getAttribute("title"), /前回から引き継いだ処方 1件が未確認です。/u);
  await page.getByRole("tab", { name: /^変更点/u }).click();
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
  await printPage.getByRole("button", { name: "印刷", exact: true }).waitFor();
  assert.equal(await printPage.locator(".print-sketches polyline").count() > 0, true, "copied sketch strokes are printed");
  assert.equal(await printPage.locator(".print-watermark").count(), 0, "a finalized chart prints without the draft watermark");
  assert.match(await printPage.locator(".cs-table").innerText(), /0\.8/u);
  await printPage.getByRole("link", { name: "← カルテに戻る" }).waitFor();
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

  // 印刷用の氏名: 未設定なら表示名から役割の（ ）を除いた名前、設定すると処方箋・カルテの印刷に出る
  const finalizedOptical = await context.newPage();
  await finalizedOptical.goto(`${encounterUrl}/optical`);
  await finalizedOptical.locator(".rx-sign-name").waitFor();
  assert.equal((await finalizedOptical.locator(".rx-sign-name").innerText()).replace("印", "").trim(), "院長", "the role in parentheses is not printed");
  assert.match(await finalizedOptical.locator(".rx-no").innerText(), /No\. \d{8}-[0-9A-F]{6}-1/u, "the prescription number comes from the encounter and version");
  await page.locator(".settings-nav-item", { hasText: "印刷用の氏名" }).click();
  await page.waitForURL(/#staff$/u);
  await page.locator(".master-row").filter({ hasText: "院長" }).first().click();
  const staffPanel = page.getByRole("complementary", { name: "印刷用の氏名の編集" });
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
  await page.getByRole("tab", { name: "セット" }).click();
  await page.getByRole("button", { name: /緑内障 定期/ }).click();
  await page.getByText("セット「緑内障 定期」を追加しました。").waitFor();
  await page.locator(".order-row").first().waitFor();
  await page.locator(".phrase-row").getByRole("button", { name: "挿入" }).click();
  assert.match(await page.getByRole("textbox", { name: "方針", exact: true }).inputValue(), /点眼継続。\n次回同様。/u);
  // 眼鏡処方（空の欄は「＋」チップから開く）
  await page.getByRole("button", { name: "＋ 眼鏡・CL" }).click();
  await page.getByLabel("眼鏡・CL の種類").selectOption("glasses");
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
  assert.equal(await page.locator("#optical-heading ~ div .readiness .is-blocker").count(), 0);
  await page.locator(".rx-line").first().click();
  await page.getByRole("button", { name: "左右に分ける" }).first().click();
  assert.deepEqual(await page.getByRole("combobox", { name: "処方の眼" }).evaluateAll((items) => items.map((item) => item.value)).then((values) => values.slice(0, 2)), ["od", "os"]);
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

  // 紹介状を作成・確定・印刷
  // 文書・確定履歴は「…」メニューから右の引き出しで開く
  await page.locator('.encounter-actions summary[aria-label="その他の操作"]').click();
  await page.getByRole("button", { name: "文書", exact: true }).click();
  await page.getByRole("button", { name: "紹介状を作成" }).click();
  await page.getByRole("heading", { name: /診療情報提供書/ }).waitFor();
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
  // 共通の登録ダイアログ: フリガナは必須で、ひらがなはカタカナにそろえる
  const registerDialog = page.getByRole("dialog", { name: /患者登録/u });
  assert.equal(await registerDialog.getByRole("button", { name: "登録して受付に紐づける" }).isDisabled(), true, "kana is required");
  await registerDialog.getByLabel("フリガナ").fill("とびこみ はなこ");
  await registerDialog.getByLabel("フリガナ").blur();
  assert.equal(await registerDialog.getByLabel("フリガナ").inputValue(), "トビコミ ハナコ");
  await registerDialog.getByText("保険証・資格確認はレセコンで登録します。").waitFor();
  await registerDialog.getByRole("button", { name: "登録して受付に紐づける" }).click();
  await walkIn.getByText("未登録").waitFor({ state: "detached" });

  // ヘッダー検索から新規登録: 入力した語が登録欄に入り、似た患者があれば警告が出る
  await page.getByLabel("患者検索").fill("しけん");
  await page.locator(".patient-row").filter({ hasText: "試験 一郎" }).waitFor();
  await page.getByRole("button", { name: /「しけん」で新規患者を登録/u }).click();
  const headerDialog = page.getByRole("dialog", { name: "新規患者を登録" });
  assert.equal(await headerDialog.getByLabel("フリガナ").inputValue(), "シケン");
  await headerDialog.getByText("似た患者がいます").waitFor();
  await headerDialog.locator(".register-similar").getByText("試験 一郎").waitFor();
  await page.keyboard.press("Escape");
  await headerDialog.waitFor({ state: "detached" });

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

  // ログアウトは利用者メニューの中。病院コードは端末に覚え、次回は入力を省く
  await page.locator(".nav-user-button").click();
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
  await page.getByRole("heading", { name: "診察", exact: true }).waitFor();
  const waitingRow = page.locator(".flow-group.status-waiting_doctor .flow-row").filter({ hasText: "試験 一郎" });
  await waitingRow.waitFor();
  await waitingRow.getByRole("button", { name: "診察開始" }).waitFor();
  assert.equal((await page.locator(".nav-menu-button .nav-badge").innerText()).trim(), "1");
  await page.getByRole("button", { name: /^未確定カルテ/u }).click();
  await page.getByRole("region", { name: "未確定カルテ" }).waitFor();
  await page.getByRole("button", { name: /^すべて/u }).click();
  await page.getByLabel("患者検索").fill("試験");
  await page.locator(".patient-row").filter({ hasText: "試験 一郎" }).click();
  await page.getByRole("button", { name: "初診カルテを作成" }).click();
  await page.getByRole("heading", { name: "検査", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "確定する" }).count(), 0, "orthoptists cannot finalize");
  await page.getByText("確定は医師が行います").waitFor();
  const encounterUrl = page.url();

  // 当日受付（受付済）を 1 件作り、検査ページの「検査終了 → 診察待ちへ」で進める
  await page.goto(`${baseUrl}/reception`);
  await page.getByRole("button", { name: "当日受付" }).click();
  await page.getByLabel("患者を検索").fill("試験");
  await page.getByRole("dialog").getByRole("button", { name: /試験 一郎/u }).click();
  await page.getByRole("button", { name: "受け付ける" }).click();
  await page.locator(".flow-group.status-checked_in .flow-row").filter({ hasText: "試験 一郎" }).waitFor();

  // 検査ページ: 検査の順の表、前回列、本日の検査、散瞳、申し送り、下の固定ボタン
  await page.goto(`${encounterUrl}/exam`);
  await page.getByRole("heading", { name: "検査値" }).waitFor();
  const labels = await page.locator(".xt-grid.is-workbench .xt-label").allInnerTexts();
  assert.deepEqual(labels, ["他覚屈折", "裸眼視力", "矯正視力", "眼圧"], "rows follow the exam order");
  // Enter は右眼の全項目 → 左眼の順（屈折 S → C → Ax も進む）
  await page.getByLabel("右眼 屈折 球面").click();
  await page.keyboard.type("-");
  assert.equal(await page.getByLabel("右眼 屈折 球面").inputValue(), "-", "a lone minus sign must stay while typing");
  await page.keyboard.type("2.5");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "右眼 屈折 円柱");
  assert.equal(await page.getByLabel("右眼 屈折 球面").inputValue(), "-2.50");
  await page.keyboard.type("-0.75");
  await page.keyboard.press("Enter");
  await page.keyboard.type("180");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "右眼 裸眼視力");
  // 他覚屈折を矯正レンズの空欄へ写す
  await page.getByRole("button", { name: "右眼 他覚屈折を矯正レンズへ写す" }).click();
  assert.equal(await page.getByLabel("右眼 矯正 球面").inputValue(), "-2.50");
  assert.equal(await page.getByLabel("右眼 矯正 軸").inputValue(), "180");
  await page.getByLabel("右眼 矯正視力").fill("0.7");
  await page.getByLabel("右眼 眼圧の測定時刻", { exact: true }).fill("09:05");
  await page.getByLabel("右眼 眼圧", { exact: true }).fill("14");
  await page.getByLabel("右眼 眼圧", { exact: true }).press("Tab");
  assert.equal(await page.getByLabel("右眼 眼圧の測定時刻", { exact: true }).inputValue(), "09:05", "an entered IOP time is never overwritten");
  // 視力の候補に「矯正不能（n.c.）」がある
  assert.equal(await page.locator('#va-values option[value="n.c."]').count(), 1);

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
  await page.locator(".flow-group.status-waiting_doctor .flow-row").filter({ hasText: "試験 一郎" }).first().waitFor();
  assert.equal(await page.locator(".flow-group.status-checked_in .flow-row").filter({ hasText: "試験 一郎" }).count(), 0);
  await page.goto(`${encounterUrl}/exam`);
  await page.locator(".exam-bar-eye.is-done").filter({ hasText: "R" }).waitFor();
  assert.equal(await page.locator(".exam-bar-eye.is-empty").filter({ hasText: "L" }).count(), 1, "an eye without values is not confirmed");
  // 該当する受付がなければ、確認だけにして受付は動かさない
  await page.getByRole("button", { name: "検査値を確認する" }).waitFor();
  // 管理者でない人は設定を見るだけ（追加・保存はできず、管理の項目は出ない）
  await page.goto(`${baseUrl}/settings#audit`);
  await page.getByRole("heading", { name: /よく使う薬剤/u }).waitFor();
  assert.equal(await page.getByRole("button", { name: "＋ 薬剤を追加" }).count(), 0);
  assert.equal(await page.locator(".settings-nav-item", { hasText: "操作記録" }).count(), 0);
  await page.locator(".master-row").first().click();
  await page.getByRole("complementary", { name: "薬剤の編集" }).getByText("変更は管理者が行います。").waitFor();
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0);
  assert.deepEqual(pageErrors, []);
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

// 768〜1180px でヘッダーの項目が検索欄の下に隠れないこと（各リンクが検索欄と重ならない）
async function assertNavFits(page) {
  const original = page.viewportSize();
  for (const width of [900, 1024, 1180, 1280]) {
    await page.setViewportSize({ width, height: original.height });
    const search = await page.locator(".nav-search").boundingBox();
    for (const link of await page.locator(".eye-nav-link").all()) {
      const box = await link.boundingBox();
      assert.ok(box && box.x + box.width <= search.x, `nav link overlaps the search at ${width}px`);
    }
  }
  await page.setViewportSize(original);
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
