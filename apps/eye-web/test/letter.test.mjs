import assert from "node:assert/strict";
import { test } from "node:test";
import { formatVisualAcuityLine, patientLine } from "../lib/format.js";
import { letterChecks, parseLetter, readPurpose, setSectionText, URGENT_LINE, writePurpose } from "../lib/letter.js";

const TEMPLATE = [
  "平素より大変お世話になっております。",
  "",
  "【傷病名】",
  "・左眼 白内障",
  "",
  "【紹介目的】",
  "",
  "",
  "【検査所見】（2026-10-13）",
  "視力 右 1.0　左 0.4"
].join("\n");

test("parses headings without changing the stored body", () => {
  const parsed = parseLetter(TEMPLATE);
  assert.equal(parsed.preamble, "平素より大変お世話になっております。");
  assert.deepEqual(parsed.sections.map((item) => [item.heading, item.note, item.text]), [
    ["傷病名", "", "・左眼 白内障"],
    ["紹介目的", "", ""],
    ["検査所見", "（2026-10-13）", "視力 右 1.0　左 0.4"]
  ]);
  assert.deepEqual(parseLetter("本文だけ").sections, []);
});

test("writes only the purpose section and round-trips stably", () => {
  const once = writePurpose(TEMPLATE, { text: "手術のご検討をお願いします。", urgent: false });
  assert.equal(once, TEMPLATE.replace("【紹介目的】\n\n\n", "【紹介目的】\n手術のご検討をお願いします。\n\n"));
  assert.equal(writePurpose(once, readPurpose(once)), once);
  const urgent = writePurpose(once, { ...readPurpose(once), urgent: true });
  assert.deepEqual(readPurpose(urgent), { urgent: true, text: "手術のご検討をお願いします。" });
  assert.match(urgent, new RegExp(`【紹介目的】\\n${URGENT_LINE}\\n手術`, "u"));
  const cleared = writePurpose(urgent, { text: "", urgent: false });
  assert.equal(readPurpose(cleared).text, "");
  assert.equal(parseLetter(cleared).sections.length, 3, "other sections stay");
  assert.equal(writePurpose("【紹介目的】", { text: "【検査】依頼", urgent: false }), "【紹介目的】\n［検査］依頼");
  assert.equal(setSectionText("見出しなし", "紹介目的", "x"), "見出しなし");
});

test("blocks finalizing a referral without a purpose and warns about the rest", () => {
  const checks = letterChecks({ type: "referral", body: TEMPLATE, recipient: {}, sender: { facilityName: "ハルナス眼科" } });
  assert.deepEqual(checks.map((item) => [item.code, item.level]), [
    ["purpose_empty", "blocker"], ["recipient_empty", "warning"], ["sender_incomplete", "warning"]
  ]);
  const ready = letterChecks({
    type: "referral",
    body: writePurpose(TEMPLATE, { text: "精査のお願い", urgent: false }),
    recipient: { institution: "県立病院" },
    sender: { facilityName: "ハルナス眼科", address: "東京都", phone: "03" }
  });
  assert.deepEqual(ready, []);
  assert.equal(letterChecks({ type: "certificate", body: "", sender: { facilityName: "a", address: "b", phone: "c" } })[0].code, "body_empty");
});

test("formats acuity on one line and age on the given date", () => {
  assert.equal(formatVisualAcuityLine({ vaUncorrected: "0.9", vaCorrected: "1.2", correction: { sphere: -1, cylinder: -0.5, axis: 180 } }), "0.9（1.2×S-1.00D=C-0.50D Ax180°）");
  assert.equal(formatVisualAcuityLine({ vaUncorrected: "0.3", vaCorrected: "0.6", correction: { sphere: -2.25 }, vaCorrectionType: "contact" }), "0.3（0.6×S-2.25D） CL");
  assert.equal(formatVisualAcuityLine({ vaUncorrected: "1.0" }), "1.0");
  assert.equal(formatVisualAcuityLine({ vaCorrected: "1.2" }), "—（1.2）");
  assert.equal(formatVisualAcuityLine({}), "");
  assert.equal(patientLine({ birthDate: "1950-04-02", sex: "female" }, "2026-04-01"), "75歳 ・ 女");
  assert.equal(patientLine({ birthDate: "1950-04-02", sex: "female" }, "2026-04-02"), "76歳 ・ 女");
});
