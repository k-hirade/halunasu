import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = ["index.html", "package.json", "README.md"];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const html = readFileSync(join(root, "index.html"), "utf8");

assert(html.includes("/v1/auth/login"), "fee web must log in through Platform");
assert(html.includes("/v1/fee/patients"), "fee web must create patients through fee-api");
assert(html.includes("/v1/fee/facilities"), "fee web must load Platform facilities through fee-api");
assert(html.includes("/v1/fee/departments"), "fee web must load Platform departments through fee-api");
assert(html.includes("/v1/fee/sessions"), "fee web must create fee sessions through fee-api");
assert(html.includes("mock-calculate"), "fee web must run mock calculation without external providers");
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
