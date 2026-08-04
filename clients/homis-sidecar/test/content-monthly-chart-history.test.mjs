import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "../extension");
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("prepare crawls visible chart controls, reconciles the month, and restores the preview", async () => {
  const page = await contentPage({
    records: [
      encounter("2026-08-01", "09:30", "定期"),
      encounter("2026-07-25", "09:00", "往診"),
      encounter("2026-07-18", "10:30", "電話再診"),
      encounter("2026-07-04", "14:00", "定期"),
      encounter("2026-06-28", "11:00", "定期")
    ],
    initialIndex: 2,
    calendarDates: ["2026-07-04", "2026-07-18", "2026-07-25"]
  });

  const preview = await callContentScript(page, { type: "halunasu:extract" });
  assert.equal(preview.ok, true);
  assert.equal(preview.sourceRecordDisplayId, "90010718");
  await page.evaluate(() => { globalThis.__sidecarMessages = []; });

  const prepared = await callContentScript(page, {
    type: "halunasu:prepare-calculation",
    previewFingerprint: preview.previewFingerprint
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.previewFingerprint, preview.previewFingerprint);
  assert.equal(prepared.sourceRecordDisplayId, "90010718");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.basis, "encounter_history");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.listCompleteness, "complete");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.collectionMethod, "chart_navigation");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.traversalComplete, true);
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.calendarReconciled, true);
  assert.equal(
    prepared.sourceSurfaces.visitPlan.raw.originalSourceRecordId,
    prepared.sourceRecordId
  );
  assert.equal(
    prepared.sourceSurfaces.visitPlan.raw.restoredSourceRecordId,
    prepared.sourceRecordId
  );
  assert.deepEqual(
    prepared.sourceSurfaces.visitPlan.raw.rows.map((row) => ({
      date: row.serviceDate,
      type: row.encounterType,
      kind: row.visitKind,
      status: row.status,
      displayId: row.sourceRecordId.split("\u001f")[4]
    })),
    [
      { date: "2026-07-04", type: "home_visit", kind: null, status: "completed", displayId: "90010704" },
      { date: "2026-07-18", type: "outpatient", kind: "telephone_revisit", status: "completed", displayId: "90010718" },
      { date: "2026-07-25", type: "house_call", kind: null, status: "completed", displayId: "90010725" }
    ]
  );

  await page.waitForTimeout(240);
  const state = await page.evaluate(() => ({
    displayedId: document.querySelector(".karte-meta .kv")?.textContent,
    actionSelectorRead: globalThis.__actionSelectorRead,
    messages: globalThis.__sidecarMessages
  }));
  assert.match(state.displayedId, /90010718/u);
  assert.equal(state.actionSelectorRead, false);
  assert.ok(state.messages.every((message) => (
    message.type !== "halunasu:chart-state-changed"
    || message.sourceRecordId === prepared.sourceRecordId
  )));
  await page.close();
});

test("an unknown encounter type fails closed and still restores the original chart", async () => {
  const page = await contentPage({
    records: [
      encounter("2026-08-01", "09:30", "定期"),
      encounter("2026-07-25", "09:00", "定期"),
      encounter("2026-07-18", "10:30", "未分類"),
      encounter("2026-06-28", "11:00", "定期")
    ],
    initialIndex: 1,
    calendarDates: ["2026-07-18", "2026-07-25"]
  });
  const preview = await callContentScript(page, { type: "halunasu:extract" });
  const prepared = await callContentScript(page, {
    type: "halunasu:prepare-calculation",
    previewFingerprint: preview.previewFingerprint
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.sourceRecordDisplayId, "90010725");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.basis, "schedule_only");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.listCompleteness, "incomplete");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.collectionMethod, undefined);
  assert.match(
    await page.locator(".karte-meta .kv").textContent(),
    /90010725/u
  );
  await page.close();
});

test("two distinct visible records on the same day remain incomplete", async () => {
  const page = await contentPage({
    records: [
      encounter("2026-08-01", "09:30", "定期"),
      encounter("2026-07-25", "09:00", "定期"),
      encounter("2026-07-25", "15:00", "往診"),
      encounter("2026-06-28", "11:00", "定期")
    ],
    initialIndex: 1,
    calendarDates: ["2026-07-25"]
  });
  const preview = await callContentScript(page, { type: "halunasu:extract" });
  const prepared = await callContentScript(page, {
    type: "halunasu:prepare-calculation",
    previewFingerprint: preview.previewFingerprint
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.receptionTime, "09:00");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.basis, "schedule_only");
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.listCompleteness, "incomplete");
  assert.match(await page.locator(".karte-date").textContent(), /09:00/u);
  await page.close();
});

test("January traversal assigns the previous calendar year to December records", async () => {
  const page = await contentPage({
    records: [
      encounter("2025-02-01", "09:30", "定期"),
      encounter("2025-01-25", "09:00", "定期"),
      encounter("2025-01-11", "10:30", "定期"),
      encounter("2024-12-28", "11:00", "定期")
    ],
    initialIndex: 1,
    calendarMonth: "2025-01",
    calendarDates: ["2025-01-11", "2025-01-25"]
  });
  const preview = await callContentScript(page, { type: "halunasu:extract" });
  const prepared = await callContentScript(page, {
    type: "halunasu:prepare-calculation",
    previewFingerprint: preview.previewFingerprint
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.listCompleteness, "complete");
  assert.deepEqual(
    prepared.sourceSurfaces.visitPlan.raw.rows.map((row) => row.serviceDate),
    ["2025-01-11", "2025-01-25"]
  );
  assert.equal(prepared.sourceRecordDisplayId, "90010125");
  assert.match(await page.locator(".karte-date").textContent(), /1\/25/u);
  await page.close();
});

test("December traversal assigns the next calendar year to January records", async () => {
  const page = await contentPage({
    records: [
      encounter("2026-01-03", "09:30", "定期"),
      encounter("2025-12-27", "09:00", "定期"),
      encounter("2025-12-13", "10:30", "定期"),
      encounter("2025-11-29", "11:00", "定期")
    ],
    initialIndex: 1,
    calendarMonth: "2025-12",
    calendarDates: ["2025-12-13", "2025-12-27"]
  });
  const preview = await callContentScript(page, { type: "halunasu:extract" });
  const prepared = await callContentScript(page, {
    type: "halunasu:prepare-calculation",
    previewFingerprint: preview.previewFingerprint
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.sourceSurfaces.visitPlan.raw.listCompleteness, "complete");
  assert.deepEqual(
    prepared.sourceSurfaces.visitPlan.raw.rows.map((row) => row.serviceDate),
    ["2025-12-13", "2025-12-27"]
  );
  assert.equal(prepared.sourceRecordDisplayId, "90011227");
  assert.match(await page.locator(".karte-date").textContent(), /12\/27/u);
  await page.close();
});

async function contentPage({ records, initialIndex, calendarDates, calendarMonth = "2026-07" }) {
  const page = await browser.newPage();
  await page.route("http://fixture.local/**", async (route) => {
    const url = new URL(route.request().url());
    const pageId = url.searchParams.get("pid") || "patient_detail";
    if (pageId === "docs_index") {
      await route.fulfill({ contentType: "text/html", body: supplementalPage(`
        <table class="docs-table"><tbody></tbody></table>
      `) });
      return;
    }
    if (pageId === "patient_problem") {
      await route.fulfill({ contentType: "text/html", body: supplementalPage(`
        <table class="problem-list"><tbody>
          <tr><td>1</td><td>高血圧症（主病）</td><td>2020-01-01</td><td>継続</td></tr>
        </tbody></table>
      `) });
      return;
    }
    if (pageId === "patient_plan0") {
      await route.fulfill({ contentType: "text/html", body: supplementalPage(`
        <div class="plan-科">在宅診療</div>
        <div class="plan-pattern">月2回</div>
        <div class="plan-dates"><span class="plan-chip">7/25</span></div>
      `) });
      return;
    }
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: detailPage({ records, initialIndex, calendarDates, calendarMonth })
    });
  });
  await page.goto("http://fixture.local/homic/?pid=patient_detail&patient_id=9001", {
    waitUntil: "domcontentloaded"
  });
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  await page.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
  await page.evaluate(() => {
    globalThis.__sidecarMessages = [];
    globalThis.__sidecarContentListener = null;
    globalThis.__actionSelectorRead = false;
    for (const prototype of [Document.prototype, Element.prototype]) {
      for (const method of ["querySelector", "querySelectorAll"]) {
        const original = prototype[method];
        prototype[method] = function guardedSelector(selector) {
          if (/(?:action_list|koui-area|koui-item)/u.test(String(selector))) {
            globalThis.__actionSelectorRead = true;
            throw new Error("the action list is forbidden input");
          }
          return original.call(this, selector);
        };
      }
    }
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener(listener) {
            globalThis.__sidecarContentListener = listener;
          }
        },
        sendMessage(message) {
          globalThis.__sidecarMessages.push(message);
          return Promise.resolve();
        }
      }
    };
  });
  await page.addScriptTag({ path: path.join(extensionDir, "content.js") });
  return page;
}

function detailPage({ records, initialIndex, calendarDates, calendarMonth }) {
  const [calendarYear, calendarMonthNumber] = calendarMonth.split("-").map(Number);
  const visitCells = calendarDates.map((date) => `
    <td class="visit"><span class="cal-day" data-iso="${date}">${Number(date.slice(-2))}</span></td>
  `).join("");
  return `<!doctype html><html lang="ja"><body>
    <div class="patient-header">
      <div class="patient-id-line">患者 テスト　9001 / 後期高齢者医療</div>
      <div class="ph-sub"><span class="badge home">個人宅</span>　診療開始：2020-01-01</div>
    </div>
    <div id="karte-panel">
      <div id="calendar3"><span class="cal-title">${calendarYear}年${calendarMonthNumber}月</span><table><tbody><tr>${visitCells}</tr></tbody></table></div>
      <button class="flip-prev">前のカルテ</button>
      <button class="flip-next">次のカルテ</button>
      <div id="pdetail_karte"></div>
    </div>
    <script>
      (() => {
        const records = ${JSON.stringify(records)};
        let index = ${initialIndex};
        const container = document.querySelector("#pdetail_karte");
        const render = () => {
          const record = records[index];
          const month = Number(record.serviceDate.slice(5, 7));
          const day = Number(record.serviceDate.slice(8, 10));
          const displayId = "9001" + record.serviceDate.slice(5, 7) + record.serviceDate.slice(8, 10);
          container.innerHTML = \`
            <div class="karte-head">
              <div class="rec-status">診療記録　\${record.label}　「サンプル在宅クリニック」</div>
              <div class="karte-meta"><span class="kv">カルテID：\${displayId}</span></div>
            </div>
            <div class="karte-body"><div class="note-soap">
              <p class="karte-date">\${month}/\${day}(土)　\${record.time}～</p>
              <p>S）許可されたSOAP本文</p>
            </div><div class="device-text">（在宅医療機器の登録なし）</div></div>
            <div class="koui-area"><div id="action_list">FORBIDDEN_ANSWER_\${displayId}</div></div>
          \`;
        };
        document.querySelector(".flip-next").addEventListener("click", () => {
          index = Math.max(0, index - 1);
          render();
        });
        document.querySelector(".flip-prev").addEventListener("click", () => {
          index = Math.min(records.length - 1, index + 1);
          render();
        });
        render();
      })();
    </script>
  </body></html>`;
}

function supplementalPage(content) {
  return `<!doctype html><html lang="ja"><body>
    <div class="patient-id-line">患者 テスト　9001 / 後期高齢者医療</div>
    ${content}
  </body></html>`;
}

function encounter(serviceDate, time, label) {
  return { serviceDate, time, label };
}

function callContentScript(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    globalThis.__sidecarContentListener(payload, {}, resolve);
  }), message);
}
