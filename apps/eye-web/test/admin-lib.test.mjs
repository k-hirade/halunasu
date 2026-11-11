// replicate-2（admin）: 利用者の役割・仮のパスワード・経営データ集計の CSV・文書の前文の置き換え。
import assert from "node:assert/strict";
import { test } from "node:test";
import { csvText, dailyReportRows, monthlyReportRows, nextProductRoles, rangeDays, setPreamble, stripNewIds, temporaryPassword, visitReportRows } from "../lib/admin.js";
import { parseLetter, setSectionText } from "../lib/letter.js";

test("product roles keep other products and unknown eye roles, and toggle the administrator right", () => {
  const member = { productRoles: { eye: ["doctor", "admin", "beta_tester"], fee: ["clerk"] } };
  assert.deepEqual(nextProductRoles(member, { roles: ["orthoptist", "nurse"], admin: false }), { fee: ["clerk"], eye: ["orthoptist", "nurse", "beta_tester"] });
  assert.deepEqual(nextProductRoles(null, { roles: ["doctor"], admin: true }), { eye: ["doctor", "admin"] });
  assert.deepEqual(nextProductRoles(member, { roles: ["unknown"], admin: true }).eye, ["beta_tester", "admin"]);
});

test("temporary passwords are 14 characters with upper, lower and digits and no confusable letters", () => {
  for (let index = 0; index < 50; index += 1) {
    const password = temporaryPassword();
    assert.equal(password.length, 14);
    assert.match(password, /[A-Z]/u);
    assert.match(password, /[a-z]/u);
    assert.match(password, /\d/u);
    assert.doesNotMatch(password, /[01OIlo]/u);
  }
  assert.equal(temporaryPassword(() => new Uint8Array(14)).length, 14, "fixed bytes still satisfy the rules");
});

test("report CSV has a BOM, escapes cells and neutralises formulas", () => {
  const report = {
    totals: { booked: 2, arrived: 1, initial: 1, revisit: 0, walkIn: 0, cancelled: 1, absent: 0 },
    days: [{ date: "2026-11-01", booked: 2, arrived: 1, initial: 1, revisit: 0, walkIn: 0, cancelled: 1, absent: 0 }],
    months: [{ month: "2026-11", arrived: 1, initial: 1, revisit: 0, cancelled: 1, absent: 0, openDays: 1 }],
    visits: [{ date: "2026-11-01", queueNumber: 1, time: "09:30", checkedInAt: "2026-11-01T00:35:00.000Z", patientNumber: "000123", patientName: "=HYPERLINK(\"x\")", purpose: "初診", walkIn: false, status: "診察待", department: "", doctorMemberId: "m1", receptionMemo: "右眼, かすみ" }]
  };
  const csv = csvText(visitReportRows(report, { doctors: { m1: "院長" }, includeMemo: true }));
  assert.ok(csv.startsWith("﻿日付,受付番号"));
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/u);
  assert.match(csv, /,09:35,/u, "check-in time is shown in Japan time");
  assert.match(csv, /"右眼, かすみ"\r\n$/u);
  assert.match(csv, /,院長,/u);
  assert.equal(csvText([["-3"]]), "﻿-3\r\n", "negative numbers are not treated as formulas");
  assert.deepEqual(dailyReportRows(report).at(-1), ["合計", 2, 1, 1, 0, 0, 1, 0]);
  assert.equal(monthlyReportRows(report)[1][0], "2026-11");
  assert.equal(visitReportRows(report)[0].includes("受付メモ"), false, "memo column only when asked");
  assert.equal(rangeDays("2026-01-01", "2026-12-31"), 365);
});

test("new rows lose their temporary id before saving", () => {
  assert.deepEqual(stripNewIds([{ labelId: "new_abc", name: "a" }, { labelId: "erlb_1", name: "b" }], "labelId"), [{ labelId: "", name: "a" }, { labelId: "erlb_1", name: "b" }]);
});

test("field-by-field document editing rewrites only its own part of the body", () => {
  const body = "前文です。\n\n【傷病名】\n・白内障\n\n【紹介目的】\n手術\n\n【既往歴】\nなし";
  const changed = setSectionText(body, "傷病名", "・右眼 白内障\n・左眼 白内障");
  assert.equal(parseLetter(changed).sections[0].text, "・右眼 白内障\n・左眼 白内障");
  assert.equal(parseLetter(changed).sections[2].text, "なし");
  const preamble = setPreamble(changed, "いつもお世話になっております。");
  assert.equal(parseLetter(preamble).preamble, "いつもお世話になっております。");
  assert.equal(parseLetter(preamble).sections.length, 3);
  assert.equal(parseLetter(setPreamble(preamble, "")).preamble, "");
  assert.equal(setPreamble("", "あいさつ"), "あいさつ");
});
