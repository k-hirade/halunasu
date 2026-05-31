import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const html = readFileSync(join(root, "index.html"), "utf8");

test("authentication flow is split, localized, and has logout", () => {
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="login-mfa-form"/);
  assert.match(html, />2段階認証</);
  assert.match(html, /\/v1\/auth\/login/);
  assert.match(html, /\/v1\/auth\/session/);
  assert.match(html, /\/v1\/auth\/logout/);
  assert.match(html, /2段階認証コードを入力してください/);
  assert.doesNotMatch(html, />MFA/);
  assert.doesNotMatch(html, /MFAリセット/);
});

test("always-visible authenticator setup block is removed", () => {
  assert.doesNotMatch(html, /二要素認証/);
  assert.doesNotMatch(html, /Google Authenticator/);
  assert.doesNotMatch(html, /id="mfa-status"/);
  assert.doesNotMatch(html, /id="mfa-enroll-actions"/);
  assert.doesNotMatch(html, /id="mfa-setup-panel"/);
});

test("app shell uses sidebar navigation, topbar organization switcher, and account menu", () => {
  assert.match(html, /class="sidebar"/);
  assert.match(html, /class="side-nav"/);
  assert.match(html, /class="topbar-main"/);
  assert.match(html, /class="field org-switcher"/);
  assert.match(html, /\.topbar\s*\{[\s\S]*grid-template-columns: 220px minmax\(0, 1fr\);/);
  assert.match(html, /\.main\s*\{[\s\S]*grid-template-columns: 220px minmax\(0, 1fr\);/);
  assert.doesNotMatch(html, /main--single/);
  assert.doesNotMatch(html, /class="split"/);
});

test("master data screens cover modal create, edit, copy, search, and reload flows", () => {
  for (const endpoint of [
    "/v1/organizations",
    "/members",
    "/facilities",
    "/departments",
    "/patients",
    "/product-entitlements",
    "/data-requests",
    "/audit-events"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(endpoint)));
  }

  for (const token of [
    "data-create=\"member\"",
    "data-create=\"facility\"",
    "data-create=\"department\"",
    "data-create=\"patient\"",
    "openCreateModal",
    "renderCreateForm",
    "createPayload",
    "data-edit-facility",
    "data-edit-department",
    "data-edit-patient",
    "data-copy-id",
    "patient-filter",
    "audit-filter",
    "refreshCurrentView",
    "loading-state",
    "empty-state"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(token)));
  }
});

test("tables hide internal IDs as primary columns and keep copy affordances", () => {
  for (const removedColumn of [
    '["memberId", "memberId"]',
    '["facilityId", "facilityId"]',
    '["departmentId", "departmentId"]',
    '["patientId", "patientId"]',
    '["eventId", "eventId"]',
    '["requestId", "requestId"]',
    '["orgId", "orgId"]'
  ]) {
    assert.doesNotMatch(html, new RegExp(escapeRegExp(removedColumn)));
  }
  assert.match(html, /aria-label="職員IDをコピー"/);
  assert.match(html, /aria-label="患者IDをコピー"/);
  assert.match(html, /aria-label="イベントIDをコピー"/);
});

test("operator-facing labels and audit events are localized", () => {
  for (const label of [
    "プロダクト契約",
    "開示請求",
    "ログイン成功",
    "ログイン失敗",
    "ログアウト",
    "職員作成",
    "施設更新",
    "患者更新",
    "プロダクト契約保存"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(label)));
  }
  assert.doesNotMatch(html, /\["イベント", "eventType"\]/);
  assert.doesNotMatch(html, />Product Entitlement</);
  assert.doesNotMatch(html, />Data Request</);
});

test("role guards are present for admin-only and billing-only features", () => {
  for (const token of [
    "canManageOrg",
    "canManageBilling",
    "setViewVisibility",
    "setCreateVisibility",
    'data-view="organizations"',
    'data-view="entitlements"',
    'data-view="data-requests"',
    'data-view="audit"'
  ]) {
    assert.match(html, new RegExp(escapeRegExp(token)));
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
