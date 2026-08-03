import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "../extension");
const fixtureHtml = await readFile(path.join(here, "fixtures/patient-1006.html"), "utf8");
const locationHref = "http://localhost:8899/homic/?pid=patient_detail&patient_id=1006";
const RECORD_KEY_SEPARATOR = "\u001f";
let browser;

function recordKey(patientId, serviceDate, displayedChartId, receptionTime) {
  return [
    "homis-visible-record-v1",
    "homis",
    patientId,
    serviceDate,
    displayedChartId,
    receptionTime
  ].join(RECORD_KEY_SEPARATOR);
}

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("homis-mock-v6 derives the record key only from visible chart fields", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    const { sourceSurfaces: _sourceSurfaces, ...value } = globalThis.HalunasuSidecarContract.extractContractSnapshot(document, {
      locationHref: href
    });
    return value;
  }, locationHref);
  assert.deepEqual(result, {
    externalPatientId: "1006",
    sourceRecordId: recordKey("1006", "2026-06-24", "10060624", "14:00"),
    sourceRecordDisplayId: "10060624",
    serviceDate: "2026-06-24",
    receptionTime: "14:00",
    clinicalText: [
      "S）疼痛は前回と同程度。夜間の突出痛が1回あり、レスキューを使用した。",
      "O）BP 118/68、SpO2 95%（在宅酸素2L/分）。呼吸状態は安定。",
      "A）進行肺癌に伴うがん性疼痛。在宅酸素療法を継続。",
      "P）オピオイドを継続し、疼痛管理について本人と家族へ説明した。"
    ].join("\n"),
    encounterType: "home_visit",
    encounterTypeLabel: "定期",
    encounterTypeSource: "dom",
    visitKind: null,
    visitKindSource: null,
    facilityResidence: false,
    privateResidence: true,
    singleBuildingPatientCount: null,
    sameBuilding: false,
    sameBuildingSource: "dom",
    selectorContractVersion: "homis-mock-v6",
    requiredElementCount: 7,
    matchedRequiredElementCount: 7,
    clinicalTextNodeCount: 4
  });
  await page.close();
});

test("homis-mock-v6 reads bounded current-chart facts without reading the action list", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    const container = document.querySelector("#pdetail_karte");
    const body = container.querySelector(".karte-body");
    const structured = document.createElement("div");
    structured.className = "structured-fields";

    const care = document.createElement("div");
    care.className = "kaigo-text";
    care.textContent = "要介護5";
    structured.append(care);

    const nurse = document.createElement("div");
    nurse.className = "houkan-box";
    nurse.textContent = "訪問看護 週4回 MCS連携";
    structured.append(nurse);

    const device = document.createElement("div");
    device.className = "device-text";
    device.textContent = "気管切開・複管カニューレ 8.0mm";
    structured.append(device);

    const conditionManagementStatus = document.createElement("div");
    conditionManagementStatus.className = "condition-management-list-status";
    conditionManagementStatus.textContent = "疾病等状態管理一覧: 全件表示";
    structured.append(conditionManagementStatus);

    const prescription = document.createElement("div");
    prescription.className = "shohou-wrap";
    const table = document.createElement("table");
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.textContent = "ラコサミド錠100mg 2錠";
    row.append(cell);
    table.append(row);
    prescription.append(table);
    structured.append(prescription);
    body.append(structured);

    const calendar = document.querySelector("#calendar3");
    const visit = document.createElement("td");
    visit.className = "visit";
    const day = document.createElement("span");
    day.className = "cal-day";
    day.dataset.iso = "2026-06-24";
    visit.append(day);
    calendar.append(visit);

    const actionList = document.createElement("div");
    actionList.id = "action_list";
    actionList.textContent = "DONT_READ_ACTION_SECRET";
    container.append(actionList);

    const value = globalThis.HalunasuSidecarContract.extractContractSnapshot(document, {
      locationHref: href
    });
    conditionManagementStatus.remove();
    const withoutCompletenessMarker = globalThis.HalunasuSidecarContract.extractContractSnapshot(
      document,
      { locationHref: href }
    );
    return {
      version: value.selectorContractVersion,
      currentChart: value.sourceSurfaces.currentChart,
      withoutCompletenessMarker: withoutCompletenessMarker.sourceSurfaces.currentChart
        .raw.deviceManagementListCompleteness,
      serialized: JSON.stringify(value)
    };
  }, locationHref);
  assert.equal(result.version, "homis-mock-v6");
  assert.deepEqual(result.currentChart, {
    status: "ok",
    patientId: "1006",
    raw: {
      careInsuranceText: "要介護5",
      visitingNurseText: "訪問看護 週4回 MCS連携",
      deviceManagementText: "気管切開・複管カニューレ 8.0mm",
      deviceManagementListCompleteness: "complete",
      prescriptionRows: ["ラコサミド錠100mg 2錠"],
      patientStartDate: "",
      calendarMonth: "2026-06",
      calendarVisitDates: ["2026-06-24"],
      calendarVisitListCompleteness: "complete"
    }
  });
  assert.equal(result.withoutCompletenessMarker, "unknown");
  assert.doesNotMatch(result.serialized, /DONT_READ_ACTION_SECRET/u);
  await page.close();
});

test("action-list mutation cannot change the extracted calculation request", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const actionList = document.querySelector("#action_list") || document.createElement("div");
    actionList.id = "action_list";
    if (!actionList.isConnected) document.querySelector("#pdetail_karte").append(actionList);
    actionList.textContent = "GOLD_CODE_A 9999点";
    const before = contract.extractContractSnapshot(document, { locationHref: href });
    actionList.textContent = "GOLD_CODE_B 0点 完全に別の正解";
    const after = contract.extractContractSnapshot(document, { locationHref: href });
    return { before, after };
  }, locationHref);
  assert.deepEqual(result.after, result.before);
  await page.close();
});

test("homis-mock-v6 parses the separately fetched documents surface", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="patient-id-line">患者名 1006 / 後期高齢者医療</div>
    <table class="docs-table"><tbody>
      <tr><td>1</td><td>訪問看護指示書</td><td>6/1 - 6/30</td><td>6/1</td><td>作成済</td></tr>
    </tbody></table>
    <div id="action_list">DONT_READ_DOCUMENT_ACTION</div>
  `);
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  const surface = await page.evaluate(() => (
    globalThis.HalunasuSidecarContract.readDocumentsSurface(document, { patientId: "1006" })
  ));
  assert.deepEqual(surface, {
    status: "ok",
    patientId: "1006",
    raw: {
      rows: [{
        kind: "訪問看護指示書",
        period: "6/1 - 6/30",
        writtenDate: "6/1",
        status: "作成済"
      }]
    }
  });
  assert.doesNotMatch(JSON.stringify(surface), /DONT_READ_DOCUMENT_ACTION/u);
  await page.close();
});

test("parses complete problem and typed actual-encounter surfaces without calculation fields", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="patient-id-line">患者名 1006 / 後期高齢者医療</div>
    <div class="problem-list-status">病名一覧: 全件表示</div>
    <table class="problem-list"><tbody>
      <tr><td>1</td><td>膵臓癌 末期（主病）</td><td>2026-04-20</td><td>継続</td></tr>
      <tr><td>2</td><td>肺炎疑い</td><td>2026-06-01</td><td>継続</td></tr>
    </tbody></table>
    <div class="plan-科">在宅診療</div>
    <div class="plan-pattern">2、4週 土</div>
    <div class="plan-dates">
      <span class="plan-chip">6/13(土)</span><span class="plan-chip">6/27(土)</span>
    </div>
    <div class="encounter-history-status">当月受診履歴: 全件表示</div>
    <table class="encounter-history"><tbody>
      <tr>
        <td>2026-06-13</td><td>定期訪問</td><td>完了</td><td>10060613</td>
      </tr>
      <tr>
        <td>2026-06-20</td><td>電話再診</td><td>完了</td><td>10060620</td>
      </tr>
      <tr>
        <td>2026-06-27</td><td>往診</td><td>完了</td><td>10060627</td>
      </tr>
    </tbody></table>
    <div id="action_list">DONT_READ_SUPPLEMENTAL_ACTION</div>
  `);
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  const result = await page.evaluate(() => {
    const contract = globalThis.HalunasuSidecarContract;
    return {
      problems: contract.readProblemsSurface(document, { patientId: "1006" }),
      visitPlan: contract.readVisitPlanSurface(document, {
        patientId: "1006",
        calendarMonth: "2026-06"
      })
    };
  });
  assert.deepEqual(result.problems.raw, {
    rows: [
      { name: "膵臓癌 末期", main: true, startDate: "2026-04-20", outcome: "継続", suspected: false },
      { name: "肺炎疑い", main: false, startDate: "2026-06-01", outcome: "継続", suspected: true }
    ],
    listCompleteness: "complete"
  });
  assert.deepEqual(result.visitPlan.raw, {
    calendarMonth: "2026-06",
    category: "在宅診療",
    patternText: "2、4週 土",
    basis: "encounter_history",
    rows: [
      {
        serviceDate: "2026-06-13", encounterType: "home_visit", visitKind: null,
        status: "completed", sourceRecordId: "10060613"
      },
      {
        serviceDate: "2026-06-20", encounterType: "outpatient", visitKind: "telephone_revisit",
        status: "completed", sourceRecordId: "10060620"
      },
      {
        serviceDate: "2026-06-27", encounterType: "house_call", visitKind: null,
        status: "completed", sourceRecordId: "10060627"
      }
    ],
    listCompleteness: "complete"
  });
  const withoutMarkers = await page.evaluate(() => {
    document.querySelector(".problem-list-status").remove();
    document.querySelector(".encounter-history-status").remove();
    const contract = globalThis.HalunasuSidecarContract;
    return {
      problems: contract.readProblemsSurface(document, { patientId: "1006" }).raw.listCompleteness,
      visitPlan: contract.readVisitPlanSurface(document, {
        patientId: "1006",
        calendarMonth: "2026-06"
      }).raw.listCompleteness
    };
  });
  assert.deepEqual(withoutMarkers, { problems: "incomplete", visitPlan: "incomplete" });
  assert.doesNotMatch(JSON.stringify(result), /DONT_READ_SUPPLEMENTAL_ACTION/u);
  await page.close();
});

test("planned date chips alone remain incomplete selection evidence", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="patient-id-line">患者名 1006 / 後期高齢者医療</div>
    <div class="plan-科">在宅診療</div>
    <div class="plan-pattern">2、4週 土</div>
    <div class="plan-dates"><span class="plan-chip">6/13(土)</span></div>
  `);
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  const surface = await page.evaluate(() => (
    globalThis.HalunasuSidecarContract.readVisitPlanSurface(document, {
      patientId: "1006",
      calendarMonth: "2026-06"
    })
  ));
  assert.equal(surface.raw.basis, "schedule_only");
  assert.equal(surface.raw.listCompleteness, "incomplete");
  assert.equal(surface.raw.rows[0].status, "planned");
  assert.equal(surface.raw.rows[0].sourceRecordId, null);
  await page.close();
});

test("proof sealing covers problem and visit-plan source revisions", async () => {
  const page = await browser.newPage();
  await page.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
  const result = await page.evaluate(async () => (
    globalThis.HalunasuSidecarProof.sealSourceSurfaces({
      problems: { status: "ok", patientId: "1006", raw: { rows: [] } },
      visitPlan: { status: "unavailable", patientId: "1006", unavailableReason: "timeout" }
    }, { observedAt: "2026-08-03T00:00:00.000Z" })
  ));
  assert.deepEqual(Object.keys(result).sort(), ["problems", "visitPlan"]);
  assert.match(result.problems.surfaceHash, /^(?:sha256|fnv1a64)-/u);
  assert.equal(result.visitPlan.unavailableReason, "timeout");
  await page.close();
});

test("encounter type uses only explicit chart status labels and leaves unsupported labels unknown", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const status = document.querySelector(".rec-status");
    const read = (label) => {
      status.textContent = `診療記録　${label}　「サンプル在宅クリニック」`;
      const value = contract.extractContractSnapshot(document, { locationHref: href });
      return {
        type: value.encounterType,
        label: value.encounterTypeLabel,
        source: value.encounterTypeSource,
        visitKind: value.visitKind,
        visitKindSource: value.visitKindSource
      };
    };
    return {
      homeVisit: read("定期"),
      houseCall: read("往診"),
      outpatient: read("外来"),
      telephone: read("電話再診"),
      unknown: read("臨時")
    };
  }, locationHref);
  assert.deepEqual(result, {
    homeVisit: { type: "home_visit", label: "定期", source: "dom", visitKind: null, visitKindSource: null },
    houseCall: { type: "house_call", label: "往診", source: "dom", visitKind: null, visitKindSource: null },
    outpatient: { type: "outpatient", label: "外来", source: "dom", visitKind: null, visitKindSource: null },
    telephone: {
      type: "outpatient",
      label: "電話再診",
      source: "dom",
      visitKind: "telephone_revisit",
      visitKindSource: "dom"
    },
    unknown: { type: null, label: "臨時", source: null, visitKind: null, visitKindSource: null }
  });
  await page.close();
});

test("homis-mock-v6 stops when the visible reception time is missing", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    document.querySelector(".karte-date").textContent = "6/24(水)";
    try {
      globalThis.HalunasuSidecarContract.extractContractSnapshot(document, { locationHref: href });
      return null;
    } catch (error) {
      return {
        code: error.code,
        required: error.requiredElementCount,
        matched: error.matchedRequiredElementCount
      };
    }
  }, locationHref);
  assert.deepEqual(result, { code: "selector_contract_mismatch", required: 7, matched: 5 });
  await page.close();
});

test("homis-mock-v6 stops instead of calculating from an empty SOAP", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    document.querySelectorAll(".note-soap p:not(.karte-date)").forEach((node) => node.remove());
    try {
      globalThis.HalunasuSidecarContract.extractContractSnapshot(document, { locationHref: href });
      return null;
    } catch (error) {
      return { code: error.code, matched: error.matchedRequiredElementCount };
    }
  }, locationHref);
  assert.deepEqual(result, { code: "selector_contract_mismatch", matched: 6 });
  await page.close();
});

test("homis-mock-v6 derives the three-state same-building value from visible text", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const badge = document.querySelector(".patient-header .badge");
    const meta = document.querySelector(".karte-meta .kv");

    badge.className = "badge facility";
    badge.textContent = "施設入居";
    meta.textContent = "カルテID：10060624　単一建物：4";
    const multiple = contract.extractContractSnapshot(document, { locationHref: href });

    meta.textContent = "カルテID：10060624　単一建物：1";
    const one = contract.extractContractSnapshot(document, { locationHref: href });

    badge.remove();
    meta.textContent = "カルテID：10060624";
    const unknown = contract.extractContractSnapshot(document, { locationHref: href });

    return {
      multiple: pick(multiple),
      one: pick(one),
      unknown: pick(unknown)
    };

    function pick(value) {
      return {
        facilityResidence: value.facilityResidence,
        privateResidence: value.privateResidence,
        count: value.singleBuildingPatientCount,
        sameBuilding: value.sameBuilding,
        source: value.sameBuildingSource
      };
    }
  }, locationHref);
  assert.deepEqual(result, {
    multiple: { facilityResidence: true, privateResidence: false, count: 4, sameBuilding: true, source: "dom" },
    one: { facilityResidence: true, privateResidence: false, count: 1, sameBuilding: false, source: "dom" },
    unknown: { facilityResidence: false, privateResidence: false, count: null, sameBuilding: null, source: null }
  });
  await page.close();
});

test("preview fingerprint changes when visible same-building text changes", async () => {
  const page = await contractPage();
  const result = await page.evaluate(async (href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const proof = globalThis.HalunasuSidecarProof;
    const before = contract.extractContractSnapshot(document, { locationHref: href });
    const beforeFingerprint = await proof.previewFingerprint(before);
    document.querySelector(".karte-meta .kv").textContent = "カルテID：10060624　単一建物：4";
    const after = contract.extractContractSnapshot(document, { locationHref: href });
    return beforeFingerprint !== await proof.previewFingerprint(after);
  }, locationHref);
  assert.equal(result, true);
  await page.close();
});

test("preview fingerprint changes when the explicit encounter type changes", async () => {
  const page = await contractPage();
  const result = await page.evaluate(async (href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const proof = globalThis.HalunasuSidecarProof;
    const before = contract.extractContractSnapshot(document, { locationHref: href });
    const beforeFingerprint = await proof.previewFingerprint(before);
    document.querySelector(".rec-status").textContent = "診療記録　往診　「サンプル在宅クリニック」";
    const after = contract.extractContractSnapshot(document, { locationHref: href });
    return beforeFingerprint !== await proof.previewFingerprint(after);
  }, locationHref);
  assert.equal(result, true);
  await page.close();
});

test("preview fingerprint changes between in-person and telephone outpatient visits", async () => {
  const page = await contractPage();
  const result = await page.evaluate(async (href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const proof = globalThis.HalunasuSidecarProof;
    document.querySelector(".rec-status").textContent = "診療記録　外来　「サンプル在宅クリニック」";
    const inPerson = contract.extractContractSnapshot(document, { locationHref: href });
    const inPersonFingerprint = await proof.previewFingerprint(inPerson);
    document.querySelector(".rec-status").textContent = "診療記録　電話再診　「サンプル在宅クリニック」";
    const telephone = contract.extractContractSnapshot(document, { locationHref: href });
    return inPersonFingerprint !== await proof.previewFingerprint(telephone);
  }, locationHref);
  assert.equal(result, true);
  await page.close();
});

test("identity and preview proof reject a patient or chart switch", async () => {
  const page = await contractPage();
  const result = await page.evaluate(async (href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const proof = globalThis.HalunasuSidecarProof;
    const first = contract.extractContractSnapshot(document, { locationHref: href });
    const firstFingerprint = await proof.previewFingerprint(first);
    document.querySelector(".karte-meta .kv").textContent = "カルテID：10060625";
    document.querySelector(".karte-date").textContent = "6/25(木)　14:00～";
    document.querySelector(".note-soap p:not(.karte-date)").textContent = "変更後のカルテ本文";
    const second = contract.extractContractSnapshot(document, { locationHref: href });
    return {
      sameIdentity: proof.sameIdentity(
        { patientId: first.externalPatientId, sourceRecordId: first.sourceRecordId },
        { patientId: second.externalPatientId, sourceRecordId: second.sourceRecordId }
      ),
      samePreview: firstFingerprint === await proof.previewFingerprint(second)
    };
  }, locationHref);
  assert.deepEqual(result, { sameIdentity: false, samePreview: false });
  await page.close();
});

test("body edits keep the record key but change the preview revision", async () => {
  const page = await contractPage();
  const result = await page.evaluate(async (href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const proof = globalThis.HalunasuSidecarProof;
    const before = contract.extractContractSnapshot(document, { locationHref: href });
    const beforeFingerprint = await proof.previewFingerprint(before);
    document.querySelector(".note-soap p:not(.karte-date)").textContent = "編集後のカルテ本文";
    const after = contract.extractContractSnapshot(document, { locationHref: href });
    return {
      sameRecordKey: before.sourceRecordId === after.sourceRecordId,
      samePreview: beforeFingerprint === await proof.previewFingerprint(after)
    };
  }, locationHref);
  assert.deepEqual(result, { sameRecordKey: true, samePreview: false });
  await page.close();
});

test("the visible record key distinguishes the same month and day in another year", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const before = contract.extractContractSnapshot(document, { locationHref: href });
    document.querySelector(".cal-title").textContent = "2027年6月";
    const after = contract.extractContractSnapshot(document, { locationHref: href });
    return {
      beforeDate: before.serviceDate,
      afterDate: after.serviceDate,
      sameRecordKey: before.sourceRecordId === after.sourceRecordId
    };
  }, locationHref);
  assert.deepEqual(result, {
    beforeDate: "2026-06-24",
    afterDate: "2027-06-24",
    sameRecordKey: false
  });
  await page.close();
});

test("content monitoring announces the initial chart and one debounced event after a DOM chart switch", async () => {
  const page = await browser.newPage();
  await page.route("http://localhost:8899/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: fixtureHtml
  }));
  await page.goto(locationHref);
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  await page.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
  await page.evaluate(() => {
    globalThis.__sidecarMessages = [];
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message) {
          globalThis.__sidecarMessages.push(message);
          return Promise.resolve();
        }
      }
    };
  });
  await page.addScriptTag({ path: path.join(extensionDir, "content.js") });
  await page.waitForTimeout(260);

  await page.evaluate(() => {
    const container = document.querySelector("#pdetail_karte");
    container.querySelector(".karte-meta .kv").textContent = "カルテID：10060625";
    container.querySelector(".karte-date").textContent = "6/25(木)　14:00～";
    container.querySelector(".rec-status").textContent = "診療記録　往診　「サンプル在宅クリニック」";
    container.querySelector(".note-soap p:not(.karte-date)").textContent = "切替後のカルテ本文";
  });
  await page.waitForTimeout(280);

  const messages = await page.evaluate(() => globalThis.__sidecarMessages);
  assert.deepEqual(messages, [
    {
      type: "halunasu:chart-state-changed",
      available: true,
      patientId: "1006",
      sourceRecordId: recordKey("1006", "2026-06-24", "10060624", "14:00")
    },
    {
      type: "halunasu:chart-state-changed",
      available: true,
      patientId: "1006",
      sourceRecordId: recordKey("1006", "2026-06-25", "10060625", "14:00")
    }
  ]);
  await page.close();
});

test("a temporarily missing reception time retries and emits only the complete v6 record key", async () => {
  const page = await browser.newPage();
  await page.route("http://localhost:8899/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: fixtureHtml
  }));
  await page.goto(locationHref);
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  await page.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
  await page.evaluate(() => {
    document.querySelector(".karte-date").textContent = "6/24(水)";
    globalThis.__sidecarMessages = [];
    globalThis.__sidecarListener = null;
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener(listener) {
            globalThis.__sidecarListener = listener;
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
  const response = await page.evaluate(() => new Promise((resolve) => {
    setTimeout(() => {
      document.querySelector(".karte-date").textContent = "6/24(水)　14:00～";
    }, 20);
    globalThis.__sidecarListener({ type: "halunasu:extract" }, {}, resolve);
  }));

  assert.equal(response.ok, true);
  assert.equal(
    response.sourceRecordId,
    recordKey("1006", "2026-06-24", "10060624", "14:00")
  );
  assert.match(response.sourceRecordId, /\u001f14:00$/u);
  await page.close();
});

async function contractPage() {
  const page = await browser.newPage();
  await page.setContent(fixtureHtml);
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  await page.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
  return page;
}
