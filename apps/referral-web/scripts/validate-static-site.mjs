import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = ["index.html", "package.json", "README.md"];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const html = readFileSync(join(root, "index.html"), "utf8");

assert(html.includes("/v1/auth/login"), "referral web must log in through Platform");
assert(html.includes("/v1/referral/patients"), "referral web must create patients through referral-api");
assert(html.includes("/v1/referral/facilities"), "referral web must load Platform facilities through referral-api");
assert(html.includes("/v1/referral/departments"), "referral web must load Platform departments through referral-api");
assert(html.includes("/v1/referral/referrals"), "referral web must create referral drafts through referral-api");
assert(html.includes("/document"), "referral web must render referral documents through referral-api");
assert(html.includes("patientId"), "referral web must expose patientId selection");
assert(html.includes("facilityId"), "referral web must expose facilityId");
assert(html.includes("departmentId"), "referral web must expose departmentId");
assert(!html.includes("/v1/charting/"), "referral web must not read charting product routes directly");
assert(!html.includes("/v1/fee/"), "referral web must not read fee product routes directly");

console.log("Referral web static validation passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
