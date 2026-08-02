import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCareFeeEnvironmentRegistration,
  normalizeCloudRunUrl
} from "../register_care_fee_environment.mjs";

const SITE_ID = "12345678-1234-4abc-8def-1234567890ab";
const API_URL = "https://care-fee-api-stg-example-an.a.run.app";

test("registers a planned Care Fee environment without changing other environments", () => {
  const sites = fixtureSites();
  const proxyTargets = fixtureTargets();
  const result = buildCareFeeEnvironmentRegistration({
    env: "stg",
    siteId: SITE_ID,
    careFeeApiUrl: `${API_URL}/`,
    sites,
    proxyTargets
  });

  assert.equal(result.sites.stg["care-fee-web"].siteId, SITE_ID);
  assert.equal(result.sites.stg["care-fee-web"].provisioningStatus, "registered");
  assert.equal(result.proxyTargets.stg.careFee, API_URL);
  assert.equal(result.sites.prod["care-fee-web"].siteId, null);
  assert.equal(result.proxyTargets.prod.careFee, null);
  assert.equal(sites.stg["care-fee-web"].siteId, null, "input config must not be mutated");
});

test("registration is idempotent for the same values", () => {
  const first = buildCareFeeEnvironmentRegistration({
    env: "stg",
    siteId: SITE_ID,
    careFeeApiUrl: API_URL,
    sites: fixtureSites(),
    proxyTargets: fixtureTargets()
  });
  const second = buildCareFeeEnvironmentRegistration({
    env: "stg",
    siteId: SITE_ID,
    careFeeApiUrl: API_URL,
    sites: first.sites,
    proxyTargets: first.proxyTargets
  });

  assert.equal(second.siteId, SITE_ID);
  assert.equal(second.careFeeApiUrl, API_URL);
});

test("refuses to overwrite a different registered site or API", () => {
  const sites = fixtureSites();
  sites.stg["care-fee-web"].siteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.throws(() => buildCareFeeEnvironmentRegistration({
    env: "stg",
    siteId: SITE_ID,
    careFeeApiUrl: API_URL,
    sites,
    proxyTargets: fixtureTargets()
  }), /already registered with a different value/u);

  const proxyTargets = fixtureTargets();
  proxyTargets.stg.careFee = "https://care-fee-api-stg-old-an.a.run.app";
  assert.throws(() => buildCareFeeEnvironmentRegistration({
    env: "stg",
    siteId: SITE_ID,
    careFeeApiUrl: API_URL,
    sites: fixtureSites(),
    proxyTargets
  }), /already registered with a different value/u);
});

test("accepts only a root HTTPS Cloud Run URL", () => {
  assert.equal(normalizeCloudRunUrl(`${API_URL}/`), API_URL);
  for (const invalid of [
    "http://care-fee-api-stg-example-an.a.run.app",
    `${API_URL}/readyz`,
    `${API_URL}?env=stg`,
    "https://care.example.com"
  ]) {
    assert.throws(() => normalizeCloudRunUrl(invalid));
  }
});

function fixtureSites() {
  return {
    stg: { "care-fee-web": { siteId: null, provisioningStatus: "planned" } },
    prod: { "care-fee-web": { siteId: null, provisioningStatus: "planned" } }
  };
}

function fixtureTargets() {
  return {
    stg: { careFee: null },
    prod: { careFee: null }
  };
}
