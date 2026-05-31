import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = ["index.html", "package.json", "README.md"];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const html = readFileSync(join(root, "index.html"), "utf8");

assert(html.includes("/v1/auth/login"), "fee web must log in through Platform");
assert(html.includes("data-icon"), "fee web must use shared SOAP-style icons");
assert(html.includes("mfaCode"), "fee web must support Platform MFA login");
assert(html.includes('id="mfa-gate"'), "fee web must use a separate MFA gate like charting");
assert(html.includes("/v1/auth/mfa/enroll"), "fee web must support Platform MFA enrollment");
assert(html.includes("/v1/auth/mfa/verify"), "fee web must support Platform MFA verification");
assert(html.includes("/v1/fee/patients"), "fee web must create patients through fee-api");
assert(html.includes("/v1/fee/facilities"), "fee web must load Platform facilities through fee-api");
assert(html.includes("/v1/fee/departments"), "fee web must load Platform departments through fee-api");
assert(html.includes("/v1/fee/sessions"), "fee web must create fee sessions through fee-api");
assert(html.includes('id="start-fee-session-button"'), "fee web must expose a charting-like quick start action");
assert(html.includes("クイックスタート"), "fee web must keep the charting-like quick start block");
assert(html.includes('class="session-history home-only"'), "fee web home must show session history as the primary surface");
assert(html.includes('id="fee-session-detail"'), "fee web must separate fee session detail from the home history screen");
assert(html.includes('id="back-to-fee-sessions-button"'), "fee web detail must provide a back-to-history action");
assert(html.includes("method: \"PATCH\""), "fee web must update draft fee sessions instead of recreating from the detail form");
assert(html.includes('href="${escapeHtml(feeSessionDetailPath(session.feeSessionId))}"'), "fee web session cards must link to /sessions/{feeSessionId}");
assert(html.includes("window.history.pushState"), "fee web must update the URL when a fee session is opened");
assert(html.includes('window.addEventListener("popstate"'), "fee web must handle browser back/forward for fee sessions");
assert(html.includes("syncSelectedFeeSessionFromRoute"), "fee web must restore a fee session from /sessions/{feeSessionId} on reload");
assert(html.includes("/calculate"), "fee web must run the fee calculation endpoint");
assert(html.includes("/detail"), "fee web must load fee session detail in one request");
assert(html.includes("receiptDraft"), "fee web must show Core receipt drafts");
assert(html.includes("review-items"), "fee web must show and decide review items");
assert(html.includes("算定候補・レビュー支援"), "fee web must clearly label candidate/review-support mode");
assert(html.includes("確定請求ではありません"), "fee web must not present output as finalized claims");
assert(html.includes("supportLevel"), "fee web must render support level metadata");
assert(html.includes("reviewRequired"), "fee web must render reviewRequired metadata");
assert(html.includes("coverageLabel"), "fee web must render coverage metadata");
assert(html.includes("patientId"), "fee web must expose patientId selection");
assert(html.includes("facilityId"), "fee web must expose facilityId");
assert(html.includes("departmentId"), "fee web must expose departmentId");
assert(html.includes("toUserFacingErrorMessage"), "fee web must convert technical errors before UI display");
assert(!html.includes("showMessage(error.message"), "fee web must not display raw error.message in toast");
assert(!html.includes("showLoginMessage(error.message"), "fee web must not display raw login errors");
assert(!html.includes("showMfaMessage(error.message"), "fee web must not display raw MFA errors");
assert(!html.includes("OPERATOR_ACCOUNTS_JSON"), "fee web must not reference old operator auth");
assert(!html.includes("tenant_id"), "fee web must not expose old tenant_id boundary");

console.log("Fee web static validation passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
