import assert from "node:assert/strict";
import test from "node:test";

import { toUserFacingErrorMessage } from "../../lib/user-facing-error.js";

test("technical error messages are converted before reaching UI", () => {
  const cases = [
    [new TypeError("Failed to fetch"), "通信に失敗しました。接続を確認して、もう一度お試しください。"],
    [new Error("Invalid credentials"), "病院コード、個人ID、またはパスワードが正しくありません。"],
    [Object.assign(new Error("MFA code is required"), { code: "mfa_required" }), "2段階認証コードを入力してください。"],
    [new Error("Invalid MFA code"), "2段階認証コードが正しくありません。"],
    [new Error("CSRF token mismatch"), "画面を再読み込みして、もう一度お試しください。"],
    [new Error("Organization admin role is required"), "この操作を行う権限がありません。"],
    [Object.assign(new Error("Internal server error"), { status: 500 }), "処理中に問題が発生しました。時間を置いてもう一度お試しください。"]
  ];

  for (const [input, expected] of cases) {
    assert.equal(toUserFacingErrorMessage(input, "処理に失敗しました。"), expected);
  }
});

test("Japanese user-facing messages are preserved", () => {
  assert.equal(
    toUserFacingErrorMessage("プロンプト一覧を取得できませんでした。"),
    "プロンプト一覧を取得できませんでした。"
  );
});
