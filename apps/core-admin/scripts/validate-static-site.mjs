import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = ["index.html", "package.json", "README.md"];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const html = readFileSync(join(root, "index.html"), "utf8");

assert(html.includes("halunasu-platform-api-base-url"), "core admin must configure Platform API base URL");
assert(html.includes("/v1/auth/login"), "core admin must log in through Platform");
assert(html.includes("login-mfa-form"), "core admin must use a separate MFA login step");
assert(html.includes("mfa_required"), "core admin must branch to the MFA login step when Platform requires MFA");
assert(html.includes("2段階認証"), "core admin must use patient-facing two-step auth wording");
assert(!html.includes("二要素認証"), "core admin must not show the old two-factor auth block label");
assert(!html.includes("Google Authenticator"), "core admin must not show the always-on authenticator setup block");
assert(html.includes("施設管理画面"), "core admin must use the Japanese hospital management label");
assert(!html.includes("Halunasu Core Admin"), "core admin UI must not expose the old Core Admin label");
assert(html.includes("/v1/auth/logout"), "core admin must expose logout");
assert(html.includes("ログイン成功"), "core admin must localize auth audit event names");
assert(html.includes("width: min(1360px, calc(100% - 32px));"), "core admin topbar must align with the main shell");
assert(html.includes("data-icon"), "core admin must use shared SOAP-style icons");
assert(!html.includes("<th>memberId</th>"), "core admin must not expose memberId as a primary table column");
assert(!html.includes("<th>patientId</th>"), "core admin must not expose patientId as a primary table column");
assert(!html.includes("<th>eventId</th>"), "core admin must not expose eventId as a primary table column");
assert(html.includes("データがありません") || html.includes("empty-state"), "core admin must render empty states");
assert(html.includes("/v1/auth/session"), "core admin must read Platform session");
assert(html.includes("/v1/organizations"), "core admin must manage organizations");
assert(html.includes("/members"), "core admin must manage members");
assert(html.includes("/facilities"), "core admin must manage facilities");
assert(html.includes("/departments"), "core admin must manage departments");
assert(html.includes("/patients"), "core admin must manage patients");
assert(html.includes("data-edit-facility"), "core admin must expose facility edit actions");
assert(html.includes("data-edit-department"), "core admin must expose department edit actions");
assert(html.includes("data-edit-patient"), "core admin must expose patient edit actions");
assert(html.includes('method: "PATCH"'), "core admin must update shared master records through PATCH");
assert(html.includes("/product-entitlements"), "core admin must manage product entitlements");
assert(html.includes("/data-requests"), "core admin must manage data requests");
assert(html.includes("/audit-events"), "core admin must review audit events");
assert(html.includes("platform_admin"), "core admin must surface platform admin role");
assert(html.includes("org_admin"), "core admin must surface org admin role");
assert(html.includes("billing_admin"), "core admin must surface billing admin role");
assert(html.includes("x-csrf-token"), "core admin must send CSRF headers");
const forbiddenClientSdkTokens = [
  ["firebase", "app"].join("/"),
  ["firebase", "firestore"].join("/")
];
for (const token of forbiddenClientSdkTokens) {
  assert(!html.includes(token), "core admin must not import Firebase client SDK");
}
assert(!html.includes("OPERATOR_ACCOUNTS_JSON"), "core admin must not reference old operator auth");

console.log("Core admin static validation passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
