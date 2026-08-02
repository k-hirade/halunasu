import assert from "node:assert/strict";
import { test } from "node:test";
import {
  careFeeProjectId,
  createCareFeeStoreFromEnv,
  LazyFirestoreCareFeeStore
} from "../src/store/create-store.js";
import { MemoryCareFeeStore } from "../src/store/memory-store.js";

test("uses the independent care product project", () => {
  const env = {
    CARE_FEE_STORE_BACKEND: "firestore",
    CARE_FEE_GOOGLE_CLOUD_PROJECT: "halunasu-care-stg",
    PLATFORM_GOOGLE_CLOUD_PROJECT: "medical-core-stg",
    GOOGLE_CLOUD_PROJECT: "halunasu-care-stg"
  };
  const store = createCareFeeStoreFromEnv(env);
  assert.ok(store instanceof LazyFirestoreCareFeeStore);
  assert.equal(careFeeProjectId(env), "halunasu-care-stg");
  assert.equal(store.options.projectId, "halunasu-care-stg");
});

test("spot imports retain only metadata supplied by the API", () => {
  const store = new MemoryCareFeeStore({
    now: () => new Date("2026-08-02T00:00:00.000Z"),
    idFactory: () => "cij_001"
  });
  const job = store.recordImportJob("org_001", {
    mode: "spot_csv",
    sourceFileSha256: "a".repeat(64),
    summary: { rowCount: 3 },
    purgeAt: new Date("2026-09-01T00:00:00.000Z")
  });
  assert.equal(job.importJobId, "cij_001");
  assert.equal("rows" in job, false);
  assert.equal("input" in job, false);
  assert.equal("output" in job, false);
});
