import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = ["index.html", "package.json", "README.md"];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const html = readFileSync(join(root, "index.html"), "utf8");

assert(html.includes("/v1/auth/login"), "charting web must log in through Platform");
assert(html.includes("/v1/charting/patients"), "charting web must create patients through charting-api");
assert(html.includes("/v1/charting/encounters"), "charting web must create encounters through charting-api");
assert(html.includes("patientId"), "charting web must expose patientId selection");
assert(html.includes("facilityId"), "charting web must expose facilityId");
assert(html.includes("departmentId"), "charting web must expose departmentId");
assert(!html.includes("contact-signup"), "charting web must not own signup");

console.log("Charting web static validation passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
