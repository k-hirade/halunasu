import assert from "node:assert/strict";
import { test } from "node:test";
import { PASSWORD_MIN_LENGTH, passwordChangeErrorField, validatePasswordChange } from "../lib/password-change.js";

const current = "eye-local-password-2026";
const next = "eye-new-password-2026";

test("password change input follows the platform policy", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(validatePasswordChange({ currentPassword: current, newPassword: next, confirmPassword: next }), null);
  assert.equal(validatePasswordChange({ newPassword: next, confirmPassword: next }).field, "currentPassword");
  assert.equal(validatePasswordChange({ currentPassword: current, newPassword: "   ", confirmPassword: "   " }).field, "newPassword");
  assert.match(validatePasswordChange({ currentPassword: current, newPassword: "short-pass", confirmPassword: "short-pass" }).message, /12文字以上/u);
  assert.equal(validatePasswordChange({ currentPassword: current, newPassword: "a".repeat(12), confirmPassword: "a".repeat(12) }), null, "exactly 12 characters is allowed");
  assert.match(validatePasswordChange({ currentPassword: current, newPassword: current, confirmPassword: current }).message, /現在と違う/u);
  const mismatch = validatePasswordChange({ currentPassword: current, newPassword: next, confirmPassword: `${next}x` });
  assert.equal(mismatch.field, "confirmPassword");
  assert.match(mismatch.message, /一致しません/u);
});

test("server password change errors point to the right field", () => {
  assert.equal(passwordChangeErrorField({ code: "invalid_current_password", field: "currentPassword" }), "currentPassword");
  assert.equal(passwordChangeErrorField({ code: "password_unchanged" }), "newPassword");
  assert.equal(passwordChangeErrorField({ code: "validation", field: "newPassword" }), "newPassword");
  assert.equal(passwordChangeErrorField({ code: "rate_limit", status: 429 }), "");
  assert.equal(passwordChangeErrorField(null), "");
});
