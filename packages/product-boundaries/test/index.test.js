import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../../..", import.meta.url).pathname;
const products = Object.freeze({
  charting: {
    service: "charting-api",
    app: "charting-web",
    routePrefix: "/v1/charting/",
    packages: ["charting-contracts", "charting-core"]
  },
  fee: {
    service: "fee-api",
    app: "fee-web",
    routePrefix: "/v1/fee/",
    packages: ["fee-contracts", "fee-core"]
  },
  referral: {
    service: "referral-api",
    app: "referral-web",
    routePrefix: "/v1/referral/",
    packages: ["referral-contracts", "referral-core"]
  }
});

test("product APIs use the shared Platform product context helper", () => {
  for (const product of Object.values(products)) {
    const source = readText(join(root, "services", product.service, "src", "server.js"));

    assert.match(source, /requireProductContext/, `${product.service} must use requireProductContext`);
    assert.equal(source.includes("getProductEntitlement"), false, `${product.service} must not check entitlements inline`);
  }
});

test("product service code does not import sibling product services or packages", () => {
  for (const [productId, product] of Object.entries(products)) {
    const source = readDirectoryText(join(root, "services", product.service, "src"));
    const forbiddenTokens = siblingProductTokens(productId);

    for (const token of forbiddenTokens) {
      assert.equal(source.includes(token), false, `${product.service} must not reference ${token}`);
    }
  }
});

test("product apps do not call sibling product API routes directly", () => {
  for (const [productId, product] of Object.entries(products)) {
    const source = readText(join(root, "apps", product.app, "index.html"));
    const siblingRoutes = Object.entries(products)
      .filter(([candidateId]) => candidateId !== productId)
      .map(([, candidate]) => candidate.routePrefix);

    for (const routePrefix of siblingRoutes) {
      assert.equal(source.includes(routePrefix), false, `${product.app} must not call ${routePrefix}`);
    }
  }
});

function siblingProductTokens(productId) {
  return Object.entries(products)
    .filter(([candidateId]) => candidateId !== productId)
    .flatMap(([, product]) => [
      product.service,
      ...product.packages
    ]);
}

function readDirectoryText(path) {
  return walkFiles(path)
    .filter((file) => /\.(js|mjs|html|md)$/.test(file))
    .map(readText)
    .join("\n");
}

function walkFiles(path) {
  const entries = readdirSync(path);
  return entries.flatMap((entry) => {
    const entryPath = join(path, entry);
    return statSync(entryPath).isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

function readText(path) {
  return readFileSync(path, "utf8");
}
