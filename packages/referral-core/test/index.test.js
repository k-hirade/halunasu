import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachReferralDocument,
  buildReferralDraft,
  patchReferralDraft
} from "../src/index.js";

test("builds Platform-scoped referral drafts", () => {
  const draft = buildReferralDraft({
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
  }, {
    referralId: "ref_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.equal(draft.referralId, "ref_001");
  assert.equal(draft.orgId, "org_123");
  assert.equal(draft.patientId, "pat_123");
  assert.equal(draft.authorMemberId, "mem_123");
  assert.equal(draft.recipientInstitutionSnapshot.displayName, "紹介先病院");
  assert.equal(draft.recipientDoctorSnapshot.snapshotAt, "2026-05-28T00:00:00.000Z");
});

test("patches product-owned draft fields and creates printable document", () => {
  const draft = buildReferralDraft({
    orgId: "org_123",
    patientId: "pat_123",
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
  }, {
    referralId: "ref_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });
  const patched = patchReferralDraft(draft, {
    status: "ready",
    medications: ["内服薬A"]
  }, {
    now: new Date("2026-05-28T01:00:00.000Z")
  });
  const withDocument = attachReferralDocument(patched, {}, {
    documentArtifactId: "doc_001",
    now: new Date("2026-05-28T02:00:00.000Z")
  });

  assert.equal(patched.status, "ready");
  assert.deepEqual(patched.medications, ["内服薬A"]);
  assert.equal(withDocument.status, "document_ready");
  assert.equal(withDocument.documentArtifact.provider, "halunasu_html");
  assert.match(withDocument.documentArtifact.renderedText, /診療情報提供書/);
  assert.match(withDocument.documentArtifact.renderedHtml, /<!doctype html>/);
});
