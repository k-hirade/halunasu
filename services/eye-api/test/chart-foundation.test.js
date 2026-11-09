// 段階 1B（カルテ・処方・マスタの土台）: Rp・コメント行、公開マスターの取り込みと検索、コード、学習リスト、
// セットのフォルダとカルテからの作成、警告で止めない確定、確定済みの直接編集、主訴・所見の自由記載。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../packages/auth-client/src/index.js";
import { createSignedSession } from "../../platform-api/src/auth/session.js";
import { MemoryPlatformStore } from "../../platform-api/src/store/memory-store.js";
import { billingCsv, buildBillingEncounter } from "../src/billing.js";
import { aggregateLearning } from "../src/learning.js";
import { decodeShiftJis, findMasterFileUrl, parseCsv, parseMasterText, readZipEntries } from "../src/master-parse.js";
import { createMasterIndex, defaultMasterIndex, normalizeMasterQuery } from "../src/masters.js";
import { handleEyeApiRequest } from "../src/server.js";
import { MemoryBlobStore } from "../src/store/blob-store.js";
import { MemoryEyeStore } from "../src/store/memory-store.js";

const NOW = new Date("2026-11-09T01:00:00.000Z");
const FIXTURES = new URL("./fixtures/masters/", import.meta.url);

function fixtureText(name) {
  return decodeShiftJis(readFileSync(new URL(name, FIXTURES)));
}

function fixtureMasters() {
  return {
    drug: parseMasterText("drug", fixtureText("y_sample.csv"), { today: "20261109" }),
    disease: parseMasterText("disease", fixtureText("b_sample.txt"), { today: "20261109" }),
    modifier: parseMasterText("modifier", fixtureText("z_sample.txt"), { today: "20261109" }),
    procedure: parseMasterText("procedure", fixtureText("s_sample.csv"), { today: "20261109" })
  };
}

// ---- マスターの取り込み ----

test("parses quoted Shift_JIS master CSV rows and keeps only the fields we need", () => {
  assert.deepEqual(parseCsv('"a","b,c","d""e"\r\n"1",,"3"\r\n'), [["a", "b,c", 'd"e'], ["1", "", "3"]]);
  const masters = fixtureMasters();
  const latanoprost = masters.drug.find((item) => item.name.startsWith("キサラタン"));
  assert.equal(latanoprost.kind, "eye_drop");
  assert.equal(latanoprost.eye, true);
  assert.equal(latanoprost.form, "external");
  assert.match(latanoprost.code, /^\d{9}$/u);
  assert.match(latanoprost.kana, /^キサラタン/u, "half-width kana is widened");
  assert.ok(latanoprost.price > 0);
  assert.equal(masters.drug.find((item) => item.name.startsWith("タリビッド眼軟膏")).kind, "eye_ointment");
  const famotidine = masters.drug.find((item) => item.name.startsWith("ガスター"));
  assert.equal(famotidine.kind, "oral");
  assert.equal(famotidine.eye, undefined);
  assert.equal(masters.drug.find((item) => item.name.startsWith("アイリーア")).kind, "injection");

  const glaucoma = masters.disease.find((item) => item.name === "緑内障");
  assert.match(glaucoma.code, /^\d{7}$/u);
  assert.equal(glaucoma.eye, true);
  assert.match(glaucoma.icd10, /^H40/u);
  assert.equal(masters.disease.find((item) => item.name === "高血圧症").eye, undefined);

  assert.equal(masters.modifier.find((item) => item.name === "の疑い").position, "suffix");
  assert.equal(masters.modifier.find((item) => item.name === "右").position, "prefix");

  const fundus = masters.procedure.find((item) => item.name === "精密眼底検査（片）");
  assert.equal(fundus.points, 56);
  assert.equal(fundus.section, "D255");
  assert.equal(fundus.eye, true);
  assert.equal(masters.procedure.find((item) => item.name === "初診料").section, "A000");
});

test("drops abolished master rows and finds the newest file link on the public page", () => {
  const row = (abolished) => `"0","S","160000000","3","テスト行為","4","ﾃｽﾄ","0","0","","3","10.00"${',"0"'.repeat(74)},"20240601","${abolished}"\r\n`;
  assert.equal(parseMasterText("procedure", row("99999999"), { today: "20261109" }).length, 1);
  assert.equal(parseMasterText("procedure", row("20250531"), { today: "20261109" }).length, 0);
  const html = '<a href="kihonmasta_04.files/y_ALL20261013.zip">最新</a><a href="kihonmasta_04.files/y_ALL20260401.zip">前回</a>';
  assert.equal(
    findMasterFileUrl(html, "drug", "https://www.hpdx.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html"),
    "https://www.hpdx.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.files/y_ALL20261013.zip"
  );
});

test("reads stored and deflated zip entries without external tools", () => {
  const zip = buildZip([{ name: "a.txt", data: Buffer.from("stored"), deflate: false }, { name: "b.csv", data: Buffer.from("deflated text ".repeat(20)), deflate: true }]);
  const entries = readZipEntries(zip);
  assert.deepEqual(entries.map((item) => item.name), ["a.txt", "b.csv"]);
  assert.equal(entries[0].data.toString(), "stored");
  assert.equal(entries[1].data.toString(), "deflated text ".repeat(20));
});

// ---- マスターの検索 ----

test("normalizes master queries across kana, width, and case", () => {
  assert.equal(normalizeMasterQuery("らたのぷろすと"), "ラタノプロスト");
  assert.equal(normalizeMasterQuery("ﾗﾀﾉﾌﾟﾛｽﾄ ０．００５％"), "ラタノプロスト0.005%");
  assert.equal(normalizeMasterQuery("ＯＣＴ"), "oct");
});

test("searches masters by prefix first, then by substring, with eye items first", () => {
  const index = createMasterIndex({
    drug: [
      { code: "1", name: "点眼用ラタノ（架空）", kana: "テンガンヨウラタノ", eye: true },
      { code: "2", name: "ラタノ内服（架空）", kana: "ラタノナイフク" },
      { code: "3", name: "ラタノ点眼（架空）", kana: "ラタノテンガン", eye: true },
      { code: "4", name: "キサラタン点眼液", kana: "キサラタンテンガンエキ", generic: "ラタノプロスト点眼液", eye: true }
    ]
  });
  const results = index.search({ type: "drug", q: "らたの" });
  // 前方一致（名称・一般名・カナ）: 眼科の 4・3（短い名称が先）→ 眼科でない 2。部分一致: 1。
  assert.deepEqual(results.map((item) => [item.code, item.match]), [["4", "prefix"], ["3", "prefix"], ["2", "prefix"], ["1", "contains"]]);
  assert.deepEqual(index.search({ type: "drug", q: "らたの", eyeOnly: true }).map((item) => item.code), ["4", "3", "1"]);
  assert.deepEqual(index.search({ type: "drug", q: "らたの 内服" }).map((item) => item.code), ["2"], "every term must match");
  assert.deepEqual(index.search({ type: "drug", q: "  " }), []);
  assert.equal(index.search({ type: "drug", q: "ら", limit: 2 }).length, 2);
});

test("serves the master search API with authentication and validation", async () => {
  const stores = createStores();
  const masterIndex = createMasterIndex(fixtureMasters());
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const viewer = await signedHeaders(stores.platformStore, "viewer");
  const call = (path, headers) => request(stores, "GET", path, undefined, headers, { masterIndex });

  assert.equal((await call("/v1/eye/masters/search?type=drug&q=x")).statusCode, 401);
  const drugs = await call(`/v1/eye/masters/search?type=drug&q=${encodeURIComponent("きさらたん")}`, viewer);
  assert.equal(drugs.statusCode, 200);
  assert.equal(drugs.body.results[0].kind, "eye_drop");
  assert.equal(drugs.body.available, true);
  const diseases = await call(`/v1/eye/masters/search?type=disease&q=${encodeURIComponent("りょくないしょう")}`, doctor);
  assert.ok(diseases.body.results.length >= 2);
  assert.equal(diseases.body.results[0].name, "緑内障", "prefix match comes first");
  const halfWidth = await call(`/v1/eye/masters/search?type=procedure&q=${encodeURIComponent("ｾｲﾐﾂｶﾞﾝﾃｲ")}`, doctor);
  assert.ok(halfWidth.body.results.every((item) => item.name.startsWith("精密眼底")));
  const modifiers = await call(`/v1/eye/masters/search?type=modifier&q=${encodeURIComponent("うたがい")}`, doctor);
  assert.equal(modifiers.body.results[0].name, "の疑い");
  assert.equal((await call("/v1/eye/masters/search?type=other&q=x", doctor)).statusCode, 400);
  assert.equal((await call("/v1/eye/masters/search?type=drug&q=x&limit=31", doctor)).statusCode, 400);
  assert.deepEqual((await call("/v1/eye/masters/search?type=drug&q=", doctor)).body.results, []);
});

test("the committed master data loads and finds ophthalmic drugs", { skip: !defaultMasterIndex().available("drug") }, () => {
  const index = defaultMasterIndex();
  const results = index.search({ type: "drug", q: "らたのぷろすと" });
  assert.ok(results.length >= 10);
  assert.ok(results.slice(0, 5).every((item) => item.eye));
  assert.ok(index.search({ type: "disease", q: "げんぱつかいほうぐうかくりょくないしょう" }).some((item) => item.name === "原発開放隅角緑内障"));
});

// ---- Rp・コメント行・コード（保存・会計・点眼本数） ----

test("stores prescriptions and orders in Rp groups with comment rows and master codes", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09", visitType: "initial" }, doctor);
  const id = draft.body.encounter.encounterId;
  const saved = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, {
    expectedRevision: 1,
    sections: {
      prescriptions: [
        { kind: "eye_drop", name: "キサラタン点眼液0.005%", drugCode: "620008621", rpId: "rp1", eye: "ou", timesPerDay: 1, usage: "就寝前", days: 28, quantity: 1, unit: "本" },
        { kind: "eye_drop", name: "古い点眼（1 剤 1 Rp）", eye: "od", timesPerDay: 4 },
        // 同じ Rp の 2 剤目: 用法・日数などは先頭の薬剤行にそろう。行は Rp ごとにまとまる。
        { kind: "eye_drop", name: "チモプトール点眼液0.5%", rpId: "rp1", eye: "os", timesPerDay: 2, days: 14, quantity: 1, unit: "本" },
        { kind: "comment", rpId: "rp1", text: "後発品への変更不可" },
        { kind: "comment", rpId: "rp1", text: "院内メモ", scope: "chart" }
      ],
      orders: [
        { orderId: "o1", rpId: "orp1", code: "fundus_dilated", procedureCode: "160081130", name: "精密眼底検査（両）", eye: "ou", status: "performed" },
        { orderId: "o2", kind: "comment", rpId: "orp1", text: "両側" }
      ]
    }
  }, doctor);
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  const rows = saved.body.encounter.content.prescriptions;
  assert.deepEqual(rows.map((row) => row.name || row.text), ["キサラタン点眼液0.005%", "チモプトール点眼液0.5%", "後発品への変更不可", "院内メモ", "古い点眼（1 剤 1 Rp）"]);
  assert.equal(rows[1].eye, "ou");
  assert.equal(rows[1].days, 28);
  assert.equal(rows[1].timesPerDay, 1);
  assert.equal(rows[2].scope, "free");
  assert.equal("rpId" in rows[4], false, "legacy rows keep their shape");
  assert.equal(saved.body.encounter.content.orders[1].kind, "comment");
  assert.equal("statusChangedAt" in saved.body.encounter.content.orders[1], false);

  // コメントは Rp に属する必要がある
  const orphan = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 2, sections: { prescriptions: [{ kind: "comment", text: "x" }] } }, doctor);
  assert.equal(orphan.statusCode, 400);
  assert.equal(orphan.body.field, "content.prescriptions.0.rpId");
  const badCode = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 2, sections: { prescriptions: [{ name: "x", drugCode: "12-3" }] } }, doctor);
  assert.equal(badCode.statusCode, 400);

  // 点眼本数の目安: コメント行は対象外、同じ Rp の 2 剤目は共有の日数で計算
  const detail = await request(stores, "GET", `/v1/eye/encounters/${id}`, undefined, doctor);
  assert.deepEqual(detail.body.bottleSuggestions.map((item) => item.applicable), [true, true, false, false, true]);
  assert.equal(detail.body.bottleSuggestions[1].days, 28);

  // 会計: マスターのコードを使い、載せるコメントは Rp の行のあとに。カルテだけのコメントは載せない。
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: 2 }, doctor);
  assert.equal(finalized.statusCode, 200, JSON.stringify(finalized.body));
  const billing = await request(stores, "GET", "/v1/eye/billing/day?date=2026-11-09", undefined, doctor);
  const items = billing.body.encounters[0].items;
  assert.deepEqual(items.map((item) => [item.category, item.code, item.name]), [
    ["検査", "160081130", "精密眼底検査（両）"],
    ["コメント", "", "両側"],
    ["処方", "620008621", "キサラタン点眼液0.005%"],
    ["処方", "", "チモプトール点眼液0.5%"],
    ["コメント", "", "後発品への変更不可"],
    ["処方", "", "古い点眼（1 剤 1 Rp）"]
  ]);
});

test("billing output for legacy content (no Rp, no codes) is unchanged", () => {
  const encounter = {
    encounterId: "eenc_1", encounterDate: "2026-10-27", visitType: "revisit", versionCount: 1,
    patientSnapshot: { displayName: "眼科 太郎" },
    content: {
      orders: [{ orderId: "a", code: "iop", name: "眼圧検査", kind: "exam", eye: "ou", status: "performed" }, { orderId: "b", code: "va", name: "視力検査", status: "planned" }],
      prescriptions: [{ kind: "eye_drop", name: "ラタノプロスト点眼液", presetId: "edp_1", eye: "ou", timesPerDay: 1, quantity: 1, unit: "本", route: "outside", issued: true }, { kind: "oral", name: "", issued: true }]
    }
  };
  const built = buildBillingEncounter(encounter);
  assert.deepEqual(built.items.map((item) => [item.category, item.code]), [["検査", "iop"], ["処方", "edp_1"]]);
  // 段階 1B より前の実装で同じ入力から作った値（連携済みの記録との突き合わせ・CSV の取り直しが変わらないこと）
  assert.equal(built.itemsFingerprint, "7608cd67ba4d1f2fd3275a77fed410a1");
  assert.equal(built.fingerprint, "1721958eff4fabceec89a55a9901598a");
  assert.equal(createHash("sha256").update(billingCsv([built])).digest("hex"), "5da9cefb517f6dc93a25e1edee3aa1e896f763eb1bf72e412fcc826910fd41cc");
});

// ---- 病名のコード・修飾語・疑い・診療科 ----

test("keeps disease codes, modifiers, suspicion, and department; reads the old suspected status as a flag", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const patient = await createPatient(stores, doctor);
  const profile = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 0,
    diagnoses: [
      { name: "緑内障", code: "3659002", eye: "ou", suspected: true, department: "眼科", modifiers: [{ code: "2057", name: "両", position: "prefix" }] },
      { name: "白内障", eye: "od", status: "suspected" }
    ]
  }, doctor);
  assert.equal(profile.statusCode, 200, JSON.stringify(profile.body));
  const [glaucoma, cataract] = profile.body.profile.diagnoses;
  assert.deepEqual([glaucoma.status, glaucoma.suspected, glaucoma.code, glaucoma.department], ["active", true, "3659002", "眼科"]);
  assert.deepEqual(glaucoma.modifiers, [{ code: "2057", name: "両", position: "prefix" }]);
  assert.deepEqual([cataract.status, cataract.suspected], ["active", true]);

  // 病名を変えない保存（アレルギーだけ）は、視能訓練士でもできる（古い形で送っても同じものとみなす）
  const allergyOnly = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 1,
    allergies: [{ substance: "ラテックス", category: "latex" }],
    diagnoses: [{ ...glaucoma }, { ...cataract, suspected: undefined, status: "suspected" }]
  }, orthoptist);
  assert.equal(allergyOnly.statusCode, 200, JSON.stringify(allergyOnly.body));
  const changed = await request(stores, "PUT", `/v1/eye/patients/${patient.patientId}/profile`, {
    expectedRevision: 2,
    diagnoses: [{ ...glaucoma, code: "9999999" }, cataract]
  }, orthoptist);
  assert.equal(changed.statusCode, 403, "changing a code is a diagnosis change");

  // 確定すると、プロファイルの病名がコードごとカルテに写る
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09", visitType: "initial", content: { plan: "経過観察" } }, doctor);
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, doctor);
  const diagnoses = finalized.body.encounter.content.diagnoses;
  assert.equal(diagnoses[0].code, "3659002");
  assert.equal(diagnoses[0].suspected, true);
  assert.equal(diagnoses[0].modifiers[0].code, "2057");
  const billing = await request(stores, "GET", "/v1/eye/billing/day?date=2026-11-09", undefined, doctor);
  assert.equal(billing.body.encounters[0].diagnoses[1].suspected, true);
});

// ---- 主訴・所見の自由記載 ----

test("stores the free-text findings as its own section and copies it to the next visit", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-02", visitType: "initial" }, doctor);
  const id = draft.body.encounter.encounterId;
  assert.equal("findingsText" in draft.body.encounter.content, false, "new charts do not carry the field until it is written");
  const byDoctor = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 1, sections: { findingsText: "右眼の霧視。\n前房清明、中間透光体 NS2。" } }, doctor);
  assert.equal(byDoctor.statusCode, 200);
  // 別の項目は同じ版を見ていても通る
  const byOrthoptist = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 1, sections: { staffNote: "散瞳済み" } }, orthoptist);
  assert.equal(byOrthoptist.statusCode, 200);
  const stale = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 1, sections: { findingsText: "上書き" } }, orthoptist);
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.body.details.sections, ["findingsText"]);
  const tooLong = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: 3, sections: { findingsText: "あ".repeat(10001) } }, doctor);
  assert.equal(tooLong.statusCode, 400);

  const finalized = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: 3 }, doctor);
  assert.equal(finalized.statusCode, 200);
  assert.ok(!finalized.body.warnings.some((item) => item.code === "chief_complaint_empty"), "the free text can carry the chief complaint");
  const revisit = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09" }, doctor);
  assert.equal(revisit.body.encounter.content.findingsText, "右眼の霧視。\n前房清明、中間透光体 NS2。");
  const phrase = await request(stores, "POST", "/v1/eye/phrases", { target: "findingsText", text: "前眼部 異常なし" }, await signedHeaders(stores.platformStore, "director"));
  assert.equal(phrase.statusCode, 200);
});

// ---- 確定（警告で止めない）と確定済みの直接編集 ----

test("finalizes with warnings, blocks only rows that are not records", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-11-09",
    content: {
      exam: { od: { iop: 21 }, os: {} },
      orders: [{ orderId: "o1", name: "OCT", status: "planned" }],
      prescriptions: [{ kind: "eye_drop", name: "ヒアレイン点眼液0.1%", carriedOver: true }]
    }
  }, doctor);
  const id = draft.body.encounter.encounterId;
  const finalized = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: 1 }, doctor);
  assert.equal(finalized.statusCode, 200, JSON.stringify(finalized.body));
  const high = finalized.body.warnings.filter((item) => item.level === "high").map((item) => item.code);
  assert.deepEqual(high, ["exam_unconfirmed", "order_planned", "prescription_eye_missing", "prescription_carried_over"]);
  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=finalize", undefined, await signedHeaders(stores.platformStore, "director"));
  assert.ok(logs.body.auditLogs[0].safePayload.warningCodes.includes("exam_unconfirmed"));

  const second = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09", content: { diagnoses: [{ name: "" }] } }, doctor);
  const refused = await request(stores, "POST", `/v1/eye/encounters/${second.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, doctor);
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(refused.body.details.blockers.map((item) => item.code), ["diagnosis_name_missing"]);
});

test("editing a finalized chart starts an amendment automatically and the next finalize adds a version", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const patient = await createPatient(stores, doctor);
  const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09", visitType: "initial", content: { plan: "経過観察" } }, doctor);
  const id = draft.body.encounter.encounterId;
  const v1 = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: 1 }, doctor);
  const revision = v1.body.encounter.revision;

  // 修正は医師だけ
  assert.equal((await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: revision, sections: { plan: "x" } }, orthoptist)).statusCode, 403);
  // 変わらない保存は修正を始めない
  const noop = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: revision, sections: { plan: "経過観察" } }, doctor);
  assert.equal(noop.body.encounter.status, "finalized");

  const edited = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: revision, sections: { plan: "点眼開始" } }, doctor);
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.body.amendStarted, true);
  assert.equal(edited.body.encounter.status, "draft");
  assert.equal(edited.body.encounter.amendment.reason, "修正");
  assert.equal(edited.body.encounter.amendment.auto, true);
  assert.equal(edited.body.encounter.content.plan, "点眼開始");
  // 続けての保存は通常の下書きの保存
  const more = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: edited.body.encounter.revision, sections: { staffNote: "説明済み" } }, doctor);
  assert.equal(more.body.amendStarted, false);

  const v2 = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: more.body.encounter.revision }, doctor);
  assert.equal(v2.body.version.version, 2);
  assert.equal(v2.body.version.amendmentReason, "修正");
  const versions = await request(stores, "GET", `/v1/eye/encounters/${id}`, undefined, doctor);
  assert.deepEqual(versions.body.versions.map((item) => item.version), [1, 2]);
  const first = await request(stores, "GET", `/v1/eye/encounters/${id}/versions/1`, undefined, doctor);
  assert.equal(first.body.version.content.plan, "経過観察", "the first version is kept as it was");

  // 理由を付けた直接編集と、理由なしの修正の開始
  const withReason = await request(stores, "PATCH", `/v1/eye/encounters/${id}`, { expectedRevision: v2.body.encounter.revision, amendmentReason: "日付の誤り", sections: { plan: "点眼継続" } }, doctor);
  assert.equal(withReason.body.encounter.amendment.reason, "日付の誤り");
  const v3 = await request(stores, "POST", `/v1/eye/encounters/${id}/finalize`, { expectedRevision: withReason.body.encounter.revision }, doctor);
  const amend = await request(stores, "POST", `/v1/eye/encounters/${id}/amend`, { expectedRevision: v3.body.encounter.revision }, doctor);
  assert.equal(amend.statusCode, 200);
  assert.equal(amend.body.encounter.amendment.reason, "修正");
  const logs = await request(stores, "GET", "/v1/eye/audit-logs?category=change", undefined, await signedHeaders(stores.platformStore, "director"));
  assert.ok(logs.body.auditLogs.some((log) => log.eventType === "eye.encounter_amend_started" && log.safePayload?.auto === true));
});

// ---- セット: フォルダ・並び順・病名・カルテから作成 ----

test("manages set folders and lets doctors create or overwrite a set from the current chart", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const orthoptist = await signedHeaders(stores.platformStore, "orthoptist");
  const patient = await createPatient(stores, doctor);

  const parent = await request(stores, "POST", "/v1/eye/set-folders", { name: "緑内障", sortOrder: 1 }, doctor);
  assert.equal(parent.statusCode, 200);
  const child = await request(stores, "POST", "/v1/eye/set-folders", { name: "初期", parentId: parent.body.setFolder.folderId }, doctor);
  assert.equal(child.statusCode, 200);
  assert.equal((await request(stores, "POST", "/v1/eye/set-folders", { name: "x" }, orthoptist)).statusCode, 403);
  assert.equal((await request(stores, "POST", "/v1/eye/set-folders", { name: "x", parentId: "missing" }, doctor)).statusCode, 400);
  const cycle = await request(stores, "POST", "/v1/eye/set-folders", { folderId: parent.body.setFolder.folderId, name: "緑内障", parentId: child.body.setFolder.folderId }, doctor);
  assert.equal(cycle.statusCode, 400);

  const draft = await request(stores, "POST", "/v1/eye/encounters", {
    patientId: patient.patientId,
    encounterDate: "2026-11-09",
    visitType: "initial",
    content: {
      findingsText: "眼圧高値。視神経乳頭陥凹拡大。",
      plan: "点眼開始",
      diagnoses: [{ name: "原発開放隅角緑内障", code: "3659005", eye: "ou" }],
      prescriptions: [{ kind: "eye_drop", name: "キサラタン点眼液", rpId: "rp1", eye: "ou", timesPerDay: 1, carriedOver: true }, { kind: "comment", rpId: "rp1", text: "冷所保存" }],
      orders: [{ orderId: "o1", name: "静的視野検査", code: "vf_static", eye: "ou", status: "performed" }]
    }
  }, doctor);
  const encounterId = draft.body.encounter.encounterId;
  const folderId = child.body.setFolder.folderId;
  const createdSet = await request(stores, "POST", "/v1/eye/order-sets/from-encounter", { encounterId, name: "緑内障 初診", folderId }, doctor);
  assert.equal(createdSet.statusCode, 201, JSON.stringify(createdSet.body));
  const set = createdSet.body.orderSet;
  assert.equal(set.folderId, folderId);
  assert.equal(set.findingsText, "眼圧高値。視神経乳頭陥凹拡大。");
  assert.equal(set.diagnoses[0].code, "3659005");
  assert.equal(set.prescriptions[0].carriedOver, false);
  assert.equal(set.prescriptions[1].kind, "comment");
  assert.equal(set.orders[0].status, "planned");
  assert.equal(set.plan, "点眼開始");

  // 新しいセットは同じフォルダの先頭に入る
  const second = await request(stores, "POST", "/v1/eye/order-sets/from-encounter", { encounterId, name: "緑内障 処方だけ", folderId, include: { orders: false, diagnoses: false, findingsText: false, plan: false } }, doctor);
  assert.ok(second.body.orderSet.sortOrder < set.sortOrder);
  assert.equal(second.body.orderSet.orders.length, 0);
  assert.equal("findingsText" in second.body.orderSet, false);

  // 現在のカルテで上書き（処方だけ）: ほかの項目は元のセットのまま
  await request(stores, "PATCH", `/v1/eye/encounters/${encounterId}`, { expectedRevision: 1, sections: { prescriptions: [{ kind: "eye_drop", name: "ザラカム配合点眼液", eye: "ou", timesPerDay: 1 }] } }, doctor);
  const overwritten = await request(stores, "POST", "/v1/eye/order-sets/from-encounter", { encounterId, setId: set.setId, include: { orders: false, diagnoses: false, findingsText: false, plan: false } }, doctor);
  assert.equal(overwritten.statusCode, 200);
  assert.equal(overwritten.body.orderSet.name, "緑内障 初診");
  assert.deepEqual(overwritten.body.orderSet.prescriptions.map((row) => row.name), ["ザラカム配合点眼液"]);
  assert.equal(overwritten.body.orderSet.findingsText, "眼圧高値。視神経乳頭陥凹拡大。");
  assert.equal(overwritten.body.orderSet.sortOrder, set.sortOrder);

  assert.equal((await request(stores, "POST", "/v1/eye/order-sets/from-encounter", { encounterId, name: "x" }, orthoptist)).statusCode, 403);
  assert.equal((await request(stores, "POST", "/v1/eye/order-sets/from-encounter", { encounterId, name: "x", folderId: "missing" }, doctor)).statusCode, 400);
  assert.equal((await request(stores, "POST", "/v1/eye/order-sets/from-encounter", { encounterId, setId: "missing" }, doctor)).statusCode, 404);

  const bootstrap = await request(stores, "GET", "/v1/eye/bootstrap", undefined, doctor);
  assert.deepEqual(bootstrap.body.orderSets.map((item) => item.name), ["緑内障 処方だけ", "緑内障 初診"]);
  assert.deepEqual(bootstrap.body.setFolders.map((item) => item.name), ["初期", "緑内障"]);
  assert.equal(bootstrap.body.context.canManageSets, true);
  const listed = await request(stores, "GET", "/v1/eye/order-sets", undefined, orthoptist);
  assert.equal(listed.body.orderSets.length, 2);
});

// ---- 学習リスト ----

test("aggregates the clinic's most used bundles from finalized charts", () => {
  const rx = (extra = {}) => ({ kind: "eye_drop", name: "キサラタン点眼液", drugCode: "620008621", eye: "ou", timesPerDay: 1, usage: "就寝前", days: 28, quantity: 1, unit: "本", route: "outside", ...extra });
  const encounters = [
    { finalizedAt: "2026-11-01T00:00:00Z", content: { prescriptions: [rx({ rpId: "a" }), { kind: "comment", rpId: "a", text: "冷所" }], orders: [{ orderId: "1", name: "OCT", code: "oct_retina", eye: "ou", status: "performed" }], diagnoses: [{ name: "緑内障", eye: "ou", status: "suspected" }] } },
    { finalizedAt: "2026-11-02T00:00:00Z", content: { prescriptions: [rx({ rpId: "b" }), { kind: "comment", rpId: "b", text: "冷所" }], orders: [{ orderId: "1", name: "OCT", code: "oct_retina", eye: "ou", status: "cancelled" }], diagnoses: [{ name: "緑内障", eye: "ou", suspected: true }] } },
    { finalizedAt: "2026-11-03T00:00:00Z", content: { prescriptions: [rx({ timesPerDay: 2 })], orders: [{ orderId: "1", name: "OCT", code: "oct_retina", eye: "ou", status: "performed" }] } }
  ];
  const result = aggregateLearning(encounters);
  assert.equal(result.prescription[0].count, 2);
  assert.deepEqual(result.prescription[0].rows.map((row) => row.name || row.text), ["キサラタン点眼液", "冷所"]);
  assert.equal(result.prescription[0].rp.usage, "就寝前");
  assert.equal(result.prescription[1].count, 1);
  assert.equal(result.order[0].count, 2, "cancelled orders do not count");
  assert.equal(result.order[0].lastUsedAt, "2026-11-03T00:00:00Z");
  assert.equal(result.diagnosis[0].count, 2, "the old suspected status and the flag are the same bundle");
  assert.equal(result.diagnosis[0].rows[0].suspected, true);
});

test("serves the learning list per clinic with a cache that is refreshed on finalize", async () => {
  const stores = createStores();
  const doctor = await signedHeaders(stores.platformStore, "doctor");
  const clerk = await signedHeaders(stores.platformStore, "clerk");
  const patient = await createPatient(stores, doctor);
  const finalize = async (content) => {
    const draft = await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09", visitType: "initial", content }, doctor);
    return request(stores, "POST", `/v1/eye/encounters/${draft.body.encounter.encounterId}/finalize`, { expectedRevision: 1 }, doctor);
  };
  await finalize({ prescriptions: [{ kind: "eye_drop", name: "ヒアレイン点眼液0.1%", eye: "ou", timesPerDay: 4 }] });
  const first = await request(stores, "GET", "/v1/eye/learning-list?category=prescription", undefined, doctor);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(Object.keys(first.body.items), ["prescription"]);
  assert.equal(first.body.items.prescription[0].count, 1);
  // 下書き（未確定）は数えない
  await request(stores, "POST", "/v1/eye/encounters", { patientId: patient.patientId, encounterDate: "2026-11-09", content: { prescriptions: [{ kind: "eye_drop", name: "ヒアレイン点眼液0.1%", eye: "ou", timesPerDay: 4 }] } }, doctor);
  await finalize({ prescriptions: [{ kind: "eye_drop", name: "ヒアレイン点眼液0.1%", eye: "ou", timesPerDay: 4 }] });
  const second = await request(stores, "GET", "/v1/eye/learning-list", undefined, doctor);
  assert.equal(second.body.items.prescription[0].count, 2);
  assert.deepEqual(Object.keys(second.body.items), ["prescription", "order", "diagnosis"]);
  assert.equal((await request(stores, "GET", "/v1/eye/learning-list?category=nope", undefined, doctor)).statusCode, 400);
  assert.equal((await request(stores, "GET", "/v1/eye/learning-list", undefined, clerk)).statusCode, 403);
});

// ---- helpers ----

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const data = file.deflate ? deflateRawSync(file.data) : file.data;
    const name = Buffer.from(file.name, "latin1");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const ROLE_PROFILES = {
  director: { loginId: "eye-director", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
  doctor: { loginId: "eye-doctor", globalRoles: [], productRoles: { eye: ["doctor"] } },
  orthoptist: { loginId: "eye-ort", globalRoles: [], productRoles: { eye: ["orthoptist"] } },
  clerk: { loginId: "eye-clerk", globalRoles: [], productRoles: { eye: ["medical_clerk"] } },
  viewer: { loginId: "eye-viewer", globalRoles: [], productRoles: { eye: ["viewer"] } }
};

function createStores() {
  const counters = new Map();
  const idFactory = (prefix) => {
    const next = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(3, "0")}`;
  };
  const now = () => NOW;
  const platformStore = new MemoryPlatformStore({ now, idFactory, tokenFactory: idFactory });
  const eyeStore = new MemoryEyeStore({ now, idFactory });
  const organization = platformStore.createOrganization({ organizationCode: "Asaoka", displayName: "あさおか眼科" });
  for (const profile of Object.values(ROLE_PROFILES)) {
    platformStore.createMember(organization.orgId, { loginId: profile.loginId, displayName: profile.loginId, globalRoles: profile.globalRoles, productRoles: profile.productRoles, password: "correct horse battery staple" });
  }
  platformStore.upsertProductEntitlement(organization.orgId, { productId: "eye", status: "trialing" });
  return { platformStore, eyeStore, blobStore: new MemoryBlobStore() };
}

async function signedHeaders(platformStore, profileName) {
  const profile = ROLE_PROFILES[profileName];
  const initial = platformStore.getLoginIdentity("asaoka", profile.loginId);
  const identity = initial.mfaRequired && !initial.mfaEnrolled
    ? platformStore.completeMfaEnrollment(platformStore.beginMfaEnrollment(initial, "MZXW6YTBOI======"))
    : initial;
  const { token, session } = createSignedSession({
    orgId: identity.orgId,
    memberId: identity.memberId,
    organizationCode: identity.organizationCode,
    loginId: identity.loginId,
    tokenVersion: identity.tokenVersion,
    globalRoles: profile.globalRoles,
    productRoles: profile.productRoles,
    mfaRequired: true,
    mfaEnrolled: true,
    mfaVerified: true,
    csrfToken: `csrf_${profile.loginId}`
  }, { now: NOW, sessionSecret: "test-session-secret" });
  return { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`, "x-csrf-token": session.csrfToken };
}

async function createPatient(stores, headers) {
  const response = await request(stores, "POST", "/v1/eye/patients", { displayName: "眼科 太郎", displayNameKana: "ガンカ タロウ", birthDate: "1950-04-01", sex: "male", primaryPatientNumber: "000123" }, headers);
  assert.equal(response.statusCode, 201);
  return response.body.patient;
}

function request(stores, method, path, body, headers = {}, extra = {}) {
  return handleEyeApiRequest({
    method,
    path,
    body,
    headers,
    platformStore: stores.platformStore,
    eyeStore: stores.eyeStore,
    blobStore: stores.blobStore,
    now: () => NOW,
    sessionSecret: "test-session-secret",
    ...extra
  });
}
