import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryChartingStore } from "../../charting-api/src/store/memory-store.js";
import { handleChartingFinalizeRequest } from "../src/server.js";

test("creates mock SOAP draft for an existing encounter", async () => {
  let counter = 0;
  const chartingStore = new MemoryChartingStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const encounter = chartingStore.createEncounter({
    orgId: "org_123",
    patientId: "pat_123",
    createdByMemberId: "mem_123",
    visitReason: "咳"
  });
  const response = await handleChartingFinalizeRequest({
    method: "POST",
    path: "/internal/charting/finalize",
    headers: { "x-internal-secret": "secret" },
    internalSecret: "secret",
    chartingStore,
    body: {
      orgId: "org_123",
      encounterId: encounter.encounterId,
      transcript: "咳が続く"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.encounter.status, "soap_ready");
  assert.equal(response.body.soapDraft.provider, "mock");
});

test("rejects invalid internal secret", async () => {
  const response = await handleChartingFinalizeRequest({
    method: "POST",
    path: "/internal/charting/finalize",
    headers: { "x-internal-secret": "wrong" },
    internalSecret: "secret",
    chartingStore: new MemoryChartingStore(),
    body: {}
  });

  assert.equal(response.statusCode, 401);
});
