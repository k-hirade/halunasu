import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const requiredFiles = [
  "index.html",
  "signup.html",
  "privacy.html",
  "terms.html",
  "security.html",
  "tokushoho.html",
  "manual/index.html",
  "manual/harunas-user-manual-v1.pdf",
  "assets/brand/harunas-mark.png",
  "netlify.toml"
];

for (const file of requiredFiles) {
  assert(existsSync(join(root, file)), `${file} is missing`);
}

const index = read("index.html");
const signup = read("signup.html");
const netlify = read("netlify.toml");

assert(!index.includes("app.halunasu.com/contact-signup"), "old contact-signup URL remains");
assert((index.match(/href="signup\.html"/g) || []).length >= 5, "LP CTAs must point to signup.html");
assert(signup.includes("/v1/signup/applications"), "signup form must post to Platform signup API");
assert(signup.includes("/v1/signup/verify-email"), "signup form must support email verification");
assert(signup.includes("/v1/signup/setup-admin-password"), "signup form must support admin password setup");
assert(!signup.includes("startCheckout: true"), "signup form must not start Stripe checkout during the 14-day trial");
assert(!signup.includes("billingCheckout.checkoutUrl"), "signup form must not redirect to Stripe checkout after password setup");
assert(signup.includes("お問い合わせを送信する"), "signup form must keep the legacy contact CTA");
assert(signup.includes("確認メールを送信しました"), "signup form must show the legacy submitted mail state");
assert(signup.includes("[hidden]"), "signup form must force hidden step panels to disappear");
assert(signup.includes("medical.contactSignupDraft.v1"), "signup form must keep the legacy contact draft storage key");
assert(signup.includes("source: \"lp_contact_form\""), "signup form must preserve legacy contact signup source metadata");
assert(signup.includes("利用したいアプリ"), "signup form must expose single app selection");
assert(signup.includes("requestedProducts: [nextForm.requestedProduct]"), "signup form must request only the selected app");
assert(signup.includes("SIGNUP_SELECTABLE_PRODUCTS = new Set([\"charting\"])"), "signup form must keep only charting selectable at launch");
assert(signup.includes("toUserFacingErrorMessage"), "signup form must convert technical errors before UI display");
assert(!signup.includes("setError(signupError, error.message"), "signup form must not display raw signup errors");
assert(!signup.includes("setError(passwordError, error.message"), "signup form must not display raw password errors");
assert(!signup.includes("setError(submittedError, error.message"), "signup form must not display raw verification errors");
assert(!signup.includes("現在の Platform API ではメール送信サービスを追加せず"), "signup form must not expose the temporary no-mail migration note");
assert(!signup.includes("メール確認を完了"), "signup form must not keep the temporary inline verification button");

for (const header of [
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Strict-Transport-Security",
  "Permissions-Policy"
]) {
  assert(netlify.includes(header), `${header} header is missing`);
}

console.log("LP static validation passed");

function read(file) {
  return readFileSync(join(root, file), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
