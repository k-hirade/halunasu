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
assert(html.includes("/v1/auth/session"), "core admin must read Platform session");
assert(html.includes("/v1/auth/mfa/enroll"), "core admin must start MFA enrollment");
assert(html.includes("/v1/auth/mfa/verify"), "core admin must verify MFA enrollment");
assert(html.includes("qrCodeDataUrl"), "core admin must render MFA QR data URL");
assert(html.includes("/v1/organizations"), "core admin must manage organizations");
assert(html.includes("/members"), "core admin must manage members");
assert(html.includes("/facilities"), "core admin must manage facilities");
assert(html.includes("/departments"), "core admin must manage departments");
assert(html.includes("/patients"), "core admin must manage patients");
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
