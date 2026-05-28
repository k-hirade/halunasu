import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlatformStoreFromEnv, LazyFirestorePlatformStore } from "../src/store/create-store.js";
import { MemoryPlatformStore } from "../src/store/memory-store.js";

test("creates memory store by default", () => {
  const store = createPlatformStoreFromEnv({});

  assert.ok(store instanceof MemoryPlatformStore);
});

test("creates lazy firestore store when requested", () => {
  const store = createPlatformStoreFromEnv({
    PLATFORM_STORE_BACKEND: "firestore",
    GOOGLE_CLOUD_PROJECT: "medical-core-stg"
  });

  assert.ok(store instanceof LazyFirestorePlatformStore);
});

test("lazy firestore store exposes platform API surface", () => {
  const store = createPlatformStoreFromEnv({
    PLATFORM_STORE_BACKEND: "firestore",
    GOOGLE_CLOUD_PROJECT: "medical-core-stg"
  });
  const methods = [
    "createOrganization",
    "updateOrganization",
    "createSignupApplication",
    "createSignupApplicationWithEmailToken",
    "getSignupApplication",
    "listSignupApplications",
    "verifySignupEmail",
    "setupAdminPassword",
    "createMember",
    "updateMember",
    "getLoginIdentity",
    "recordLoginSuccess",
    "beginMfaEnrollment",
    "createFacility",
    "updateFacility",
    "createDepartment",
    "updateDepartment",
    "createPatient",
    "updatePatient",
    "upsertProductEntitlement",
    "updateProductEntitlement",
    "createAuditEvent",
    "createDataRequest",
    "listDataRequests",
    "getDataRequest",
    "updateDataRequest",
    "consumeRateLimit"
  ];

  for (const method of methods) {
    assert.equal(typeof store[method], "function", method);
  }
});

test("rejects unsupported store backend", () => {
  assert.throws(
    () => createPlatformStoreFromEnv({ PLATFORM_STORE_BACKEND: "unknown" }),
    /Unsupported/
  );
});
