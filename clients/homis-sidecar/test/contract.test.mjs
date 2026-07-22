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
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("homis-mock-v3 extracts the complete displayed chart and residence determinant", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => (
    globalThis.HalunasuSidecarContract.extractContractSnapshot(document, { locationHref: href })
  ), locationHref);
  assert.deepEqual(result, {
    externalPatientId: "1006",
    sourceRecordId: "1006-20260624-01",
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
    facilityResidence: false,
    privateResidence: true,
    singleBuildingPatientCount: null,
    sameBuilding: false,
    sameBuildingSource: "dom",
    selectorContractVersion: "homis-mock-v3",
    requiredElementCount: 5,
    matchedRequiredElementCount: 5,
    clinicalTextNodeCount: 4
  });
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
        source: value.encounterTypeSource
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
    homeVisit: { type: "home_visit", label: "定期", source: "dom" },
    houseCall: { type: "house_call", label: "往診", source: "dom" },
    outpatient: { type: "outpatient", label: "外来", source: "dom" },
    telephone: { type: null, label: "電話再診", source: null },
    unknown: { type: null, label: "臨時", source: null }
  });
  await page.close();
});

test("homis-mock-v3 stops when the immutable record id is missing", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    document.querySelector("#pdetail_karte").removeAttribute("data-record-id");
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
  assert.deepEqual(result, { code: "selector_contract_mismatch", required: 5, matched: 4 });
  await page.close();
});

test("homis-mock-v3 stops instead of calculating from an empty SOAP", async () => {
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
  assert.deepEqual(result, { code: "selector_contract_mismatch", matched: 4 });
  await page.close();
});

test("homis-mock-v3 derives the three-state same-building value without guessing", async () => {
  const page = await contractPage();
  const result = await page.evaluate((href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const badge = document.querySelector(".patient-header .badge");
    const container = document.querySelector("#pdetail_karte");

    badge.className = "badge facility";
    badge.textContent = "施設入居";
    container.setAttribute("data-single-building-patient-count", "4");
    const multiple = contract.extractContractSnapshot(document, { locationHref: href });

    container.setAttribute("data-single-building-patient-count", "1");
    const one = contract.extractContractSnapshot(document, { locationHref: href });

    badge.remove();
    container.removeAttribute("data-single-building-patient-count");
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

test("preview fingerprint changes when same-building determinant metadata changes", async () => {
  const page = await contractPage();
  const result = await page.evaluate(async (href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const proof = globalThis.HalunasuSidecarProof;
    const container = document.querySelector("#pdetail_karte");
    const before = contract.extractContractSnapshot(document, { locationHref: href });
    const beforeFingerprint = await proof.previewFingerprint(before);
    container.setAttribute("data-single-building-patient-count", "4");
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

test("identity and preview proof reject a patient or chart switch", async () => {
  const page = await contractPage();
  const result = await page.evaluate(async (href) => {
    const contract = globalThis.HalunasuSidecarContract;
    const proof = globalThis.HalunasuSidecarProof;
    const first = contract.extractContractSnapshot(document, { locationHref: href });
    const firstFingerprint = await proof.previewFingerprint(first);
    document.querySelector("#pdetail_karte").setAttribute("data-record-id", "1006-20260624-02");
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
    container.setAttribute("data-record-id", "1006-20260625-01");
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
      sourceRecordId: "1006-20260624-01"
    },
    {
      type: "halunasu:chart-state-changed",
      available: true,
      patientId: "1006",
      sourceRecordId: "1006-20260625-01"
    }
  ]);
  await page.close();
});

async function contractPage() {
  const page = await browser.newPage();
  await page.setContent(fixtureHtml);
  await page.addScriptTag({ path: path.join(extensionDir, "lib/contract.js") });
  await page.addScriptTag({ path: path.join(extensionDir, "lib/proof.js") });
  return page;
}
