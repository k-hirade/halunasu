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
assert(signup.includes("startCheckout: true"), "signup form must request Stripe checkout after password setup");
assert(signup.includes("billingCheckout.checkoutUrl"), "signup form must redirect to Stripe checkout URL");
assert(signup.includes('value="referral"'), "future referral product must be selectable");

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
