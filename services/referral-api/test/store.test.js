import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReferralStoreFromEnv,
  LazyFirestoreReferralStore,
  referralProjectId
} from "../src/store/create-store.js";
import { MemoryReferralStore } from "../src/store/memory-store.js";

test("uses referral product project for Firestore", () => {
  const env = {
    REFERRAL_STORE_BACKEND: "firestore",
    REFERRAL_GOOGLE_CLOUD_PROJECT: "halunasu-referral-stg",
    PLATFORM_GOOGLE_CLOUD_PROJECT: "medical-core-stg",
    GOOGLE_CLOUD_PROJECT: "halunasu-referral-stg"
  };
  const store = createReferralStoreFromEnv(env);

  assert.ok(store instanceof LazyFirestoreReferralStore);
  assert.equal(referralProjectId(env), "halunasu-referral-stg");
  assert.equal(store.options.projectId, "halunasu-referral-stg");
});

test("stores referral drafts by organization and creates referral documents", () => {
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
  const result = store.createReferralDocument("org_123", referral.referralId, {});

  assert.equal(referral.referralId, "ref_001");
  assert.equal(updated.status, "ready");
  assert.equal(result.documentArtifact.documentArtifactId, "doc_002");
  assert.equal(result.documentArtifact.provider, "halunasu_html");
  assert.equal(store.listReferrals("org_123").length, 1);
});
