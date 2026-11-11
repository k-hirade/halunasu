// UI 監査。デモデータ入りのローカル環境（メモリストア）と Next 開発サーバーを起動し、
// 画面と状態（ダイアログ・メニュー・タブ・引き出し）を画面幅ごとに撮影して、文字サイズ・コントラスト・タップ領域・横あふれと、
// レスポンシブの不具合（画面外へのはみ出し・切れ・スクロールできない枠・隠れた操作・小さいタップ領域/文字・文字の重なり）を計測する。
// 状態の一覧は下の STATES（名前 → 開く URL と、開いた後の操作）。-dark で終わる名前は暗室表示。
//
//   node scripts/ui-audit.mjs [--out DIR] [--pages editor,reception] [--viewports 1440x900,390x844 | responsive]
//                             [--concurrency 4] [--no-full] [--dark-viewports 1366x768,390x844]
//   --pages は名前（"editor" は editor と editor-dark）。前方一致は後ろに "*"（"editor*" で editor-* すべて）。
//   --viewports responsive は 12 の画面幅（PC 4・タブレット 4・スマホ 3・スマホ横 1）。768〜1024 の縦長はタッチ、
//   スマホはタッチ + モバイルの表示（isMobile）で開く。--dark-viewports を付けると -dark の状態はその幅だけで撮る。
//   出力: DIR/<状態>-<幅>x<高さ>.png（--no-full でなければ -full.png も）、metrics.json、responsive.json（要素ごとの指摘）、responsive-summary.txt
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
const pageFilters = args.get("pages") ? args.get("pages").split(",").filter(Boolean) : null;
const matchesFilter = (name) => !pageFilters || pageFilters.some((filter) => (filter.endsWith("*") ? name.startsWith(filter.slice(0, -1)) : name === filter || name.replace(/-dark$/u, "") === filter));
const wants = (prefix) => !pageFilters || Object.keys(STATES).some((name) => name.startsWith(prefix) && matchesFilter(name));
const RESPONSIVE_VIEWPORTS = [
  [1920, 1080], [1440, 900], [1366, 768], [1280, 800], [1024, 768],
  [1024, 1366], [820, 1180], [768, 1024],
  [430, 932], [390, 844], [360, 740], [844, 390]
];
const parseViewports = (value) => (value === "responsive" ? RESPONSIVE_VIEWPORTS : value.split(",").map((item) => item.split("x").map(Number)));
// --viewports 1713x900,1440x900 で画面幅を指定できる（既定は下の 5 つ）
const VIEWPORTS = args.get("viewports") ? parseViewports(args.get("viewports")) : [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]];
const DARK_VIEWPORTS = args.get("dark-viewports") ? parseViewports(args.get("dark-viewports")) : null;
const CONCURRENCY = Math.max(1, Number(args.get("concurrency") || 1));
const FULL = !args.has("no-full");
mkdirSync(outDir, { recursive: true });

// 端末の種類: 768〜1024 の縦長の画面（iPad など）はタッチ、スマホ（短い辺が 500 未満）はタッチ + モバイル表示
const deviceOf = (width, height) => {
  const phone = Math.min(width, height) < 500;
  const tablet = !phone && width <= 1024 && height > width;
  return { hasTouch: phone || tablet, isMobile: phone };
};

// ---- 状態の一覧: 名前 → { path（prepare が返す場所の名前）, run(page, view) } ----
// view = { width, height, touch, ids }。run の中で失敗しても、その時点の画面を撮って setupError に残す。
const editorPath = "editor";
const finalizedPath = "finalized";
const openUserMenu = (page, view) => page.locator(view.width < 768 ? ".eh-menu-button" : ".eh-user-button").click();
// カルテの左「患者の情報」は 768px 未満で引き出し、右「オーダー」は 1280px 未満で引き出し
const openLeftPane = async (page, view) => { if (view.width < 768) await page.locator(".encounter-actions").getByRole("button", { name: "患者の情報", exact: true }).click(); };
const openRightPane = async (page, view) => { if (view.width < 1280) await page.locator(".encounter-actions").getByRole("button", { name: "オーダー", exact: true }).click(); };
const leftTab = (label) => ({ path: editorPath, run: async (page, view) => { await openLeftPane(page, view); await page.locator(".chart-left").getByRole("tab", { name: new RegExp(`^${label}`, "u") }).click(); } });
const rightCategory = (label, query = "") => ({
  path: editorPath,
  run: async (page, view) => {
    await openRightPane(page, view);
    await page.locator(".chart-right").getByRole("tab", { name: label, exact: true }).click();
    if (query) { await page.getByLabel("オーダーを検索").fill(query); await page.waitForTimeout(900); }
  }
});
const examTab = (label) => ({ path: "exam", run: async (page) => { await page.getByRole("tab", { name: label, exact: true }).click(); await page.waitForTimeout(300); } });
const printMedia = (path) => ({ path, run: async (page) => { await page.emulateMedia({ media: "print" }); await page.waitForTimeout(300); } });
const settingsRow = (path, index = 0) => ({ path, run: async (page) => { await page.locator(".master-row-open").nth(index).click(); await page.waitForTimeout(400); } });
const settingsButton = (path, name) => ({ path, run: async (page) => { await page.getByRole("button", { name, exact: true }).click(); await page.waitForTimeout(400); } });
const firstRp = (page) => page.locator(".rp-block, [aria-label^='処方 Rp']").first();

const STATES = {
  // ログイン
  login: { path: "login", noAuth: true },
  "login-totp": {
    path: "login",
    noAuth: true,
    run: async (page) => {
      await page.getByLabel("病院コード").fill(LOCAL_ORGANIZATION_CODE);
      await page.getByLabel("個人ID").fill("director");
      await page.getByLabel("ログイン用パスワード", { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByRole("button", { name: "ログイン", exact: true }).click();
      await page.getByLabel("6桁コード").waitFor();
    }
  },
  // ヘッダー（受付・カルテ・メニュー・ヘルプ）とパスワード変更
  header: { path: "reception" },
  "header-editor": { path: editorPath },
  "header-menu": { path: "reception", run: openUserMenu },
  menu: { path: "reception", run: openUserMenu },
  "header-help": {
    path: "reception",
    run: async (page, view) => {
      if (view.width < 768) await page.locator(".eh-menu-button").click();
      await page.getByRole("button", { name: "ショートカット・ヘルプ" }).first().click();
      await page.getByRole("dialog", { name: "ショートカット" }).waitFor();
    }
  },
  "header-dark": { path: "reception" },
  password: { path: "reception", run: async (page, view) => openPassword(page, view) },
  "password-dark": { path: "reception", run: async (page, view) => openPassword(page, view) },
  "password-error": {
    path: "reception",
    run: async (page, view) => {
      const dialog = await openPassword(page, view);
      await dialog.getByLabel("現在のパスワード", { exact: true }).fill("wrong-password-2026");
      await dialog.getByLabel("新しいパスワード", { exact: true }).fill("audit-new-password-2026");
      await dialog.getByLabel("新しいパスワード（確認）", { exact: true }).fill("audit-new-password-2026");
      await dialog.getByRole("button", { name: "変更する" }).click();
      await dialog.getByRole("alert").first().waitFor();
    }
  },
  "password-empty": {
    path: "reception",
    run: async (page, view) => {
      const dialog = await openPassword(page, view);
      await dialog.getByRole("button", { name: "変更する" }).click();
      await page.waitForTimeout(300);
    }
  },

  // 受付・予約・検索・登録
  reception: { path: "reception" },
  "reception-dark": { path: "reception" },
  "reception-filter": { path: "reception", run: async (page) => page.getByRole("button", { name: "▼ 絞り込み" }).click() },
  "reception-booking": { path: "reception", run: async (page) => openRowBooking(page) },
  "reception-booking-calendar": { path: "reception", run: async (page) => { const dialog = await openRowBooking(page); await dialog.getByRole("button", { name: "予約状況" }).click(); } },
  "reception-booking-calendar-dark": { path: "reception", run: async (page) => { const dialog = await openRowBooking(page); await dialog.getByRole("button", { name: "予約状況" }).click(); } },
  "reception-add-booking": { path: "reception", run: async (page) => { await page.getByRole("button", { name: "予約を追加", exact: true }).click(); await page.getByRole("dialog").first().waitFor(); } },
  "reception-walkin": { path: "reception", run: async (page) => { await page.getByRole("button", { name: "当日受付", exact: true }).click(); await page.getByRole("dialog", { name: "当日受付" }).waitFor(); } },
  "reception-rowmenu": { path: "reception", run: async (page) => { await page.locator(".rc-row summary[aria-label$='のその他の操作']").first().click(); } },
  "reception-memo": { path: "reception", run: async (page) => { await page.locator(".rc-row").getByRole("button", { name: /の受付メモ/u }).first().click(); await page.getByRole("dialog").first().waitFor(); } },
  "reception-search": { path: "reception", run: async (page) => { await page.getByRole("button", { name: "患者検索（/）" }).click(); await page.waitForTimeout(800); } },
  "reception-search-results": {
    path: "reception",
    run: async (page) => {
      await page.getByRole("button", { name: "患者検索（/）" }).click();
      await page.getByRole("dialog", { name: "患者検索" }).getByLabel("検索する語").fill("模");
      await page.waitForTimeout(900);
    }
  },
  "reception-register": {
    path: "reception",
    run: async (page) => {
      await page.getByRole("button", { name: "患者検索（/）" }).click();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: "新規患者登録" }).click();
    }
  },
  "reception-schedule": { path: "schedule" },
  "reception-schedule-dark": { path: "schedule" },
  // ---- replicate-2（受付）: 比較 PNG 01〜11 と「対応する画面がない機能」の撮影 ----
  "reception-places": { path: "reception", run: async (page) => { await page.locator(".rc-place-tab").nth(1).click(); } },
  "reception-status-menu": { path: "reception", run: async (page) => { await page.locator(".rc-row button.rc-status:not(:disabled)").first().click(); await page.getByRole("menu").first().waitFor(); } },
  "reception-status-menu-dark": { path: "reception", run: async (page) => { await page.locator(".rc-row button.rc-status:not(:disabled)").first().click(); await page.getByRole("menu").first().waitFor(); } },
  "reception-cancel": { path: "reception", run: async (page) => { await page.locator(".rc-row button.rc-status:not(:disabled)").first().click(); await page.getByRole("menuitemradio", { name: "受付取消" }).first().click(); await page.getByRole("alertdialog").waitFor(); } },
  "reception-memo-labels": { path: "reception", run: async (page) => { await page.locator(".rc-row").getByRole("button", { name: /の受付メモ/u }).first().click(); await page.getByRole("button", { name: "ラベルを追加" }).click(); } },
  "reception-patient-memo": { path: "reception", run: async (page) => { await openRowMenuItem(page, "患者メモ"); await page.getByRole("dialog").first().waitFor(); } },
  "reception-marks": { path: "reception", run: async (page) => { await openRowMenuItem(page, "患者マーク"); await page.getByRole("dialog", { name: /患者マーク/u }).waitFor(); } },
  "reception-history": { path: "reception", run: async (page) => { await page.locator(".rc-row summary[aria-label$='のその他の操作']").first().click(); await page.getByRole("button", { name: "受付編集履歴", exact: true }).first().click(); await page.getByRole("dialog").first().waitFor(); await page.waitForTimeout(500); } },
  "reception-day-history": { path: "reception", run: async (page) => { await page.getByRole("button", { name: "編集履歴", exact: true }).click(); await page.getByRole("dialog").first().waitFor(); } },
  "reception-search-options": {
    path: "reception",
    run: async (page) => {
      await page.getByRole("button", { name: "患者検索（/）" }).click();
      await page.getByRole("dialog", { name: "患者検索" }).getByRole("button", { name: "検索オプション" }).click();
    }
  },
  "reception-search-options-applied": {
    path: "reception",
    run: async (page) => {
      await page.getByRole("button", { name: "患者検索（/）" }).click();
      const dialog = page.getByRole("dialog", { name: "患者検索" });
      await dialog.getByRole("button", { name: "検索オプション" }).click();
      await dialog.getByRole("button", { name: "今月" }).click();
      await dialog.getByRole("button", { name: "検索", exact: true }).click();
      await page.waitForTimeout(900);
    }
  },
  "reception-print-booking": { path: "receptionPrintBooking" },
  "reception-print-visit": { path: "receptionPrintVisit" },
  "reception-display": { path: "receptionDisplay" },
  "reception-display-dark": { path: "receptionDisplay" },
  // 診察（/）
  home: { path: "home" },
  "home-dark": { path: "home" },
  "home-summary": {
    path: "home",
    run: async (page) => {
      await page.getByRole("tab", { name: /^全て/u }).click().catch(() => null);
      await page.locator(".cl-row").first().click();
      await page.waitForTimeout(1200);
    }
  },
  "home-tasks": { path: "home", run: async (page) => { await page.getByRole("tab", { name: /^未確定カルテ/u }).click(); await page.waitForTimeout(500); } },
  "home-all": { path: "home", run: async (page) => { await page.getByRole("tab", { name: /^全て/u }).click(); await page.waitForTimeout(500); } },
  search: {
    path: "home",
    run: async (page) => {
      await page.getByRole("button", { name: "患者検索（/）" }).click();
      await page.getByRole("dialog", { name: "患者検索" }).getByLabel("検索する語").fill("模");
      await page.waitForTimeout(800);
    }
  },
  register: {
    path: "home",
    run: async (page) => {
      await page.getByRole("button", { name: "患者検索（/）" }).click();
      await page.getByRole("dialog", { name: "患者検索" }).getByLabel("検索する語").fill("もぎ");
      await page.waitForTimeout(800);
      await page.getByRole("dialog", { name: "患者検索" }).getByRole("button", { name: "新規患者登録" }).click();
      await page.waitForTimeout(800);
    }
  },

  // カルテ編集
  editor: { path: editorPath },
  "editor-dark": { path: editorPath },
  "editor-tab-info": leftTab("患者情報"),
  "editor-tab-exam": leftTab("検査"),
  "editor-tab-historylist": leftTab("診療履歴"),
  "editor-tab-drugs": leftTab("薬歴"),
  "editor-tab-files": leftTab("ファイル"),
  "editor-history": leftTab("病名"),
  "editor-dx-add": {
    path: editorPath,
    run: async (page, view) => {
      await openLeftPane(page, view);
      await page.getByRole("tab", { name: "病名" }).click();
      await page.getByRole("button", { name: "病名を追加" }).click();
      const dialog = page.getByRole("dialog", { name: "傷病名新規登録" });
      await dialog.getByLabel("傷病名を検索").fill("緑内障");
      await page.waitForTimeout(900);
    }
  },
  "editor-dx-edit": {
    path: editorPath,
    run: async (page, view) => {
      await openLeftPane(page, view);
      await page.getByRole("tab", { name: "病名" }).click();
      await page.locator(".dx-table").getByRole("button", { name: /を編集$/u }).first().click();
      await page.getByRole("dialog").first().waitFor();
      await page.locator(".dx-modifier-candidates li").first().waitFor().catch(() => null);
    }
  },
  "editor-set-panel": rightCategory("セット"),
  "editor-side": rightCategory("投薬", "ラタノ"),
  "editor-order-exam": rightCategory("検査"),
  "editor-order-optical": rightCategory("眼鏡・CL"),
  "editor-order-phrase": rightCategory("定型文"),
  "editor-order-all": rightCategory("全て", "眼"),
  "editor-rp": {
    path: editorPath,
    run: async (page) => {
      const rp = firstRp(page);
      await rp.scrollIntoViewIfNeeded();
      await rp.locator('summary[aria-label="用法"]').first().click();
      await page.waitForTimeout(300);
    }
  },
  "editor-rp-menu": {
    path: editorPath,
    run: async (page) => {
      const rp = firstRp(page);
      await rp.scrollIntoViewIfNeeded();
      await rp.locator("summary.rp-badge").first().click();
      await page.waitForTimeout(300);
    }
  },
  "editor-next": {
    path: editorPath,
    run: async (page) => {
      await page.getByRole("toolbar", { name: "カルテの操作" }).getByRole("button", { name: /次へ/u }).click();
      await page.getByRole("dialog", { name: /警告一覧|カルテを確定します/u }).waitFor();
    }
  },
  "editor-status": {
    path: finalizedPath,
    run: async (page) => {
      await page.getByRole("toolbar", { name: "カルテの操作" }).getByRole("button", { name: /次へ/u }).click();
      await page.getByRole("dialog", { name: "患者ステータス選択" }).waitFor();
      await page.waitForTimeout(800);
    }
  },
  "editor-finalized": { path: finalizedPath },
  "editor-versions": { path: finalizedPath, run: async (page) => { await page.getByRole("button", { name: /^版履歴/u }).first().click(); await page.getByRole("dialog", { name: "版履歴" }).waitFor(); } },
  "editor-shortcuts": { path: editorPath, run: async (page) => { await page.getByRole("button", { name: "ショートカット一覧" }).click(); await page.getByRole("dialog", { name: "ショートカット" }).waitFor(); } },
  "editor-schema-pick": { path: editorPath, run: async (page) => { await page.locator(".sketch-add").click(); await page.getByRole("dialog").first().waitFor(); } },
  "editor-schema": {
    path: editorPath,
    run: async (page) => {
      await page.locator(".sketch-add").click();
      await page.getByRole("dialog").getByRole("button", { name: "右眼眼底" }).click();
      await page.waitForTimeout(600);
    }
  },
  "editor-set-create": { path: editorPath, run: async (page) => { await page.getByRole("button", { name: "セット登録" }).click(); await page.getByRole("dialog", { name: /セット登録/u }).waitFor(); } },
  "editor-visit": { path: editorPath, run: async (page) => { await page.getByRole("button", { name: /^診療日・区分を変える/u }).click(); await page.getByRole("dialog").first().waitFor(); } },
  "editor-profile": { path: editorPath, run: async (page) => { await page.getByRole("button", { name: "既往・内服を編集" }).first().click(); await page.getByRole("dialog").first().waitFor(); } },
  "editor-allergy": { path: editorPath, run: async (page) => { await page.getByRole("button", { name: "アレルギー・病名" }).first().click(); await page.waitForTimeout(400); } },
  "editor-print-menu": { path: editorPath, run: async (page) => { await page.locator(".actionbar-print > summary").click(); } },
  "editor-more": { path: editorPath, run: async (page) => { await page.locator(".actionbar-more > summary").click(); } },
  "editor-booking": { path: editorPath, run: async (page) => { await page.getByRole("button", { name: "予約を取る" }).click(); await page.getByRole("dialog").first().waitFor(); } },
  "editor-bottom": { path: editorPath, run: async (page) => { await page.evaluate(() => { for (const el of document.querySelectorAll(".chart-center, .chart-columns, main, body, html")) el.scrollTop = el.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); }); await page.waitForTimeout(300); } },

  // 検査入力（大タブ 11・テンキー・データ表示）
  exam: { path: "exam" },
  "exam-dark": { path: "exam" },
  "exam-iop": examTab("眼圧"),
  "exam-refraction": examTab("屈折"),
  "exam-kerato": examTab("角膜曲率"),
  "exam-gaze": examTab("眼位"),
  "exam-worth": examTab("両眼視"),
  "exam-color": examTab("色覚"),
  "exam-stereo": examTab("立体視"),
  "exam-accommodation": examTab("調節"),
  "exam-anterior": examTab("前眼部"),
  "exam-other": examTab("その他"),
  "exam-keypad": {
    path: "exam",
    run: async (page) => {
      const padButton = page.getByRole("button", { name: "テンキー", exact: true });
      if (await padButton.isEnabled()) await padButton.click();
      await page.getByLabel("遠見 右眼 球面").first().click();
      await page.waitForTimeout(500);
    }
  },
  "exam-data": { path: "exam", run: async (page) => { await page.getByRole("button", { name: "データ表示" }).click(); await page.getByRole("dialog").first().waitFor(); } },
  "exam-checklist": { path: "exam", run: async (page) => { await page.getByRole("button", { name: "＋ 検査を追加" }).click(); await page.waitForTimeout(400); } },
  "exam-bottom": { path: "exam", run: async (page) => { await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(300); } },

  // 患者ページ・画像の比較
  patient: { path: "patient" },
  "patient-dark": { path: "patient" },
  "patient-vaiop": { path: "patient", run: async (page) => { await page.getByRole("tab", { name: "視力眼圧" }).click(); await page.waitForTimeout(500); } },
  "patient-upload": { path: "patient", run: async (page) => { await page.getByRole("button", { name: "＋取込" }).first().click(); await page.getByRole("dialog").first().waitFor(); } },
  "patient-more": { path: "patient", run: async (page) => { await page.locator('summary[aria-label="その他の操作"]').first().click(); } },
  "patient-file": { path: "patient", run: async (page) => { await page.locator("button.thumb, button:has(> .side-row-title)").first().click(); await page.waitForTimeout(600); } },
  images: { path: "images" },
  "images-ou": { path: "images", run: async (page) => { await page.getByRole("button", { name: "OU", exact: true }).click(); await page.waitForTimeout(500); } },
  "images-series": { path: "images", run: async (page) => { await page.getByRole("button", { name: "時系列", exact: true }).click(); await page.waitForTimeout(500); } },

  // 会計連携
  billing: { path: "billing" },
  "billing-dark": { path: "billing" },
  "billing-diff": {
    path: "billing",
    run: async (page) => {
      await page.locator('.bill-row-wrap[data-state="changed"] .flow-row-open').first().click();
      await page.locator('.bill-row-wrap[data-state="pending"] .flow-row-open').first().click();
      await page.waitForTimeout(300);
    }
  },
  "billing-send": { path: "billing", run: async (page) => { await page.locator('.bill-row-wrap[data-state="pending"] .bill-actions .btn-primary').first().click(); await page.waitForTimeout(300); } },
  "billing-more": { path: "billing", run: async (page) => { await page.locator("summary[aria-label='会計連携のその他の操作']").click(); } },
  "billing-help": { path: "billing", run: async (page) => { await page.locator("summary[aria-label='この画面について']").click(); } },
  "billing-rowmenu": { path: "billing", run: async (page) => { await page.locator(".bill-row-wrap summary[aria-label$='のその他の操作']").first().click(); } },
  "billing-print": {
    path: "billing",
    run: async (page) => {
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
  },

  // 文書・印刷
  document: { path: "document" },
  "document-dark": { path: "document" },
  "document-insert": { path: "document", run: async (page) => { await page.getByRole("button", { name: "＋カルテから挿入" }).click(); await page.waitForTimeout(600); } },
  "document-more": { path: "document", run: async (page) => { await page.locator('summary[aria-label="文書のその他の操作"]').click(); } },
  "document-confirm": { path: "document", run: async (page) => { await page.getByRole("button", { name: "確定する" }).first().click(); await page.getByRole("dialog").first().waitFor(); } },
  "document-print": { path: "documentPrint" },
  "document-print-dark": { path: "documentPrint" },
  "document-print-media": printMedia("documentPrint"),
  "encounter-print": { path: "encounterPrint" },
  "encounter-print-media": printMedia("encounterPrint"),
  optical: { path: "optical" },
  "optical-dark": { path: "optical" },
  "optical-media": printMedia("optical"),

  // 設定（各項目と編集ダイアログ）
  settings: { path: "settings" },
  "settings-dark": { path: "settings" },
  "settings-facility-edit": { path: "settings", run: async (page) => { await page.getByRole("button", { name: "✎ 編集" }).click(); await page.waitForTimeout(400); } },
  "settings-users": { path: "settingsUsers" },
  "settings-users-edit": settingsRow("settingsUsers"),
  "settings-sets": { path: "settingsSets", run: async (page) => { await page.locator(".set-tree-item", { hasText: "点眼" }).first().click(); await page.waitForTimeout(300); } },
  "settings-sets-edit": settingsRow("settingsSets"),
  "settings-sets-new": settingsButton("settingsSets", "＋ セットを追加"),
  "settings-sets-folder": settingsButton("settingsSets", "＋ フォルダ"),
  "settings-phrases": { path: "settingsPhrases" },
  "settings-phrases-edit": settingsButton("settingsPhrases", "＋ 定型文を追加"),
  "settings-drugs": { path: "settingsDrugs" },
  "settings-panel": settingsRow("settingsDrugs", 1),
  "settings-panel-dark": settingsRow("settingsDrugs", 1),
  "settings-drugs-new": settingsButton("settingsDrugs", "＋ 薬剤を追加"),
  "settings-export": { path: "settingsExport" },
  "settings-audit": { path: "settingsAudit" },

  // ---- replicate-2 chart-main（docs/eye-ux/rep2-chart-main-20261111.md）: 中央・右のオーダー・右下の操作帯・カルテのダイアログ ----
  // 13: 検査の帯を畳んで 主訴・所見｜処置・行為 を広く使う
  "editor-exam-collapsed": { path: editorPath, run: async (page) => { await page.getByRole("button", { name: "検査の欄を畳む" }).click(); await page.waitForTimeout(200); } },
  // 35: 右下の大きいボタンの操作帯（確定済みのカルテでは［送信］が塗りのボタン）
  "editor-actionbar-finalized": { path: finalizedPath, run: async (page) => { await page.getByRole("toolbar", { name: "カルテの操作" }).scrollIntoViewIfNeeded(); } },
  // 35: 検査依頼
  "editor-exam-request": {
    path: editorPath,
    run: async (page) => {
      await page.getByRole("toolbar", { name: "カルテの操作" }).getByRole("button", { name: "検査依頼" }).click();
      const dialog = page.getByRole("dialog", { name: "検査依頼" });
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "＋視・圧", exact: true }).click();
      await page.waitForTimeout(300);
    }
  },
  // 49: カルテの［¥ 送信］から送る中身を確認
  "editor-send": {
    path: finalizedPath,
    run: async (page) => {
      await page.getByRole("toolbar", { name: "カルテの操作" }).getByRole("button", { name: "送信" }).click();
      await page.getByRole("dialog", { name: /会計情報をレセコンへ送りますか/u }).waitFor();
      await page.waitForTimeout(800);
    }
  },
  // 30: Rp のコメント追加ダイアログ（記載先・キーワード）
  "editor-rp-comment": {
    path: editorPath,
    run: async (page) => {
      const rp = firstRp(page);
      await rp.scrollIntoViewIfNeeded();
      await rp.locator("summary.rp-badge").first().click();
      await page.getByRole("button", { name: /コメントを追加（探す/u }).first().click();
      await page.getByRole("dialog", { name: "コメント追加" }).waitFor();
    }
  },
  // 36: 警告一覧で 1 行を無効化した状態
  "editor-next-dismissed": {
    path: editorPath,
    run: async (page) => {
      await page.getByRole("toolbar", { name: "カルテの操作" }).getByRole("button", { name: /次へ/u }).click();
      const dialog = page.getByRole("dialog", { name: /警告一覧|カルテを確定します/u });
      await dialog.waitFor();
      const dismiss = dialog.getByRole("button", { name: /を無効化$/u }).first();
      if (await dismiss.count()) await dismiss.click();
      await page.waitForTimeout(200);
    }
  },
  // 29: 用法が未入力の Rp（赤いボタン）。新しい Rp に薬を入れた直後
  "editor-rp-usage-missing": {
    path: editorPath,
    run: async (page, view) => {
      await openRightPane(page, view);
      await page.locator(".chart-right").getByRole("tab", { name: "投薬", exact: true }).click();
      // よく使う薬剤は既定の用法を持つので、薬剤名をそのまま入れる（用法なし）
      await page.getByLabel("オーダーを検索").fill("監査用の点眼");
      await page.waitForTimeout(900);
      await page.locator(".chart-right .order-item.is-free").click();
      if (view.width < 1280) await page.locator(".chart-right").getByRole("button", { name: "閉じる" }).click();
      const missing = page.locator(".usage-pill.is-missing").first();
      await missing.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    }
  },
  // 25: 定期登録のダイアログ
  "editor-regular-create": {
    path: editorPath,
    run: async (page) => {
      await page.getByRole("button", { name: "定期登録" }).click();
      await page.getByRole("dialog", { name: "定期登録" }).waitFor();
    }
  },
  // 25: 右下の「定期」を開いた状態（その場で 1 件登録してから開く）
  "editor-order-regular": {
    path: editorPath,
    run: async (page, view) => {
      await page.getByRole("button", { name: "定期登録" }).click();
      const dialog = page.getByRole("dialog", { name: "定期登録" });
      await dialog.getByLabel("定期の名前").fill(`監査 定期 ${view.width}`);
      await dialog.getByRole("radio", { name: /毎回/u }).check();
      await dialog.getByRole("button", { name: "登録" }).click();
      await dialog.waitFor({ state: "detached" });
      await openRightPane(page, view);
      const head = page.locator(".order-regular > summary");
      if (!(await page.locator(".order-regular[open]").count())) await head.click();
      await page.waitForTimeout(300);
    }
  }
};

// ==== replicate-2 chart-left: カルテ左ペイン（デジカルの 2 段タブ・各タブ・ダイアログ） ====
// 比較表（compare/15〜24 と「ハルナスに対応する画面がない」の 問診・バイタル・サマリー）に対応する撮影の状態。
const leftDialog = (label, open) => ({
  path: editorPath,
  run: async (page, view) => {
    await leftTab(label).run(page, view);
    await open(page);
    await page.getByRole("dialog").first().waitFor();
    await page.waitForTimeout(500);
  }
});
Object.assign(STATES, {
  // 16: 診療履歴の「一覧」= 日付 × 区分の表（行を押した 1 件だけ下に出す）
  "editor-tab-historylist": {
    path: editorPath,
    run: async (page, view) => {
      await leftTab("診療履歴").run(page, view);
      await page.locator(".history-tab .pane-tools").getByRole("button", { name: "一覧", exact: true }).click();
      await page.getByRole("table", { name: "診療履歴の一覧" }).waitFor();
    }
  },
  "editor-tab-history": leftTab("診療履歴"),
  // 20: ファイル = 文書と取り込みファイルの 1 つの表（読み込みを待って撮る）
  "editor-tab-files": {
    path: editorPath,
    run: async (page, view) => {
      await leftTab("ファイル").run(page, view);
      await page.locator(".cl-files-table, .cl-files .empty").first().waitFor();
    }
  },
  "editor-tab-interview": leftTab("問診"),
  "editor-tab-allergy": leftTab("副作用薬等"),
  "editor-tab-vitals": leftTab("バイタル"),
  "editor-tab-summary": leftTab("サマリー"),
  "editor-allergy-edit": leftDialog("副作用薬等", (page) => page.locator(".cl-section").first().getByRole("button", { name: /を編集$/u }).first().click()),
  "editor-regular-add": leftDialog("副作用薬等", async (page) => {
    await page.getByRole("button", { name: "常用薬を追加" }).click();
    await page.getByRole("dialog").getByLabel("医薬品を検索").fill("チモロール");
    await page.waitForTimeout(900);
  }),
  "editor-vitals-add": leftDialog("バイタル", (page) => page.getByRole("button", { name: "バイタルを追加" }).click()),
  "editor-interview-add": leftDialog("問診", (page) => page.getByRole("button", { name: "問診を追加" }).click()),
  "editor-summary-edit": leftDialog("サマリー", (page) => page.getByRole("button", { name: "サマリーを編集" }).click()),
  "editor-info-edit": leftDialog("患者情報", async (page) => {
    await page.getByRole("button", { name: "患者情報を編集" }).click();
  }),
  "editor-files-menu": {
    path: editorPath,
    run: async (page, view) => {
      await leftTab("ファイル").run(page, view);
      await page.locator(".cl-files-tools .cl-menu > summary").filter({ hasText: "文書作成" }).click();
      await page.waitForTimeout(300);
    }
  },
  "editor-dx-send": {
    path: editorPath,
    run: async (page, view) => {
      await leftTab("病名").run(page, view);
      await page.getByRole("button", { name: "レセコン送信" }).click();
      await page.waitForTimeout(300);
    }
  }
});
for (const name of ["editor-tab-history", "editor-tab-interview", "editor-tab-allergy", "editor-tab-vitals", "editor-tab-summary", "editor-allergy-edit", "editor-regular-add", "editor-vitals-add", "editor-interview-add", "editor-summary-edit", "editor-info-edit", "editor-files-menu", "editor-dx-send"]) {
  const original = STATES[name].run;
  STATES[name].run = async (page, view) => {
    if (view.width >= 768 && view.height <= 500) await page.locator(".encounter-actions").getByRole("button", { name: "患者の情報", exact: true }).click();
    await original(page, view);
  };
}

// ---- (B) カルテ編集: 高さ 500px 以下（スマホ横）は幅があっても左が引き出しになる ----
// 上の openLeftPane は幅だけで判断するため、左のタブを開く状態は、高さ 500px 以下ではまず引き出しを開いてから元の操作をする。
for (const name of ["editor-tab-info", "editor-tab-exam", "editor-tab-historylist", "editor-tab-drugs", "editor-tab-files", "editor-history", "editor-dx-add", "editor-dx-edit"]) {
  const original = STATES[name].run;
  STATES[name].run = async (page, view) => {
    if (view.width >= 768 && view.height <= 500) await page.locator(".encounter-actions").getByRole("button", { name: "患者の情報", exact: true }).click();
    await original(page, view);
  };
}

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
    const jobs = [];
    for (const [name, state] of Object.entries(STATES)) {
      if (!matchesFilter(name)) continue;
      const viewports = name.endsWith("-dark") && DARK_VIEWPORTS ? DARK_VIEWPORTS : VIEWPORTS;
      for (const [width, height] of viewports) jobs.push({ name, state, width, height });
    }
    // 端末の種類ごとにまとめ、種類ごとに順に走らせる（同じ種類の中だけ並列にする）。
    // ページ全体のスクショは端末の設定を一度外すので、種類の違う画面を同時に開くと (pointer: coarse) の判定が混ざる。
    const groups = new Map();
    for (const job of jobs) {
      const device = deviceOf(job.width, job.height);
      const key = `${device.hasTouch}-${device.isMobile}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    let done = 0;
    const started = Date.now();
    for (const group of groups.values()) {
      let next = 0;
      const worker = async () => {
        while (next < group.length) {
          const job = group[next];
          next += 1;
          await runJob(browser, storageState, paths, job).catch((error) => {
            results[`${job.name}-${job.width}x${job.height}`] = { setupError: `JOB ${error.message.slice(0, 300)}`, errors: [] };
          });
          done += 1;
          if (done % 20 === 0) console.log(`${done}/${jobs.length} (${Math.round((Date.now() - started) / 1000)}s)`);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
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
writeResponsive(results);
printSummary(results);
console.log(`\nScreenshots, metrics.json, responsive.json and responsive-summary.txt: ${outDir}`);

// 1 つの状態 × 1 つの画面幅を撮る
async function runJob(browser, storageState, paths, { name, state, width, height }) {
  const device = deviceOf(width, height);
  const context = await browser.newContext({ viewport: { width, height }, ...device, ...(state.noAuth ? {} : { storageState }) });
  try {
    const dark = name.endsWith("-dark");
    await context.addInitScript((value) => { try { window.localStorage.setItem("halunasu-eye-dark", value); } catch {} }, dark ? "1" : "0");
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 300)); });
    page.on("pageerror", (error) => errors.push(`PAGEERROR ${error.message.slice(0, 200)}`));
    const target = paths[state.path];
    if (!target) throw new Error(`no path for ${state.path}`);
    await page.goto(baseUrl + target, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => null);
    await page.waitForTimeout(state.noAuth ? 1500 : 2500);
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    let setupError = "";
    if (state.run) {
      try {
        await state.run(page, { width, height, touch: device.hasTouch });
      } catch (error) {
        setupError = error.message.split("\n")[0].slice(0, 240);
      }
    }
    await page.waitForTimeout(300);
    const tag = `${name}-${width}x${height}`;
    // 先に測る（ページ全体のスクショは端末の設定を一度外すので、そのあとはタッチの判定が外れる）
    const metrics = await page.evaluate(metricsScript);
    await page.screenshot({ path: join(outDir, `${tag}.png`) });
    if (FULL) await page.screenshot({ path: join(outDir, `${tag}-full.png`), fullPage: true });
    metrics.errors = errors;
    metrics.setupError = setupError;
    metrics.device = device;
    results[tag] = metrics;
  } finally {
    await context.close();
  }
}

async function openPassword(page, view) {
  await openUserMenu(page, view);
  await page.getByRole("button", { name: "パスワード変更" }).click();
  const dialog = page.getByRole("dialog", { name: "パスワード変更" });
  await dialog.waitFor();
  return dialog;
}

// replicate-2: 行の「…」から項目を開く（その項目がある最初の行）
async function openRowMenuItem(page, label) {
  const rows = page.locator(".rc-row");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    await row.locator("summary").click();
    const item = row.getByRole("button", { name: label, exact: true });
    if (await item.count()) {
      await item.click();
      return;
    }
    await row.locator("summary").click();
  }
  throw new Error(`no row has ${label}`);
}

async function openRowBooking(page) {
  await page.locator(".rc-row", { hasText: "見本 花子" }).getByRole("button", { name: /の次回予約$/u }).first().click();
  const dialog = page.getByRole("dialog", { name: "予約登録" });
  await dialog.waitFor();
  return dialog;
}

// 指摘を状態ごと・種類ごとにまとめて responsive.json と responsive-summary.txt に書く
function writeResponsive(all) {
  const kinds = ["offViewport", "clipped", "bleed", "unscrollable", "covered", "textOverlap", "ellipsisNoTitle", "tinyText", "tinyTargets"];
  const report = {};
  const lines = [`state${" ".repeat(36)}docX  ${kinds.map((kind) => kind.slice(0, 8).padStart(9)).join("")}  lock  setup`];
  for (const [tag, metrics] of Object.entries(all)) {
    const r = metrics.responsive || {};
    report[tag] = { docOverflowX: r.docOverflowX, docOverflowY: r.docOverflowY, scrollLock: r.scrollLock, setupError: metrics.setupError || "", errors: (metrics.errors || []).slice(0, 5), ...Object.fromEntries(kinds.map((kind) => [kind, r[kind] || []])), coveredByOverlay: r.coveredByOverlay || 0 };
    lines.push(`${tag.padEnd(40)} ${String(r.docOverflowX ?? "-").padStart(5)}  ${kinds.map((kind) => String((r[kind] || []).length).padStart(9)).join("")}  ${r.scrollLock ? "LOCK" : "    "}  ${metrics.setupError ? `ERR ${metrics.setupError.slice(0, 80)}` : ""}`);
  }
  writeFileSync(join(outDir, "responsive.json"), JSON.stringify(report, null, 1));
  writeFileSync(join(outDir, "responsive-summary.txt"), `${lines.join("\n")}\n`);
}

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
  await page.getByRole("link", { name: "受付画面", exact: true }).click();
  // 過去カルテのあるデモ患者で撮る。未受付なら受付してからカルテを開く。
  const row = page.locator(".rc-row", { hasText: "模擬 和子" });
  await row.waitFor();
  // 予約済ならステータスのメニューで受付中にしてから、氏名を押してカルテを開く（来院済みの行はカルテを作って開く）
  if ((await row.locator("button.rc-status").getAttribute("data-status")) === "booked") {
    await row.locator("button.rc-status").click();
    await row.getByRole("menuitemradio", { name: "受付中", exact: true }).click();
    await row.locator("button.rc-status.is-checked_in").waitFor();
  }
  await row.locator(".rc-name").click();
  await page.waitForURL(/\/encounters\//u);
  const encounterPath = new URL(page.url()).pathname;
  // 検査値は検査ページ（別の画面）で入れるので、撮影用には検査記録を API で入れておく（カルテには読み取りの帯で出る）
  const encounterId = encounterPath.split("/").at(-1);
  await page.getByRole("textbox", { name: "主訴・所見", exact: true }).waitFor();
  await apiCall(page, "GET", `/v1/eye/encounters/${encounterId}`).then((payload) => apiCall(page, "POST", `/v1/eye/encounters/${encounterId}/exam-records`, {
    expectedRevision: payload.encounter.revision,
    values: {
      vision: { far: { od: { uncorrected: "0.9", corrected: "1.2", sphere: -1, cylinder: -0.5, axis: 180 }, os: { uncorrected: "0.3", corrected: "0.6" }, ou: { corrected: "1.2" } } },
      iop: { od: { readings: [14, 15, 14], method: "nct" }, os: { readings: [23, 22, 24], method: "nct" } },
      pupil: { od: { sizeMm: 3, reaction: "brisk" }, os: { sizeMm: 3.5, reaction: "brisk" } },
      binocular: { rapd: "none", alignment: "ortho" }
    }
  }));
  await page.reload();
  await page.getByRole("textbox", { name: "主訴・所見", exact: true }).fill("術後定期検査。右眼のかすみは改善。\n前房清明、IOL 正位。");
  // 病名（病名タブの一覧・編集ダイアログの撮影用）。まだ無ければマスターから主病で 1 件
  await page.getByRole("tab", { name: "病名" }).click();
  if (!(await page.locator(".dx-table").getByRole("button", { name: /を編集$/u }).count())) {
    await page.getByRole("button", { name: "病名を追加" }).click();
    const dxDialog = page.getByRole("dialog", { name: "傷病名新規登録" });
    await dxDialog.getByLabel("傷病名を検索").fill("開放隅角緑内障");
    await dxDialog.locator(".dx-add-row").filter({ hasText: /^原発開放隅角緑内障/u }).first().getByRole("button", { name: "主病" }).click();
    await dxDialog.getByText(/登録しました/u).waitFor();
    await dxDialog.getByRole("button", { name: "閉じる" }).click();
  }
  await page.getByRole("tab", { name: /^診療履歴/u }).click();
  // 眼別の所見（従来の欄）・説明・同意。撮影で見えるように入れておく
  // 前回から写った所見があれば眼別の所見は畳んだまま出ている（空なら＋チップ）
  if (await page.getByRole("button", { name: "＋ 眼別の所見" }).count()) await page.getByRole("button", { name: "＋ 眼別の所見" }).click();
  else await page.locator("#field-eyes > summary").click();
  if (await page.getByRole("button", { name: "＋ C/D 比" }).count()) await page.getByRole("button", { name: "＋ C/D 比" }).click();
  await page.getByLabel("右眼 C/D 比").fill("0.6");
  await page.getByLabel("左眼 C/D 比").fill("0.7");
  if (await page.getByRole("button", { name: "＋ その他" }).count()) await page.getByRole("button", { name: "＋ その他" }).click();
  await page.getByLabel("右眼 その他", { exact: true }).fill("眼瞼・涙器 異常なし");
  await page.getByRole("button", { name: "＋ 説明・同意" }).click();
  await page.getByRole("button", { name: "散瞳後の注意" }).click();
  await page.getByLabel("説明した相手").selectOption("patient");
  await page.getByLabel("同意", { exact: true }).selectOption("not_required");
  // 処方（右のオーダーで探して入れる）と眼鏡処方（詳細つき）。処方箋の紙面の撮影用
  await page.getByRole("tab", { name: "投薬" }).click();
  await page.getByLabel("オーダーを検索").fill("チモロール");
  await page.locator(".order-item").filter({ hasText: /チモロール/u }).first().click();
  await page.getByLabel("オーダーを検索").fill("");
  await page.getByRole("tab", { name: "眼鏡・CL" }).click();
  await page.getByRole("button", { name: /眼鏡処方箋/u }).click();
  await page.getByLabel("用途").selectOption("far");
  await page.getByLabel("右眼 S", { exact: true }).fill("-2");
  await page.getByLabel("右眼 C", { exact: true }).fill("-0.5");
  await page.getByLabel("右眼 Ax", { exact: true }).fill("180");
  await page.getByLabel("左眼 S", { exact: true }).fill("-1.5");
  await page.getByLabel("瞳孔間距離").fill("62");
  await page.getByRole("button", { name: /詳細（素材・コート・カラー・装用方法）/u }).click();
  await page.getByLabel("素材", { exact: true }).selectOption("organic");
  await page.getByLabel("コート", { exact: true }).fill("UVカット");
  await page.getByLabel("カラー", { exact: true }).fill("グレー 15%");
  await page.getByLabel("装用方法", { exact: true }).selectOption("as_needed");
  await page.getByText("今回眼鏡処方箋を発行する").click();
  await page.getByText("保存済み").waitFor({ timeout: 15_000 });
  const patientHref = await page.locator('a[href^="/patients/"]').first().getAttribute("href");
  // 文書は左の「ファイル」タブから作る
  await page.getByRole("tab", { name: "ファイル" }).click();
  await page.locator(".cl-files-tools .cl-menu > summary").filter({ hasText: "文書作成" }).click();
  await page.getByRole("button", { name: "紹介状を作成" }).click();
  await page.waitForURL(/\/documents\//u);
  const documentPath = new URL(page.url()).pathname;
  await page.getByLabel("宛先 医療機関").fill("県立中央病院");
  await page.waitForTimeout(2500);
  // 確定済みのカルテ（版履歴・次へ の受付の状態の撮影用）は会計連携の準備で作る。受付一覧の会計待・会計済の行もここで入る
  const billingIds = wants("billing") || wants("editor") || wants("reception") ? await seedBilling(page) : [];
  if (wants("settings")) await seedSettings(page);
  const receptionIds = wants("reception") ? await seedReceptionRep2(page) : {};
  if (wants("patient") || wants("images")) await uploadSampleImages(page, patientHref);
  const storageState = await context.storageState();
  await context.close();
  return {
    storageState,
    paths: {
      login: "/",
      home: "/",
      reception: "/reception",
      schedule: "/reception/schedule",
      receptionPrintBooking: receptionIds.booked ? `/reception/print/${receptionIds.booked}?kind=booking&memo=1` : "/reception",
      receptionPrintVisit: receptionIds.visit ? `/reception/print/${receptionIds.visit}?kind=visit` : "/reception",
      receptionDisplay: "/reception/display",
      patient: patientHref,
      images: `${patientHref}/images`,
      editor: encounterPath,
      finalized: billingIds[2] ? `/encounters/${billingIds[2]}` : encounterPath,
      exam: `${encounterPath}/exam`,
      optical: `${encounterPath}/optical`,
      document: documentPath,
      documentPrint: `${documentPath}/print`,
      encounterPrint: `${encounterPath}/print`,
      billing: "/billing",
      settings: "/settings",
      settingsUsers: "/settings#users",
      settingsSets: "/settings#sets",
      settingsPhrases: "/settings#phrases",
      settingsDrugs: "/settings#drugs",
      settingsExport: "/settings#export",
      settingsAudit: "/settings#audit"
    }
  };
}

// ---- replicate-2（受付）の撮影用データ: 患者マーク・受付のラベルと場所・診察待の番号。予約票・受付票の受付 ID を返す ----
async function seedReceptionRep2(page) {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const { appointments } = await apiCall(page, "GET", `/v1/eye/appointments?date=${today}`);
  const booked = appointments.find((item) => item.status === "booked" && item.patientId);
  const arrived = appointments.filter((item) => item.queueNumber && item.patientId && !["cancelled", "done"].includes(item.status));
  const marked = [...new Set(appointments.filter((item) => item.patientId).map((item) => item.patientId))].slice(0, 3);
  const sets = [["wheelchair", "hearing"], ["caution"], ["child", "documents"]];
  for (const [index, patientId] of marked.entries()) {
    await apiCall(page, "PUT", `/v1/eye/patients/${patientId}/marks`, { expectedRevision: 0, marks: sets[index] }).catch(() => null);
  }
  if (booked) await apiCall(page, "PATCH", `/v1/eye/appointments/${booked.appointmentId}/reception`, { expectedRevision: booked.revision, receptionLabels: ["紹介状あり"] }).catch(() => null);
  const visit = arrived[0];
  if (visit) {
    const moved = await apiCall(page, "POST", `/v1/eye/appointments/${visit.appointmentId}/status`, { expectedRevision: visit.revision, status: "checked_in" }).catch(() => null);
    const current = moved?.appointment || visit;
    await apiCall(page, "PATCH", `/v1/eye/appointments/${visit.appointmentId}/reception`, { expectedRevision: current.revision, location: "darkroom", receptionLabels: ["散瞳予定"] }).catch(() => null);
  }
  for (const item of arrived.slice(1, 3)) {
    await apiCall(page, "POST", `/v1/eye/appointments/${item.appointmentId}/status`, { expectedRevision: item.revision, status: "waiting_doctor" }).catch(() => null);
  }
  return { booked: booked?.appointmentId || "", visit: visit?.appointmentId || "" };
}

// 画面の中から eye-api を呼ぶ（ログインの Cookie と CSRF をそのまま使う）。
async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )halunasu_csrf=([^;]*)/u) || [])[1] || "");
    const response = await fetch(`/api/eye${path}`, { method, credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${JSON.stringify(payload).slice(0, 200)}`);
    return payload;
  }, { method, path, body });
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
    // 受付（会計待・会計済）も作って、受付番号と受付状態の列を埋める
    for (const [index, status] of [[0, "checkout"], [1, "checkout"], [2, "done"]]) {
      const { appointment } = await call("POST", "/v1/eye/appointments", { date: today, patientId: ids[index].patientId, walkIn: true });
      const arrived = appointment.status === "booked" ? (await call("POST", `/v1/eye/appointments/${appointment.appointmentId}/status`, { expectedRevision: appointment.revision, status: "checked_in" })).appointment : appointment;
      await call("POST", `/v1/eye/appointments/${arrived.appointmentId}/status`, { expectedRevision: arrived.revision, status });
    }
    const [, , done, resend, amending] = ids;
    await call("POST", "/v1/eye/billing/handoffs", { date: today, encounterIds: [done.encounterId, resend.encounterId, amending.encounterId] });
    const amended = await call("POST", `/v1/eye/encounters/${resend.encounterId}/amend`, { expectedRevision: resend.revision, reason: "点眼薬の変更" });
    const content = { ...amended.encounter.content, prescriptions: [drop("チモロールマレイン酸塩点眼液0.5%", 2, 2)] };
    const patched = await call("PATCH", `/v1/eye/encounters/${resend.encounterId}`, { expectedRevision: amended.encounter.revision, content });
    await call("POST", `/v1/eye/encounters/${resend.encounterId}/finalize`, { expectedRevision: patched.encounter.revision });
    await call("POST", `/v1/eye/encounters/${amending.encounterId}/amend`, { expectedRevision: amending.revision, reason: "処方日数の訂正" });
    return ids.map((item) => item.encounterId);
  });
  if (result.length !== 5) throw new Error("billing seed failed");
  return result;
}

// 設定の撮影用: 医療機関情報、セットのフォルダ（入れ子）とセット。
async function seedSettings(page) {
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )halunasu_csrf=([^;]*)/u) || [])[1] || "");
    const call = async (method, path, body) => {
      const response = await fetch(`/api/eye${path}`, { method, credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${JSON.stringify(payload).slice(0, 200)}`);
      return payload;
    };
    const current = await call("GET", "/v1/eye/facility-settings");
    await call("PUT", "/v1/eye/facility-settings", { expectedRevision: current.facilitySettings.revision, name: "医療法人 はるなす会 はるなす眼科クリニック", postalCode: "100-0001", address: "東京都千代田区千代田1-1 はるなすビル2階", phone: "03-1234-5678", fax: "03-1234-5679", founder: "医療法人 はるなす会", administrator: "春那 一郎" });
    const glaucoma = (await call("POST", "/v1/eye/set-folders", { name: "緑内障", sortOrder: 0 })).setFolder;
    const drops = (await call("POST", "/v1/eye/set-folders", { name: "点眼", parentId: glaucoma.folderId, sortOrder: 0 })).setFolder;
    await call("POST", "/v1/eye/set-folders", { name: "白内障", sortOrder: 1 });
    const drop = (name, timesPerDay) => ({ kind: "eye_drop", name, eye: "ou", timesPerDay, quantity: 1, unit: "本", route: "outside" });
    await call("POST", "/v1/eye/order-sets", { name: "緑内障 初回", folderId: drops.folderId, sortOrder: 0, diagnoses: [{ name: "原発開放隅角緑内障", eye: "ou" }], prescriptions: [drop("ラタノプロスト点眼液0.005%", 1)], orders: [{ code: "iop", name: "眼圧検査", kind: "exam", eye: "ou" }] });
    await call("POST", "/v1/eye/order-sets", { name: "緑内障 定期 3か月", folderId: drops.folderId, sortOrder: 1, findingsText: "視野 安定", orders: [{ code: "va", name: "視力検査", kind: "exam", eye: "ou" }, { code: "iop", name: "眼圧検査", kind: "exam", eye: "ou" }] });
    await call("POST", "/v1/eye/order-sets", { name: "視野検査", folderId: glaucoma.folderId, orders: [{ code: "va", name: "視力検査", kind: "exam", eye: "ou" }] });
  });
}

// デモ患者にはファイルがないので、画像の比較を撮るために OCT 2 件と眼底写真 1 件を取り込む。
async function uploadSampleImages(page, patientHref) {
  const dir = join(outDir, "fixtures");
  mkdirSync(dir, { recursive: true });
  const samples = [
    { name: "oct-old.png", hue: 0, kind: "oct", eye: "od", daysAgo: 120, title: "OCT 黄斑 右" },
    { name: "oct-new.png", hue: 1, kind: "oct", eye: "od", daysAgo: 21, title: "OCT 黄斑 右" },
    { name: "oct-new-l.png", hue: 2, kind: "oct", eye: "os", daysAgo: 21, title: "OCT 黄斑 左" },
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
    if (!metrics.innerWidth) { console.log(`${tag.padEnd(26)} ${metrics.setupError || "no metrics"}`); continue; }
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
