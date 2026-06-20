import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addReferralImport,
  attachReferralDocument,
  buildReferralReviewChecklist,
  buildReferralDraft,
  finalizeReferral,
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

test("tracks form sections and source evidence from imported clinical text", () => {
  const draft = buildReferralDraft({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    departmentId: "dep_123",
    authorMemberId: "mem_123",
    recipientInstitution: { displayName: "紹介先病院" },
    recipientDoctor: { displayName: "紹介 先生" },
    purpose: "精査依頼",
    clinicalSummary: "腹痛が続いています。"
  }, {
    referralId: "ref_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  const imported = addReferralImport(draft, {
    sourceProduct: "charting",
    sourceType: "encounter",
    sourceId: "enc_001",
    sourceSnapshot: {
      clinicalText: "S：腹痛。\nO：腹部圧痛あり。\nA：腹痛症。\nP：内視鏡検査を相談。"
    }
  }, {
    importId: "src_001",
    now: new Date("2026-05-28T01:00:00.000Z")
  });

  assert.equal(imported.sourceEvidenceRefs.length, 1);
  assert.equal(imported.sourceEvidenceRefs[0].sourceProduct, "charting");
  assert.match(imported.referralFormSections.clinicalCourseAndFindings, /腹痛/);
  assert.deepEqual(imported.referralFormSections.diagnoses, ["腹痛症"]);
  assert.deepEqual(imported.sectionEvidence.diagnoses, ["evidence_src_001"]);
});

test("blocks finalization until required review checklist items are complete", () => {
  const draft = buildReferralDraft({
    orgId: "org_123",
    patientId: "pat_123",
    facilityId: "fac_123",
    departmentId: "dep_123",
    authorMemberId: "mem_123",
    recipientInstitution: { displayName: "紹介先病院" },
    recipientDoctor: { displayName: "紹介 先生" },
    purpose: "精査依頼",
    clinicalSummary: "咳嗽が持続しています。"
  }, {
    referralId: "ref_001",
    now: new Date("2026-05-28T00:00:00.000Z")
  });

  assert.throws(() => finalizeReferral(draft, { status: "ready" }, {
    memberId: "mem_123",
    now: new Date("2026-05-28T01:00:00.000Z")
  }), /unresolved required review items/);

  const complete = patchReferralDraft(draft, {
    diagnoses: ["咳嗽"],
    requestedAction: "ご高診をお願いします。",
    referralFormSections: {
      referralPurpose: "精査依頼",
      clinicalCourseAndFindings: "咳嗽が持続しています。",
      diagnoses: ["咳嗽"],
      requestedAction: "ご高診をお願いします。"
    }
  }, {
    now: new Date("2026-05-28T01:30:00.000Z")
  });
  const checklist = buildReferralReviewChecklist(complete);
  const finalized = finalizeReferral(complete, { status: "ready" }, {
    memberId: "mem_123",
    memberSnapshot: { memberId: "mem_123", displayName: "紹介 医師" },
    now: new Date("2026-05-28T02:00:00.000Z")
  });

  assert.equal(checklist.every((item) => item.required === false || item.status === "passed"), true);
  assert.equal(finalized.status, "ready");
  assert.equal(finalized.finalizedByMemberSnapshot.displayName, "紹介 医師");
});
