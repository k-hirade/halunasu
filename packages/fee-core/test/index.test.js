import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMockCalculation,
  buildFeeSession,
  buildMockFeeCalculation
} from "../src/index.js";

test("builds Platform-scoped fee sessions", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    patientId: "pat_123",
    patientRef: "legacy-001",
    patientSnapshot: {
      patientId: "pat_123",
      displayName: "山田 太郎",
      snapshotAt: "2026-05-28T00:00:00.000Z"
    },
    facilityId: "fac_123",
    facilitySnapshot: {
      facilityId: "fac_123",
      displayName: "春ナスクリニック",
      medicalInstitutionCode: "1312345",
      regionalBureau: "kanto-shinetsu",
      snapshotAt: "2026-05-28T00:00:00.000Z"
    },
    createdByMemberId: "mem_123",
    serviceDate: "2026-05-28",
    orders: [
      {
        orderId: "ord_1",
        orderType: "lab",
        localName: "血液検査"
      }
    ]
  }, {
    feeSessionId: "fee_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.equal(session.feeSessionId, "fee_001");
  assert.equal(session.orgId, "org_123");
  assert.equal(session.patientId, "pat_123");
  assert.equal(session.patientRef, "legacy-001");
  assert.equal(session.facilitySnapshot.medicalInstitutionCode, "1312345");
});

test("creates deterministic mock calculation without external providers", () => {
  const session = buildFeeSession({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    facilitySnapshot: {
      facilityId: "fac_123",
      displayName: "春ナスクリニック",
      medicalInstitutionCode: "1312345",
      regionalBureau: "kanto-shinetsu"
    },
    createdByMemberId: "mem_123",
    serviceDate: "2026-05-28",
    orders: [
      {
        orderId: "ord_1",
        orderType: "drug",
        localName: "内服薬",
        quantity: 2
      }
    ]
  }, {
    feeSessionId: "fee_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });
  const calculation = buildMockFeeCalculation(session, {}, {
    calculationId: "calc_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });
  const updated = applyMockCalculation(session, {}, {
    calculationId: "calc_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.equal(calculation.provider, "mock");
  assert.equal(calculation.totalPoints, 424);
  assert.equal(calculation.facility.medicalInstitutionCode, "1312345");
  assert.equal(updated.status, "calculated");
  assert.equal(updated.latestCalculationId, "calc_001");
});
