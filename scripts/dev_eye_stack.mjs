#!/usr/bin/env node
// 眼科カルテのローカル動作確認用。platform-api と eye-api を1プロセスのメモリストアで起動し、
// デモ組織・職種別アカウント・サンプル患者を用意する。クラウドには一切接続しない。
import { createTotpCode } from "../services/platform-api/src/auth/mfa.js";
import { createPlatformApiServer } from "../services/platform-api/src/server.js";
import { MemoryPlatformStore } from "../services/platform-api/src/store/memory-store.js";
import { createEyeApiServer } from "../services/eye-api/src/server.js";
import { MemoryEyeStore } from "../services/eye-api/src/store/memory-store.js";
import { todayInJapan } from "./lib/eye-demo-dataset.mjs";
import { loadEyeDemoData } from "./lib/eye-demo-loader.mjs";

export const LOCAL_ORGANIZATION_CODE = "eye-local";
export const LOCAL_PASSWORD = "eye-local-password-2026";
export const LOCAL_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
export const LOCAL_ACCOUNTS = Object.freeze([
  { loginId: "director", displayName: "院長（管理者・医師）", globalRoles: ["org_admin"], productRoles: { eye: ["admin", "doctor"] } },
  { loginId: "doctor", displayName: "医師", globalRoles: [], productRoles: { eye: ["doctor"] } },
  { loginId: "orthoptist", displayName: "視能訓練士", globalRoles: [], productRoles: { eye: ["orthoptist"] } },
  { loginId: "clerk", displayName: "医療事務", globalRoles: [], productRoles: { eye: ["medical_clerk"] } }
]);

export async function startLocalEyeStack({ platformPort = 8086, eyePort = 8087, seedSamples = true, demo = false } = {}) {
  process.env.HOMIS_SIDECAR_ENABLED ||= "false";
  const platformStore = new MemoryPlatformStore();
  const organization = platformStore.createOrganization({ organizationCode: LOCAL_ORGANIZATION_CODE, displayName: "ローカル眼科" });
  for (const account of LOCAL_ACCOUNTS) {
    platformStore.createMember(organization.orgId, { ...account, password: LOCAL_PASSWORD });
    const identity = platformStore.getLoginIdentity(LOCAL_ORGANIZATION_CODE, account.loginId);
    platformStore.completeMfaEnrollment(platformStore.beginMfaEnrollment(identity, LOCAL_TOTP_SECRET));
  }
  platformStore.upsertProductEntitlement(organization.orgId, { productId: "eye", status: "enabled" });
  if (seedSamples && !demo) {
    platformStore.createPatient(organization.orgId, { displayName: "見本 花子", displayNameKana: "ミホン ハナコ", birthDate: "1956-03-12", sex: "female", primaryPatientNumber: "1001" });
    platformStore.createPatient(organization.orgId, { displayName: "試験 一郎", displayNameKana: "シケン イチロウ", birthDate: "1948-11-02", sex: "male", primaryPatientNumber: "1002" });
  }
  const eyeStore = new MemoryEyeStore();
  if (demo) {
    await loadEyeDemoData({ platformStore, eyeStore, orgId: organization.orgId, today: todayInJapan() });
  }
  const platformServer = createPlatformApiServer({ store: platformStore, env: "local", sidecarEnabled: false }).listen(platformPort);
  const eyeServer = createEyeApiServer({ platformStore, eyeStore, env: "local" }).listen(eyePort);
  return {
    platformStore,
    eyeStore,
    close: () => Promise.all([
      new Promise((resolve) => platformServer.close(resolve)),
      new Promise((resolve) => eyeServer.close(resolve))
    ])
  };
}

export function currentLocalTotp() {
  return createTotpCode(LOCAL_TOTP_SECRET);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = process.argv.includes("--demo");
  await startLocalEyeStack({ demo });
  console.log(`platform-api :8086 / eye-api :8087 (memory${demo ? "・デモデータ入り" : ""})`);
  console.log(`病院コード ${LOCAL_ORGANIZATION_CODE} / ID ${LOCAL_ACCOUNTS.map((account) => account.loginId).join(", ")} / パスワード ${LOCAL_PASSWORD}`);
  console.log(`二段階認証コードは次で表示: node -e 'import("./scripts/dev_eye_stack.mjs").then(m=>console.log(m.currentLocalTotp()))'`);
  console.log("eye-web: PLATFORM_PROXY_TARGET=http://127.0.0.1:8086 EYE_PROXY_TARGET=http://127.0.0.1:8087 npm run dev --workspace @halunasu/eye-web");
}
