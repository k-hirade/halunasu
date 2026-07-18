import assert from "node:assert/strict";
import { test } from "node:test";
import { toUserFacingErrorMessage } from "../src/user-facing-error.js";

test("maps known auth/credential errors", () => {
  assert.equal(toUserFacingErrorMessage({ code: "mfa_enrollment_required" }), "2段階認証の登録を完了してください。");
  assert.equal(toUserFacingErrorMessage({ code: "mfa_required" }), "2段階認証コードを入力してください。");
  assert.equal(toUserFacingErrorMessage("Invalid MFA code"), "2段階認証コードが正しくありません。");
  assert.equal(
    toUserFacingErrorMessage("invalid credentials"),
    "病院コード、個人ID、またはログイン用パスワードが正しくありません。"
  );
  assert.equal(toUserFacingErrorMessage({ status: 403 }), "この操作を行う権限がありません。");
});

test("maps network and server errors", () => {
  assert.equal(toUserFacingErrorMessage("Failed to fetch"), "通信に失敗しました。接続を確認して、もう一度お試しください。");
  assert.equal(toUserFacingErrorMessage({ status: 500 }), "処理中に問題が発生しました。時間を置いてもう一度お試しください。");
  assert.equal(toUserFacingErrorMessage({ status: 429 }), "短時間に操作が続いています。少し待ってからもう一度お試しください。");
});

test("passes through user-facing Japanese and falls back otherwise", () => {
  assert.equal(toUserFacingErrorMessage("保存に失敗しました。"), "保存に失敗しました。");
  assert.equal(toUserFacingErrorMessage("RandomEnglishError"), "処理に失敗しました。時間を置いてもう一度お試しください。");
  assert.equal(toUserFacingErrorMessage("", "既定メッセージ"), "既定メッセージ");
  assert.equal(toUserFacingErrorMessage("HTTP 418", "既定メッセージ"), "既定メッセージ");
});
