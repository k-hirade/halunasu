// 利用者の一覧に最終ログインとパスワード更新の日時を添える（眼科カルテの施設管理「利用者管理」の列）。
// 識別情報から読むだけで、利用者の記録には書き込まない。
import assert from "node:assert/strict";
import { test } from "node:test";
import { FirestorePlatformStore } from "../src/store/firestore-store.js";
import { MemoryPlatformStore } from "../src/store/memory-store.js";

test("member list carries last login and password update times without storing them on the member", () => {
  let now = new Date("2026-11-01T00:00:00.000Z");
  const store = new MemoryPlatformStore({ now: () => now });
  const organization = store.createOrganization({ organizationCode: "Clinic", displayName: "Clinic" });
  const withLogin = store.createMember(organization.orgId, { loginId: "doctor", displayName: "医師", password: "correct horse battery staple" });
  store.createMember(organization.orgId, { loginId: "nologin", displayName: "ログインなし" });

  let listed = store.listMembers(organization.orgId);
  assert.equal(listed[0].passwordUpdatedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(listed[0].lastLoginAt, undefined);
  assert.equal("lastLoginAt" in listed[1], false, "members without a login identity have no times");

  now = new Date("2026-11-02T09:30:00.000Z");
  store.recordLoginSuccess(store.getLoginIdentity("clinic", "doctor"));
  now = new Date("2026-11-03T10:00:00.000Z");
  store.updateMember(organization.orgId, withLogin.memberId, { password: "another correct horse battery" });
  listed = store.listMembers(organization.orgId);
  assert.equal(listed[0].lastLoginAt, "2026-11-02T09:30:00.000Z");
  assert.equal(listed[0].passwordUpdatedAt, "2026-11-03T10:00:00.000Z");
  assert.equal(store.getMember(organization.orgId, withLogin.memberId).lastLoginAt, undefined, "the member record itself is unchanged");
});

test("firestore member view reads the same times from the login identity", () => {
  const view = FirestorePlatformStore.prototype.applyMemberMfaState.call({}, { memberId: "mem_1", loginId: "doctor" }, { mfaRequired: true, mfaEnrolled: false, lastLoginAt: "2026-11-02T09:30:00.000Z", passwordUpdatedAt: "2026-11-01T00:00:00.000Z", passwordHash: "secret" });
  assert.equal(view.lastLoginAt, "2026-11-02T09:30:00.000Z");
  assert.equal(view.passwordUpdatedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(view.passwordHash, undefined, "secrets from the identity never reach the member view");
  assert.equal(view.mfaRequired, true);
});
