import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryReferralStore } from "../src/store/memory-store.js";

test("stores referral drafts by organization and creates PDF placeholders", () => {
  let counter = 0;
  const store = new MemoryReferralStore({
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_${String(++counter).padStart(3, "0")}`
  });
  const referral = store.createReferral({
    orgId: "org_123",
    patientId: "pat_123",
    patientSnapshot: {
      patientId: "pat_123",
      displayName: "山田 太郎",
      snapshotAt: "2026-05-28T00:00:00.000Z"
    },
    facilityId: "fac_123",
    departmentId: "dep_123",
    authorMemberId: "mem_123",
    recipientInstitution: {
      displayName: "紹介先病院"
    },
    recipientDoctor: {
      displayName: "紹介 先生"
    },
    purpose: "精査依頼",
    clinicalSummary: "咳嗽が持続しています。"
  });
  const updated = store.updateReferral("org_123", referral.referralId, {
    status: "ready"
  });
  const result = store.createPdfPlaceholder("org_123", referral.referralId, {});

  assert.equal(referral.referralId, "ref_001");
  assert.equal(updated.status, "ready");
  assert.equal(result.pdfPlaceholder.pdfPlaceholderId, "pdf_002");
  assert.equal(result.pdfPlaceholder.provider, "placeholder");
  assert.equal(store.listReferrals("org_123").length, 1);
});
