import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSource = await readFile(path.resolve(here, "../extension/lib/api.js"), "utf8");

test("the live IIFE client reuses access, refreshes near expiry, and single-flights concurrent refreshes", async () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const harness = createApiHarness(now);
  const { api, clock, feeRequests, platformTokenRequests, storage } = harness;

  await api.connectWithStoredGrant();
  assert.equal(platformTokenRequests.length, 1);

  await api.calculate({ contractVersion: "v1", externalPatientId: "patient-1" });
  await api.setCandidateAcknowledgement({
    sidecarDraftId: "draft-1",
    candidateKey: "candidate-1",
    status: "acknowledged"
  });
  await api.setPatientChargeSetting({
    sidecarDraftId: "draft-1",
    handling: "charge"
  });
  await api.setPatientChargeSetting({
    sidecarDraftId: "draft-1",
    handling: "unknown"
  });

  assert.equal(platformTokenRequests.length, 1, "the four Fee API calls reuse the connection token");
  assert.deepEqual(
    feeRequests.map((request) => request.options.headers.authorization),
    ["Bearer access-1", "Bearer access-1", "Bearer access-1", "Bearer access-1"]
  );
  assert.equal(JSON.parse(feeRequests[1].options.body).status, "acknowledged");
  assert.deepEqual(JSON.parse(feeRequests[3].options.body), {
    contractVersion: "v1",
    chargeType: "home_medical_transport",
    clear: true
  });

  clock.now = platformTokenRequests[0].expiresAtMs - 30_000;
  await api.calculate({ contractVersion: "v1", externalPatientId: "patient-1" });
  assert.equal(platformTokenRequests.length, 2, "an access token at the 30 second boundary is refreshed once");
  assert.equal(feeRequests.at(-1).options.headers.authorization, "Bearer access-2");

  clock.now = platformTokenRequests[1].expiresAtMs - 30_000;
  const releaseRefresh = harness.holdNextTokenResponse();
  const concurrentRequests = [
    api.calculate({ contractVersion: "v1", externalPatientId: "patient-1" }),
    api.setCandidateAcknowledgement({
      sidecarDraftId: "draft-1",
      candidateKey: "candidate-1",
      status: "unacknowledged"
    })
  ];
  await harness.waitForTokenRequestCount(3);
  assert.equal(platformTokenRequests.length, 3, "concurrent Fee API calls share one token refresh");
  releaseRefresh();
  await Promise.all(concurrentRequests);

  assert.deepEqual(
    feeRequests.slice(-2).map((request) => request.options.headers.authorization),
    ["Bearer access-3", "Bearer access-3"]
  );
  assert.deepEqual(
    Object.keys(storage).sort(),
    ["halunasuSidecar:stg:deviceId", "halunasuSidecar:stg:grantId"]
  );
  assert.equal(Object.values(storage).some((value) => /^access-|verifier/u.test(String(value))), false);
});

test("clearing a grant invalidates an access refresh that is already in flight", async () => {
  const harness = createApiHarness(Date.parse("2026-08-03T12:00:00.000Z"));
  const { api, clock, feeRequests, platformTokenRequests, storage } = harness;
  const grantKey = "halunasuSidecar:stg:grantId";

  await api.connectWithStoredGrant();
  clock.now = platformTokenRequests[0].expiresAtMs - 30_000;
  const releaseRefresh = harness.holdNextTokenResponse();
  const calculation = api.calculate({ contractVersion: "v1", externalPatientId: "patient-1" });
  await harness.waitForTokenRequestCount(2);

  await api.clearGrant();
  releaseRefresh();
  await assert.rejects(calculation, (error) => error?.code === "grant_missing" && error?.status === 401);
  assert.equal(feeRequests.length, 0);
  assert.equal(grantKey in storage, false);

  storage[grantKey] = "grant-1";
  await api.calculate({ contractVersion: "v1", externalPatientId: "patient-1" });
  assert.equal(platformTokenRequests.length, 3, "the response invalidated by disconnect was not restored to memory");
  assert.equal(feeRequests[0].options.headers.authorization, "Bearer access-3");
});

function createApiHarness(initialNow) {
  const clock = { now: initialNow };
  const storage = { "halunasuSidecar:stg:grantId": "grant-1" };
  const platformTokenRequests = [];
  const feeRequests = [];
  let heldTokenResponse = null;

  class HarnessDate extends Date {
    static now() {
      return clock.now;
    }
  }

  const fetch = async (url, options = {}) => {
    if (url === "https://platform.example/v1/auth/sidecar-token") {
      const sequence = platformTokenRequests.length + 1;
      const expiresAtMs = clock.now + 5 * 60_000;
      const request = {
        body: JSON.parse(options.body),
        expiresAtMs,
        sequence
      };
      platformTokenRequests.push(request);
      if (heldTokenResponse) {
        await heldTokenResponse.promise;
        heldTokenResponse = null;
      }
      return jsonResponse({
        accessToken: `access-${sequence}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
        grantId: request.body.grantId,
        sidecarContext: { facilityId: "facility-1", departmentId: "department-1" }
      });
    }
    if (url.startsWith("https://fee.example/")) {
      feeRequests.push({ url, options });
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const context = vm.createContext({
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    chrome: {
      runtime: { id: "sidecar-test" },
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]]));
          },
          async remove(keys) {
            for (const key of keys) {
              delete storage[key];
            }
          },
          async set(values) {
            Object.assign(storage, values);
          }
        }
      }
    },
    crypto: webcrypto,
    Date: HarnessDate,
    fetch,
    HalunasuSidecarConfig: {
      environment: "stg",
      platformBaseUrl: "https://platform.example",
      feeBaseUrl: "https://fee.example",
      approvalBaseUrl: "https://approval.example/connect"
    },
    TextEncoder,
    URL,
    Uint8Array
  });
  vm.runInContext(apiSource, context, { filename: "extension/lib/api.js" });

  return {
    api: context.HalunasuSidecarApi,
    clock,
    feeRequests,
    holdNextTokenResponse() {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      heldTokenResponse = { promise };
      return release;
    },
    platformTokenRequests,
    storage,
    async waitForTokenRequestCount(expected) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (platformTokenRequests.length >= expected) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.fail(`Expected ${expected} Platform token requests, got ${platformTokenRequests.length}`);
    }
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
