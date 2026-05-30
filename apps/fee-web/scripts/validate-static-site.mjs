import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = ["index.html", "package.json", "README.md"];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const html = readFileSync(join(root, "index.html"), "utf8");

assert(html.includes("/v1/auth/login"), "fee web must log in through Platform");
assert(html.includes("mfaCode"), "fee web must support Platform MFA login");
assert(html.includes('id="mfa-gate"'), "fee web must use a separate MFA gate like charting");
assert(html.includes("/v1/auth/mfa/enroll"), "fee web must support Platform MFA enrollment");
assert(html.includes("/v1/auth/mfa/verify"), "fee web must support Platform MFA verification");
assert(html.includes("/v1/fee/patients"), "fee web must create patients through fee-api");
assert(html.includes("/v1/fee/facilities"), "fee web must load Platform facilities through fee-api");
assert(html.includes("/v1/fee/departments"), "fee web must load Platform departments through fee-api");
assert(html.includes("/v1/fee/sessions"), "fee web must create fee sessions through fee-api");
assert(html.includes("/calculate"), "fee web must run the fee calculation endpoint");
assert(html.includes("receipt-draft"), "fee web must show Core receipt drafts");
assert(html.includes("review-items"), "fee web must show and decide review items");
assert(html.includes("算定候補・レビュー支援"), "fee web must clearly label candidate/review-support mode");
assert(html.includes("確定請求ではありません"), "fee web must not present output as finalized claims");
assert(html.includes("supportLevel"), "fee web must render support level metadata");
assert(html.includes("reviewRequired"), "fee web must render reviewRequired metadata");
assert(html.includes("coverageLabel"), "fee web must render coverage metadata");
assert(html.includes("patientId"), "fee web must expose patientId selection");
assert(html.includes("facilityId"), "fee web must expose facilityId");
assert(html.includes("departmentId"), "fee web must expose departmentId");
assert(!html.includes("OPERATOR_ACCOUNTS_JSON"), "fee web must not reference old operator auth");
assert(!html.includes("tenant_id"), "fee web must not expose old tenant_id boundary");

console.log("Fee web static validation passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
