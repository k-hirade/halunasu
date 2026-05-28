import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryChartingStore } from "../src/store/memory-store.js";

test("stores charting encounters by organization", () => {
  let counter = 0;
  const store = new MemoryChartingStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const encounter = store.createEncounter({
    orgId: "org_123",
    patientId: "pat_123",
    patientSnapshot: {
      patientId: "pat_123",
      displayName: "山田 太郎",
      snapshotAt: "2026-05-28T00:00:00.000Z"
    },
    createdByMemberId: "mem_123",
    facilityId: "fac_123",
    departmentId: "dep_123"
  });
  const updated = store.updateEncounter("org_123", encounter.encounterId, {
    transcript: "咳が続く"
  });
  const result = store.createMockSoapDraft("org_123", encounter.encounterId, {
    transcript: updated.transcript
  });

  assert.equal(encounter.encounterId, "enc_001");
  assert.equal(updated.transcript, "咳が続く");
  assert.equal(result.encounter.status, "soap_ready");
  assert.equal(result.soapDraft.soapDraftId, "soap_002");
  assert.equal(store.listSoapDrafts("org_123", encounter.encounterId).length, 1);
});
