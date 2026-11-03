// UI 監査。デモデータ入りのローカル環境（メモリストア）と Next 開発サーバーを起動し、
// 主要画面を 5 つの画面幅で撮影して、文字サイズ・コントラスト・タップ領域・横あふれを計測する。
// 診察（/）関連: home（診察）・home-tasks（要対応の一覧）・home-dark・search（検索）・register（新規患者登録）・menu
//
//   node scripts/ui-audit.mjs [--out DIR] [--pages editor,reception]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(root, "../..");
const { LOCAL_ORGANIZATION_CODE, LOCAL_PASSWORD, currentLocalTotp, startLocalEyeStack } = await import(resolve(repositoryRoot, "scripts/dev_eye_stack.mjs"));
const metricsScript = readFileSync(join(root, "scripts/ui-audit-metrics.js"), "utf8");

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.get("out") || join(tmpdir(), "eye-ui-audit"));
const onlyPages = args.get("pages") ? new Set(args.get("pages").split(",")) : null;
const VIEWPORTS = [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]];
mkdirSync(outDir, { recursive: true });

const [platformPort, eyePort, webPort] = await Promise.all([findOpenPort(), findOpenPort(), findOpenPort()]);
const stack = await startLocalEyeStack({ platformPort, eyePort, demo: true });
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

const results = {};
try {
  await waitForHttp(baseUrl, 60_000);
  const browser = await launchBrowser();
  try {
    const { storageState, paths } = await prepare(browser);
    const pages = Object.entries(paths).filter(([name]) => !onlyPages || onlyPages.has(name.replace(/-dark$/u, "")));
    for (const [name, path] of pages) {
      for (const [width, height] of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width, height }, ...(name === "login" ? {} : { storageState }) });
        const dark = name.endsWith("-dark");
        await context.addInitScript((value) => { try { window.localStorage.setItem("halunasu-eye-dark", value); } catch {} }, dark ? "1" : "0");
        const page = await context.newPage();
        const errors = [];
        page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 300)); });
        page.on("pageerror", (error) => errors.push(`PAGEERROR ${error.message.slice(0, 200)}`));
        await page.goto(baseUrl + path, { waitUntil: "networkidle" }).catch(() => null);
        await page.waitForTimeout(name === "login" ? 1500 : 2500);
        await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
        // 899px 以下は「メニュー」、それより広い画面は利用者メニュー（暗室表示・ログアウト）を開いて撮る
        if (name === "menu") await (width < 900 ? page.getByRole("button", { name: "メニュー" }) : page.locator(".nav-user-button")).click();
        if (name === "search" || name === "register") {
          await page.getByLabel("患者検索").fill(name === "register" ? "もぎ" : "模");
          await page.waitForTimeout(800);
        }
        if (name === "register") {
          await page.getByRole("button", { name: /新規患者を登録/u }).click();
          await page.waitForTimeout(800);
        }
        if (name === "home-tasks") {
          await page.getByRole("button", { name: /^未確定カルテ/u }).click();
          await page.waitForTimeout(500);
        }
        if (name === "editor-history" && width < 1280) await page.getByRole("button", { name: /^過去カルテ/u }).click();
        if (name === "editor-side" && width < 1024) await page.getByRole("button", { name: /^確認・比較/u }).click();
        if (name.startsWith("editor-") && !name.endsWith("dark")) await page.waitForTimeout(400);
        if (name === "billing-diff") {
          await page.getByRole("button", { name: "差分を見る" }).first().click();
          await page.locator(".bill-status-pending .flow-row-open").first().click();
          await page.waitForTimeout(300);
        }
        if (name === "billing-print") {
          // 印刷ダイアログは開かず、印刷する連絡票の写しを残してから印刷の表示で撮る
          await page.evaluate(() => {
            window.print = () => {
              const copy = document.querySelector(".bill-slips")?.cloneNode(true);
              if (copy) document.body.appendChild(copy);
            };
          });
          await page.locator("summary[aria-label='会計連携のその他の操作']").click();
          await page.getByRole("button", { name: "この日の全員の連絡票を印刷" }).click();
          await page.waitForTimeout(800);
          await page.emulateMedia({ media: "print" });
        }
        // 設定: 一覧の行を押して右の編集パネルを開いた状態も撮る
        if (name.startsWith("settings-panel") || name === "settings-sets") {
          await page.locator(".master-row").nth(name === "settings-sets" ? 0 : 1).click().catch(() => null);
          await page.waitForTimeout(400);
        }
        const tag = `${name}-${width}x${height}`;
        await page.screenshot({ path: join(outDir, `${tag}.png`) });
        await page.screenshot({ path: join(outDir, `${tag}-full.png`), fullPage: true });
        const metrics = await page.evaluate(metricsScript);
        metrics.errors = errors;
        results[tag] = metrics;
        await context.close();
      }
    }
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

writeFileSync(join(outDir, "metrics.json"), JSON.stringify(results, null, 1));
printSummary(results);
console.log(`\nScreenshots and metrics.json: ${outDir}`);

// ログインし、撮影対象のカルテ・患者・文書を用意する（デモの ID は起動ごとに変わる）。
async function prepare(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.getByLabel("病院コード").fill(LOCAL_ORGANIZATION_CODE);
  await page.getByLabel("個人ID").fill("director");
  await page.getByLabel("ログイン用パスワード", { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.getByLabel("6桁コード").fill(currentLocalTotp());
  await page.getByRole("button", { name: "確認" }).click();
  await page.getByRole("link", { name: "受付", exact: true }).click();
  // 過去カルテのあるデモ患者で撮る。未受付なら受付してからカルテを開く。
  const row = page.locator(".flow-row", { hasText: "模擬 和子" });
  await page.locator(".flow-list").waitFor();
  await page.locator(".flow-more").click().catch(() => null);
  if (await row.getByRole("button", { name: "受付する" }).count()) {
    await row.getByRole("button", { name: "受付する" }).click();
    // 受付の反映を待ってからメニューを開く（反映前に開くと「カルテ作成」がまだない）
    await row.getByRole("button", { name: "受付する" }).waitFor({ state: "detached" });
    // 再読み込みが終わってから「…」を開く（古い行のメニューにはカルテの項目がない）
    await page.locator(".flow-group.status-checked_in .flow-row", { hasText: "模擬 和子" }).waitFor();
  }
  await row.locator("summary").click();
  await row.getByRole("button", { name: /カルテを開く|カルテ作成/u }).click();
  await page.waitForURL(/\/encounters\//u);
  const encounterPath = new URL(page.url()).pathname;
  await page.getByLabel("右眼 裸眼視力").waitFor();
  await page.getByRole("textbox", { name: "主訴", exact: true }).fill("術後定期検査。右眼のかすみは改善。");
  await page.getByLabel("右眼 裸眼視力").fill("0.9");
  await page.getByLabel("左眼 裸眼視力").fill("0.3");
  await page.getByLabel("右眼 矯正視力").fill("1.2");
  await page.getByLabel("左眼 矯正視力").fill("0.6");
  await page.getByLabel("右眼 眼圧", { exact: true }).fill("14");
  await page.getByLabel("左眼 眼圧", { exact: true }).fill("23");
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  const patientHref = await page.locator('a[href^="/patients/"]').first().getAttribute("href");
  await page.getByRole("tab", { name: "文書", exact: true }).click();
  await page.getByRole("button", { name: "紹介状を作成" }).click();
  await page.waitForURL(/\/documents\//u);
  const documentPath = new URL(page.url()).pathname;
  await page.getByLabel("宛先 医療機関").fill("県立中央病院");
  await page.waitForTimeout(2500);
  if (!onlyPages || [...onlyPages].some((name) => name.startsWith("billing"))) await seedBilling(page);
  if (!onlyPages || onlyPages.has("patient") || onlyPages.has("images")) await uploadSampleImages(page, patientHref);
  const storageState = await context.storageState();
  await context.close();
  return {
    storageState,
    paths: {
      login: "/",
      home: "/",
      reception: "/reception",
      patient: patientHref,
      images: `${patientHref}/images`,
      "patient-dark": patientHref,
      editor: encounterPath,
      exam: `${encounterPath}/exam`,
      optical: `${encounterPath}/optical`,
      document: documentPath,
      "document-print": `${documentPath}/print`,
      "encounter-print": `${encounterPath}/print`,
      "document-dark": documentPath,
      "document-print-dark": `${documentPath}/print`,
      "optical-dark": `${encounterPath}/optical`,
      billing: "/billing",
      "billing-diff": "/billing",
      "billing-print": "/billing",
      settings: "/settings",
      "settings-panel": "/settings#drugs",
      "settings-sets": "/settings#sets",
      "settings-phrases": "/settings#phrases",
      "settings-export": "/settings#export",
      "settings-audit": "/settings#audit",
      "settings-panel-dark": "/settings#drugs",
      "editor-dark": encounterPath,
      "reception-dark": "/reception",
      menu: "/reception",
      images: `${patientHref}/images`,
      "encounter-print": `${encounterPath}/print`,
      "document-print": `${documentPath}/print`,
      search: "/",
      register: "/",
      "home-tasks": "/",
      "home-dark": "/",
      "editor-history": encounterPath,
      "editor-side": encounterPath
    }
  };
}

// 会計連携の撮影用に、本日の確定カルテを状態ごとに用意する（未連携 2・連携済み 1・要再連携 1・修正中 1）。
async function seedBilling(page) {
  const result = await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )halunasu_csrf=([^;]*)/u) || [])[1] || "");
    const call = async (method, path, body) => {
      const response = await fetch(`/api/eye${path}`, { method, credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${JSON.stringify(payload).slice(0, 200)}`);
      return payload;
    };
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const order = (code, name) => ({ orderId: code, code, name, kind: "exam", eye: "ou", status: "performed" });
    const drop = (name, timesPerDay, quantity = 1) => ({ kind: "eye_drop", name, eye: "ou", timesPerDay, quantity, unit: "本", route: "outside" });
    const people = [
      { displayName: "会計 一郎", displayNameKana: "カイケイ イチロウ", birthDate: "1952-05-01", sex: "male", primaryPatientNumber: "D021",
        content: { diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou" }], orders: [order("va", "視力検査"), order("iop", "眼圧検査"), order("oct_disc", "OCT（視神経乳頭）")], prescriptions: [drop("ラタノプロスト点眼液0.005%", 1, 2), drop("チモロールマレイン酸塩点眼液0.5%", 2)] } },
      { displayName: "連携 花子", displayNameKana: "レンケイ ハナコ", birthDate: "1990-08-12", sex: "female", primaryPatientNumber: "D022",
        content: { diagnoses: [{ name: "アレルギー性結膜炎", eye: "ou" }], orders: [order("va", "視力検査"), order("slit", "細隙灯顕微鏡検査")], prescriptions: [drop("オロパタジン点眼液0.1%", 4)] } },
      { displayName: "済 次郎", displayNameKana: "スミ ジロウ", birthDate: "1968-01-20", sex: "male", primaryPatientNumber: "D023",
        content: { orders: [order("va", "視力検査")], prescriptions: [] } },
      { displayName: "再送 恵子", displayNameKana: "サイソウ ケイコ", birthDate: "1949-11-03", sex: "female", primaryPatientNumber: "D014",
        content: { diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou" }], orders: [order("iop", "眼圧検査"), order("va", "視力検査")], prescriptions: [drop("ラタノプロスト点眼液0.005%", 1, 2)] } },
      { displayName: "修正 健", displayNameKana: "シュウセイ ケン", birthDate: "1946-04-10", sex: "male", primaryPatientNumber: "D030",
        content: { orders: [order("iop", "眼圧検査")], prescriptions: [drop("ブリモニジン点眼液0.1%", 2)] } }
    ];
    const ids = [];
    for (const person of people) {
      const { content, ...patientInput } = person;
      const { patient } = await call("POST", "/v1/eye/patients", patientInput);
      const created = await call("POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: today, visitType: "revisit", content });
      const id = created.encounter.encounterId;
      const confirmed = await call("POST", `/v1/eye/encounters/${id}/exam-confirm`, { expectedRevision: created.encounter.revision, eye: "both" });
      const finalized = await call("POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: confirmed.encounter.revision });
      ids.push(finalized.encounter);
    }
    const [, , done, resend, amending] = ids;
    await call("POST", "/v1/eye/billing/handoffs", { date: today, encounterIds: [done.encounterId, resend.encounterId, amending.encounterId] });
    const amended = await call("POST", `/v1/eye/encounters/${resend.encounterId}/amend`, { expectedRevision: resend.revision, reason: "点眼薬の変更" });
    const content = { ...amended.encounter.content, prescriptions: [drop("チモロールマレイン酸塩点眼液0.5%", 2, 2)] };
    const patched = await call("PATCH", `/v1/eye/encounters/${resend.encounterId}`, { expectedRevision: amended.encounter.revision, content });
    await call("POST", `/v1/eye/encounters/${resend.encounterId}/finalize`, { expectedRevision: patched.encounter.revision });
    await call("POST", `/v1/eye/encounters/${amending.encounterId}/amend`, { expectedRevision: amending.revision, reason: "処方日数の訂正" });
    return ids.length;
  });
  if (result !== 5) throw new Error("billing seed failed");
}

// デモ患者にはファイルがないので、画像の比較を撮るために OCT 2 件と眼底写真 1 件を取り込む。
async function uploadSampleImages(page, patientHref) {
  const dir = join(outDir, "fixtures");
  mkdirSync(dir, { recursive: true });
  const samples = [
    { name: "oct-old.png", hue: 0, kind: "oct", eye: "od", daysAgo: 120, title: "OCT 黄斑 右" },
    { name: "oct-new.png", hue: 1, kind: "oct", eye: "od", daysAgo: 21, title: "OCT 黄斑 右" },
    { name: "fundus.png", hue: 2, kind: "fundus_photo", eye: "ou", daysAgo: 21, title: "眼底写真" }
  ];
  await page.goto(baseUrl + patientHref);
  for (const sample of samples) {
    const path = join(dir, sample.name);
    writeFileSync(path, samplePng(320, 240, sample.hue));
    await page.getByRole("button", { name: "＋取込" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("ファイル", { exact: true }).setInputFiles(path);
    await dialog.getByLabel("ファイルの種類").selectOption(sample.kind);
    await dialog.getByLabel("ファイルの眼").selectOption(sample.eye);
    await dialog.getByLabel("検査日").fill(new Date(Date.now() + 9 * 3600000 - sample.daysAgo * 86400000).toISOString().slice(0, 10));
    await dialog.getByLabel("ファイルの題名").fill(sample.title);
    await dialog.getByRole("button", { name: "取り込む", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
}

// 撮影用のダミー画像（同心円の縞模様の PNG）を作る。
function samplePng(width, height, variant) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - width / 2, y - height / 2);
      const ring = Math.round(distance / (12 + variant * 4)) % 2;
      const base = ring ? 60 : 150;
      row[1 + x * 3] = base + variant * 30;
      row[2 + x * 3] = base;
      row[3 + x * 3] = Math.max(0, base - variant * 30);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function printSummary(all) {
  console.log("page                       width  overflow  height  targets  <44px  contrastNG  <=13px%  errors");
  for (const [tag, metrics] of Object.entries(all)) {
    const sizes = Object.entries(metrics.fontSizesByChars || {});
    const total = sizes.reduce((sum, [, chars]) => sum + chars, 0) || 1;
    const small = sizes.filter(([size]) => Number(size) <= 13).reduce((sum, [, chars]) => sum + chars, 0);
    console.log([
      tag.padEnd(26), String(metrics.innerWidth).padStart(5), (metrics.overflowX ? `+${metrics.scrollWidth - metrics.innerWidth}` : "-").padStart(9),
      String(metrics.scrollHeight).padStart(7), String(metrics.interactiveTotal).padStart(8), String(metrics.under44).padStart(6),
      `${metrics.contrastFails}/${metrics.contrastChecked}`.padStart(11), `${Math.round((small / total) * 100)}%`.padStart(8), String(metrics.errors.length).padStart(7)
    ].join(" "));
  }
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

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) continue;
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) parsed.set(values[index].slice(2), "true");
    else {
      parsed.set(values[index].slice(2), next);
      index += 1;
    }
  }
  return parsed;
}
