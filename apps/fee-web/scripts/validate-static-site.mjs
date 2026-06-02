import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = ["index.html", "package.json", "README.md"];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const html = readFileSync(join(root, "index.html"), "utf8");

assert(html.includes("/v1/auth/login"), "fee web must log in through Platform");
assert(html.includes('rel="icon" type="image/png" href="brand/harunas-mark.png"'), "fee web must use the Halunasu browser tab icon");
assert(html.includes('rel="apple-touch-icon" href="brand/harunas-mark.png"'), "fee web must use the Halunasu touch icon");
assert(html.includes('href="web-ui/halunasu-ui.css"'), "fee web must load the shared Halunasu UI stylesheet");
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
assert(html.includes("新しい算定"), "fee web must keep the charting-like quick start block");
assert(html.includes("算定記録を作成"), "fee web must provide a charting-like primary create action");
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
assert(html.includes('id="logout-button"'), "fee web must expose logout from the top navigation");
assert(html.includes("/v1/auth/logout"), "fee web must clear the Platform session on logout");
assert(html.includes('id="facility-admin-link"'), "fee web must link to the facility management app from the top navigation");
assert(html.includes('id="toast-container"'), "fee web must use toast feedback like charting/admin");
assert(html.includes("patientId"), "fee web must expose patientId selection");
assert(html.includes("facilityId"), "fee web must expose facilityId");
assert(html.includes('id="facility-field"'), "fee web must be able to hide the facility field when there is only one facility");
assert(html.includes("departmentId"), "fee web must expose departmentId");
assert(html.includes('id="claimContextText"'), "fee web must expose claimContext JSON for legacy claim payload parity");
assert(html.includes('id="calculationOptionsText"'), "fee web must expose calculationOptions JSON for legacy rule input parity");
assert(html.includes('class="patient-inline-create"'), "fee web must not keep patient creation as an always-expanded form");
assert(html.includes('id="order-editor"'), "fee web must provide structured order row editing");
assert(html.includes('id="add-order-row-button"'), "fee web must allow adding order rows");
assert(html.includes("syncOrderRowsToTextarea"), "fee web must preserve legacy order text compatibility before saving");
assert(html.includes("parseJsonObjectField"), "fee web must validate detailed JSON inputs before saving");
assert(html.includes("material|特定器材"), "fee web must allow material order input");
assert(html.includes("toUserFacingErrorMessage"), "fee web must convert technical errors before UI display");
assert(!html.includes("クイックスタート"), "fee web must not use charting-only quick-start wording");
assert(!html.includes("算定セッション"), "fee web must use user-facing 算定記録 wording instead of internal session wording");
assert(!html.includes("患者ID alias"), "fee web must not expose developer-oriented patient alias wording");
assert(!html.includes("coverage と support level"), "fee web must not expose English coverage/support-level copy");
assert(!html.includes('class="secondary"'), "fee web review actions must use the shared btn classes");
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
