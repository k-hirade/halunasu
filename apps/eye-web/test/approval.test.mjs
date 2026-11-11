// replicate-2 approval: 承認の表示の判定（lib/approval.js）と approval.css の約束、基準値の既定。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_REFERENCE_RANGES, referenceLevel, resolveReferenceRanges } from "@halunasu/eye-core";
import { approvalBriefOf, approvalGuideItem, approvalTag, isUnapproved, versionApproval } from "../lib/approval.js";

const pending = { status: "pending", version: 1, requestedBy: { displayName: "研修医" }, requestedAt: "2026-11-11T01:00:00.000Z", decidedBy: null, decidedAt: "", comment: "" };

test("approval brief follows the chart: current only while finalized and not amending", () => {
  assert.equal(approvalBriefOf({ status: "finalized", versionCount: 1 }), null, "charts outside the flow show nothing");
  const brief = approvalBriefOf({ status: "finalized", versionCount: 1, approval: pending });
  assert.equal(brief.current, true);
  assert.equal(approvalTag(brief).label, "承認待ち");
  assert.equal(isUnapproved(brief), true);
  assert.equal(approvalGuideItem(brief).state, "warn");
  const amending = approvalBriefOf({ status: "draft", versionCount: 1, amendment: { reason: "修正" }, approval: { ...pending, status: "approved" } });
  assert.equal(amending.current, false);
  assert.equal(approvalTag(amending), null);
  assert.equal(isUnapproved(amending), false);
  assert.equal(approvalGuideItem(amending).state, "todo");
  const approved = approvalBriefOf({ status: "finalized", versionCount: 2, approval: { ...pending, version: 2, status: "approved", decidedBy: { displayName: "指導医" } } });
  assert.equal(approvalTag(approved).tone, "ok");
  assert.equal(isUnapproved(approved), false);
  const returned = approvalBriefOf({ status: "finalized", versionCount: 1, approval: { ...pending, status: "returned", comment: "追記" } });
  assert.equal(approvalTag(returned).tone, "danger");
  assert.match(approvalTag(returned).title, /追記/u);
});

test("version approval reads the per-version events", () => {
  assert.equal(versionApproval([]), null);
  assert.deepEqual(versionApproval([{ action: "requested" }]), { approved: false, returned: false, comment: "", by: "", at: "" });
  const returned = versionApproval([{ action: "requested" }, { action: "returned", comment: "理由", by: { displayName: "指導医" }, at: "t" }]);
  assert.equal(returned.returned, true);
  assert.equal(returned.comment, "理由");
  assert.equal(versionApproval([{ action: "requested" }, { action: "approved", by: { displayName: "指導医" }, at: "t" }]).approved, true);
  assert.equal(versionApproval([{ action: "auto_approved", by: { displayName: "指導医" }, at: "t" }]).auto, true);
});

test("reference range defaults cover the eye exam items", () => {
  const ranges = resolveReferenceRanges(null);
  for (const key of ["vau", "vac", "near", "iop", "s", "c", "k1", "k2", "pupil", "cd"]) assert.ok(ranges.exam[key], key);
  assert.deepEqual(ranges.exam.iop, { low: 10, high: 21 });
  assert.deepEqual(ranges.vitals.systolic, DEFAULT_REFERENCE_RANGES.vitals.systolic);
  assert.equal(referenceLevel(48, ranges.exam.k1), "high");
  assert.equal(referenceLevel(-1.5, ranges.exam.c), "low");
});

test("approval.css is imported once and uses tokens only", () => {
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.equal(globals.match(/@import "\.\/styles\/approval\.css";/gu)?.length, 1);
  const css = readFileSync(new URL("../app/styles/approval.css", import.meta.url), "utf8");
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/iu.test(css), false, "no hard-coded colours");
  const fontSizes = [...css.matchAll(/font-size:\s*([^;]+);/gu)].map((match) => match[1].trim());
  assert.ok(fontSizes.every((value) => value.startsWith("var(--fs-")), `font sizes use the type scale: ${fontSizes.join(", ")}`);
});
