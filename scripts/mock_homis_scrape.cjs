const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const baseUrl = process.argv[2] || "http://127.0.0.1:8899/homic/";
const outDir = process.argv[3] || "tmp/dataset_recalculation_diff_diagnosis/mock_homis_screen_scrape";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeCsv(file, headers, rows) {
  ensureDir(path.dirname(file));
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function writeJsonl(file, rows) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function clean(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractPatientList(page) {
  await page.goto(`${baseUrl}?pid=top_patients`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table.patient-list tbody tr");
  return page.evaluate(() => Array.from(document.querySelectorAll("table.patient-list tbody tr")).map((row) => {
    const cells = Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent.trim());
    const href = row.querySelector("a[href*='patient_id=']")?.getAttribute("href") || "";
    const patientId = new URL(href, window.location.href).searchParams.get("patient_id") || cells[0] || "";
    return {
      patient_id: patientId,
      display_name: cells[1] || "",
      kana: cells[2] || "",
      sex: cells[3] || "",
      age_text: cells[4] || "",
      location_type: cells[5] || "",
      address: cells[6] || "",
      href
    };
  }));
}

async function extractBasic(page, patientId) {
  await page.goto(`${baseUrl}?pid=patient_detail&patient_id=${encodeURIComponent(patientId)}&tab=p1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#grid");
  return page.evaluate(() => {
    const tableToObject = (selector) => Object.fromEntries(Array.from(document.querySelectorAll(`${selector} tbody tr`)).map((row) => {
      const cells = Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent.trim());
      return [cells[0] || "", cells[1] || ""];
    }).filter(([key]) => key));
    return {
      basic_table: tableToObject(".basic-table"),
      visit_address_table: tableToObject(".vaddr-table"),
      raw_text: document.querySelector("#grid")?.innerText.trim() || ""
    };
  });
}

async function extractProblems(page, patientId) {
  await page.goto(`${baseUrl}?pid=patient_problem&patient_id=${encodeURIComponent(patientId)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table.problem-list");
  return page.evaluate(() => Array.from(document.querySelectorAll("table.problem-list tbody tr")).map((row) => {
    const cells = Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent.trim());
    return {
      no: cells[0] || "",
      name: (cells[1] || "").replace("（主病）", ""),
      is_primary: (cells[1] || "").includes("（主病）"),
      since: cells[2] || "",
      outcome: cells[3] || ""
    };
  }).filter((row) => row.name));
}

async function extractDocs(page, patientId) {
  await page.goto(`${baseUrl}?pid=docs_index&patient_id=${encodeURIComponent(patientId)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table.docs-table");
  return page.evaluate(() => Array.from(document.querySelectorAll("table.docs-table tbody tr")).map((row) => {
    const cells = Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent.trim());
    if (cells.length === 1 || /登録書類なし/.test(cells.join(" "))) {
      return null;
    }
    return {
      no: cells[0] || "",
      kind: cells[1] || "",
      period: cells[2] || "",
      written: cells[3] || "",
      status: cells[4] || ""
    };
  }).filter(Boolean));
}

async function extractPlan(page, patientId) {
  await page.goto(`${baseUrl}?pid=patient_plan0&patient_id=${encodeURIComponent(patientId)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#grid");
  return page.evaluate(() => ({
    pattern: document.querySelector(".plan-pattern")?.textContent.trim() || "",
    scheduled_dates: Array.from(document.querySelectorAll(".plan-chip")).map((item) => item.textContent.trim()),
    raw_text: document.querySelector("#grid")?.innerText.trim() || ""
  }));
}

async function extractVisits(page, patientId) {
  await page.goto(`${baseUrl}?pid=patient_detail&patient_id=${encodeURIComponent(patientId)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pdetail_karte");
  const dates = await page.evaluate(() => Array.isArray(window.KARTE_DATES) ? window.KARTE_DATES : []);
  const visits = [];
  for (const serviceDate of dates) {
    await page.evaluate((iso) => window.karteJump?.(iso), serviceDate);
    await page.waitForTimeout(20);
    const visit = await page.evaluate(() => {
      const textList = (selector) => Array.from(document.querySelectorAll(selector)).map((item) => item.textContent.trim()).filter(Boolean);
      const tableRows = (selector) => Array.from(document.querySelectorAll(`${selector} tr`)).map((row) => Array.from(row.querySelectorAll("td,th")).map((cell) => cell.textContent.trim()).filter(Boolean)).filter((row) => row.length);
      return {
        record_status: document.querySelector(".rec-status")?.textContent.trim() || "",
        karte_meta: document.querySelector(".karte-meta")?.textContent.trim() || "",
        date_line: document.querySelector(".karte-date")?.textContent.trim() || "",
        soap_text: document.querySelector(".note-soap")?.innerText.trim() || "",
        care_text: document.querySelector(".kaigo-text")?.innerText.trim() || "",
        visiting_nurse_text: document.querySelector(".houkan-box")?.innerText.trim() || "",
        disability_text: document.querySelector(".shougai-text")?.innerText.trim() || "",
        device_text: document.querySelector(".device-text")?.innerText.trim() || "",
        prescriptions: tableRows(".shohou-table"),
        action_list: textList("#action_list .koui-item"),
        raw_pdetail_text: document.querySelector("#pdetail_karte")?.innerText.trim() || ""
      };
    });
    visits.push({ service_date: serviceDate, ...visit });
  }
  return visits;
}

(async () => {
  ensureDir(outDir);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const unknowns = [];
  const summary = {
    source: "screen_scrape",
    baseUrl,
    collectedAt: new Date().toISOString(),
    patientCount: 0,
    visitCount: 0,
    actionCount: 0
  };

  try {
    await page.goto(`${baseUrl.replace(/\/$/, "")}/login.php`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="id"]', "demo").catch(() => {});
    await page.fill('input[name="pw"]', "demo").catch(() => {});
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
      page.click('button[type="submit"]').catch(() => {})
    ]);

    const patients = await extractPatientList(page);
    summary.patientCount = patients.length;
    writeJson(path.join(outDir, "patient_list.json"), patients);

    const allVisits = [];
    const allActions = [];
    for (const patient of patients) {
      const patientDir = path.join(outDir, "patients", patient.patient_id);
      ensureDir(patientDir);
      const basic = await extractBasic(page, patient.patient_id);
      const problems = await extractProblems(page, patient.patient_id);
      const docs = await extractDocs(page, patient.patient_id);
      const plan = await extractPlan(page, patient.patient_id);
      const visits = await extractVisits(page, patient.patient_id);
      const record = { patient, basic, problems, docs, plan, visits };
      writeJson(path.join(patientDir, "screen_scrape.json"), record);
      writeJsonl(path.join(patientDir, "screen_scrape_visits.jsonl"), visits);
      const patientActions = visits.flatMap((visit) => (visit.action_list || []).map((actionName, index) => ({
        patient_id: patient.patient_id,
        service_date: visit.service_date,
        claim_month: visit.service_date.slice(0, 7),
        action_index: index + 1,
        action_name: actionName,
        source: "screen:#action_list"
      })));
      writeCsv(path.join(patientDir, "screen_scrape_actions.csv"), ["patient_id", "service_date", "claim_month", "action_index", "action_name", "source"], patientActions);
      allVisits.push(...visits.map((visit) => ({ patient_id: patient.patient_id, ...visit })));
      allActions.push(...patientActions);
    }

    summary.visitCount = allVisits.length;
    summary.actionCount = allActions.length;
    writeJsonl(path.join(outDir, "screen_scrape_visits.jsonl"), allVisits);
    writeCsv(path.join(outDir, "screen_scrape_actions.csv"), ["patient_id", "service_date", "claim_month", "action_index", "action_name", "source"], allActions);

    unknowns.push("screen:#action_list は名称のみで、診療行為コード・薬剤コード・材料コード・点数はDOM上に表示されていません。");
    unknowns.push("screen:処方欄は表示テキストとして取得しましたが、薬剤コード・用量単位・日数を標準化できる構造化フィールドはDOM上にありません。");
    unknowns.push("screen:病名一覧は開始日付きプロブレムであり、各訪問日の病名として確定できるサービス日別情報はDOM上にありません。");
    unknowns.push("screen:書類の期間・記入日は取得できますが、文書本文そのものはDOM上にありません。");
    fs.writeFileSync(path.join(outDir, "unknowns.md"), `# Screen scrape unknowns\n\n${unknowns.map((item) => `- ${item}`).join("\n")}\n`, "utf8");
    writeJson(path.join(outDir, "summary.json"), summary);
  } finally {
    await browser.close();
  }
})();
