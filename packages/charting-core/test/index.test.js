import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChartingEncounter,
  buildMockSoapDraft,
  patchChartingEncounter
} from "../src/index.js";

test("builds charting encounters with Platform patient references", () => {
  const encounter = buildChartingEncounter({
    orgId: "org_123",
    patientId: "pat_123",
    patientSnapshot: {
      patientId: "pat_123",
      displayName: "山田 太郎",
      snapshotAt: "2026-05-28T00:00:00.000Z"
    },
    facilityId: "fac_123",
    departmentId: "dep_123",
    createdByMemberId: "mem_123",
    visitReason: "咳"
  }, {
    encounterId: "enc_123",
    now: "2026-05-28T00:00:00.000Z"
  });

  assert.equal(encounter.encounterId, "enc_123");
  assert.equal(encounter.patientId, "pat_123");
  assert.equal(encounter.patientSnapshot.displayName, "山田 太郎");
  assert.equal(encounter.facilityId, "fac_123");
  assert.equal(encounter.departmentId, "dep_123");
});

test("patches encounter-owned metadata only", () => {
  const encounter = buildChartingEncounter({
    orgId: "org_123",
    patientId: "pat_123",
    createdByMemberId: "mem_123"
  }, {
    encounterId: "enc_123",
    now: "2026-05-28T00:00:00.000Z"
  });
  const patched = patchChartingEncounter(encounter, {
    title: "初診",
    transcript: "咳が続く"
  }, {
    now: "2026-05-28T01:00:00.000Z"
  });

  assert.equal(patched.title, "初診");
  assert.equal(patched.transcript, "咳が続く");
  assert.equal(patched.updatedAt, "2026-05-28T01:00:00.000Z");
});

test("builds product-owned mock SOAP drafts", () => {
  const encounter = buildChartingEncounter({
    orgId: "org_123",
    patientId: "pat_123",
    patientSnapshot: { patientId: "pat_123", displayName: "山田 太郎" },
    createdByMemberId: "mem_123",
    visitReason: "咳"
  }, {
    encounterId: "enc_123",
    now: "2026-05-28T00:00:00.000Z"
  });
  const draft = buildMockSoapDraft(encounter, {
    transcript: "咳が続く。発熱なし。"
  }, {
    soapDraftId: "soap_123",
    now: "2026-05-28T00:10:00.000Z"
  });

  assert.equal(draft.soapDraftId, "soap_123");
  assert.equal(draft.patientSnapshot.displayName, "山田 太郎");
  assert.match(draft.outputText, /S\n咳/);
  assert.equal(draft.provider, "mock");
});
