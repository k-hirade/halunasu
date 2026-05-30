#!/usr/bin/env node

import { createPlatformStoreFromEnv, platformProjectId } from "../services/platform-api/src/store/create-store.js";

function readArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

const organizationCode = normalize(readArg("organization-code"));
const loginId = normalize(readArg("login-id"));
const dryRun = !process.argv.includes("--apply");

if (!organizationCode || !loginId) {
  throw new Error("--organization-code and --login-id are required");
}

const env = {
  ...process.env,
  PLATFORM_STORE_BACKEND: process.env.PLATFORM_STORE_BACKEND || process.env.STORE_BACKEND || "firestore"
};
const store = createPlatformStoreFromEnv(env);
const identity = await store.getLoginIdentity(organizationCode, loginId);

if (!identity) {
  throw new Error(`login identity not found: ${organizationCode}:${loginId}`);
}

const result = {
  projectId: platformProjectId(env),
  dryRun,
  organizationCode,
  loginId,
  orgId: identity.orgId,
  memberId: identity.memberId,
  currentTokenVersion: Number(identity.tokenVersion || 0),
  nextTokenVersion: Number(identity.tokenVersion || 0) + 1
};

if (!dryRun) {
  const resetIdentity = await store.resetMemberMfa(identity.orgId, identity.memberId);
  result.nextTokenVersion = Number(resetIdentity.tokenVersion || result.nextTokenVersion);
  result.mfaRequired = Boolean(resetIdentity.mfaRequired);
  result.mfaEnrolled = Boolean(resetIdentity.mfaEnrolled);
}

console.log(JSON.stringify(result, null, 2));
