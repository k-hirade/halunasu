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

test("rejects unsupported store backend", () => {
  assert.throws(
    () => createPlatformStoreFromEnv({ PLATFORM_STORE_BACKEND: "unknown" }),
    /Unsupported/
  );
});

