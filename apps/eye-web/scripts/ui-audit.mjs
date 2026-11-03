// UI 監査。デモデータ入りのローカル環境（メモリストア）と Next 開発サーバーを起動し、
// 主要画面を 5 つの画面幅で撮影して、文字サイズ・コントラスト・タップ領域・横あふれを計測する。
//
//   node scripts/ui-audit.mjs [--out DIR] [--pages editor,reception]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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
        if (name === "menu" && width < 768) await page.getByRole("button", { name: "メニュー" }).click();
        if (name === "search") {
          if (width < 768) await page.getByRole("button", { name: "メニュー" }).click();
          await page.getByLabel("患者検索").fill("模");
          await page.waitForTimeout(800);
        }
        if (name === "editor-history" && width < 1280) await page.getByRole("button", { name: /^過去カルテ/u }).click();
        if (name === "editor-side" && width < 1024) await page.getByRole("button", { name: /^確認・比較/u }).click();
        if (name.startsWith("editor-") && !name.endsWith("dark")) await page.waitForTimeout(400);
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
  const card = page.locator(".board-card", { hasText: "模擬 和子" });
  await page.locator(".board").waitFor();
  if (!(await card.count())) {
    await page.locator(".upcoming-row", { hasText: "模擬 和子" }).getByRole("button", { name: "受付する" }).click();
  }
  await card.getByRole("button", { name: /カルテを開く|カルテ作成/u }).click();
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
  const storageState = await context.storageState();
  await context.close();
  return {
    storageState,
    paths: {
      login: "/",
      home: "/",
      reception: "/reception",
      patient: patientHref,
      editor: encounterPath,
      exam: `${encounterPath}/exam`,
      optical: `${encounterPath}/optical`,
      document: documentPath,
      billing: "/billing",
      settings: "/settings",
      "editor-dark": encounterPath,
      "reception-dark": "/reception",
      menu: "/reception",
      search: "/",
      "editor-history": encounterPath,
      "editor-side": encounterPath
    }
  };
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
