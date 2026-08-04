import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sidecarCandidateVisibility } from "../src/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");

// 採用ブロック理由ごとの表示方針を1か所で固定する。
// 新しい理由が増えたとき、既定が「要判断へ出す」であることを保証し、
// 候補が画面から黙って消える退行を検出する。
const BLOCK_REASON_POLICY = [
  { reason: "human_verification_required", presentation: "decision" },
  { reason: "facility_standard_unconfirmed", presentation: "decision" },
  { reason: "same_household_visit_order_unconfirmed", presentation: "decision" },
  { reason: "master_code_unresolved", presentation: "hidden" },
  { reason: "reason_introduced_later", presentation: "decision" }
];

test("blocked candidates are shown unless the reason is explicitly non-presentable", () => {
  for (const { reason, presentation } of BLOCK_REASON_POLICY) {
    const visibility = sidecarCandidateVisibility({
      adoptionBlocked: true,
      adoptionBlockReason: reason
    });
    assert.equal(visibility.presentation, presentation, `${reason} の表示方針`);
    assert.equal(visibility.hiddenReason, presentation === "hidden" ? reason : null);
    assert.equal(visibility.requiresHumanVerification, presentation === "decision");
  }
});

test("included candidates are never treated as blocked", () => {
  const visibility = sidecarCandidateVisibility(
    { adoptionBlocked: true, adoptionBlockReason: "master_code_unresolved" },
    { included: true }
  );
  assert.deepEqual(visibility, {
    presentation: "included",
    hiddenReason: null,
    requiresHumanVerification: false
  });
});

test("candidates without an adoption block stay in the decision zone", () => {
  for (const candidate of [{}, { adoptionBlocked: false }, { adoptionBlockReason: "master_code_unresolved" }]) {
    const visibility = sidecarCandidateVisibility(candidate);
    assert.equal(visibility.presentation, "decision");
    assert.equal(visibility.hiddenReason, null);
    assert.equal(visibility.requiresHumanVerification, false);
  }
});

test("every confirm_with_note trigger reaches the decision zone", async () => {
  const artifact = JSON.parse(await readFile(
    path.join(repositoryRoot, "data/fee-rules/source/standing-structured-triggers-2026.json"),
    "utf8"
  ));
  const confirmWithNoteTriggers = artifact.triggers.filter((trigger) => (
    trigger.failureMode === "confirm_with_note"
  ));
  assert.equal(confirmWithNoteTriggers.length > 0, true);
  for (const trigger of confirmWithNoteTriggers) {
    // standing-billing-profiles は confirm_with_note を human_verification_required として採用ブロックする。
    const visibility = sidecarCandidateVisibility({
      adoptionBlocked: true,
      adoptionBlockReason: "human_verification_required"
    });
    assert.equal(visibility.presentation, "decision", `${trigger.triggerId} は要判断へ出す`);
  }
});
