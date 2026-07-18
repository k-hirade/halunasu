#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { hashPassword } from "../services/platform-api/src/auth/password.js";
import {
  departmentPath,
  feeSettingsPath,
  facilityPath,
  loginIdentityPath,
  memberPath,
  organizationCodePath,
  organizationPath,
  patientPath,
  productEntitlementPath
} from "../packages/firestore-schema/src/index.js";
import {
  memberRequiresMfa,
  normalizeLoginId,
  normalizeOrganizationCode
} from "../packages/platform-contracts/src/index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projectByEnv = Object.freeze({
  stg: "medical-core-stg",
  prod: "medical-core-497610"
});

const args = parseArgs(process.argv.slice(2));
if (args.has("help")) {
  printUsage();
  process.exit(0);
}

const targetEnv = args.get("env") || "stg";
const apply = args.get("apply") === "true";
const resetPassword = args.get("reset-password") === "true";
const organizationCode = normalizeOrganizationCode(requiredArg("organization-code"));
const loginIds = csv(args.get("login-ids") || args.get("login-id")).map(normalizeLoginId);
const organizationName = args.get("organization-name") || `${organizationCode} organization`;
const emailDomain = args.get("email-domain") || "";
const products = csv(args.get("products") || "charting,fee,referral");
const facilityStandardKeys = csv(args.get("facility-standard-keys") || args.get("facilityStandardKeys"));
const facilityName = args.get("facility-name") || organizationName;
const departmentName = args.get("department-name") || "General";
const memberRoleProfile = args.get("member-role-profile") || "admin";
const memberDisplayPrefix = args.get("member-display-prefix") || organizationName;
const feeProjectId = args.get("fee-project-id") || "";
const feeSettingsFile = args.get("fee-settings-file") || "";
const feeSettingsTemplate = feeSettingsFile
  ? JSON.parse(await readFile(isAbsolute(feeSettingsFile) ? feeSettingsFile : join(root, feeSettingsFile), "utf8"))
  : null;
const seedDemoPatient = args.get("skip-demo-patient") !== "true";
const envs = targetEnv === "all" ? Object.keys(projectByEnv) : [targetEnv];
const accessToken = getAccessToken();
const password = await resolvePassword();

if (loginIds.length === 0) {
  throw new Error("Missing --login-id or --login-ids");
}
if (!["admin", "fee-demo"].includes(memberRoleProfile)) {
  throw new Error(`Unsupported --member-role-profile: ${memberRoleProfile}`);
}
if (memberRoleProfile === "fee-demo" && (
  !products.includes("fee")
  || products.some((product) => !["fee", "homis_sidecar"].includes(product))
)) {
  throw new Error("--member-role-profile fee-demo requires fee and only supports optional homis_sidecar");
}
if (Boolean(feeProjectId) !== Boolean(feeSettingsTemplate)) {
  throw new Error("--fee-project-id and --fee-settings-file must be specified together");
}
if (feeProjectId && envs.length !== 1) {
  throw new Error("fee settings seed requires a single --env target");
}
for (const env of envs) {
  if (!projectByEnv[env]) {
    throw new Error(`Unknown env: ${env}`);
  }
}
if (apply && !password) {
  throw new Error("Set HALUNASU_SEED_PASSWORD, pass --password-file, or pass --generate-password-file before using --apply");
}

for (const env of envs) {
  const projectId = args.get("project-id") || projectByEnv[env];
  await seedEnv({
    env,
    projectId,
    apply,
    resetPassword,
    password,
    organizationCode,
    organizationName,
    loginIds,
    emailDomain,
    products,
    facilityStandardKeys,
    facilityName,
    departmentName,
    memberRoleProfile,
    memberDisplayPrefix,
    feeProjectId,
    feeSettingsTemplate,
    seedDemoPatient
  });
}

async function seedEnv(input) {
  const actions = [];
  const organization = await ensureOrganization({ input, actions });
  if (!organization) {
    printSummary(input, actions);
    return;
  }

  const facility = await ensureFacility({ input, organization, actions });
  const department = await ensureDepartment({ input, organization, facility, actions });
  const organizationWithDefaults = await ensureOrganizationDefaults({
    input,
    organization,
    facility,
    department,
    actions
  });
  await ensureFeeSettings({ input, organization: organizationWithDefaults, facility, actions });
  await ensureEntitlements({ input, organization: organizationWithDefaults, actions });
  await ensureDemoPatient({ input, organization: organizationWithDefaults, actions });

  const members = [];
  for (const loginId of input.loginIds) {
    members.push(await ensureMember({
      input,
      organization: organizationWithDefaults,
      loginId,
      actions
    }));
  }

  printSummary(input, actions, {
    orgId: organizationWithDefaults.orgId,
    memberIds: members.map((member) => member.memberId),
    facilityId: facility.facilityId,
    departmentId: department.departmentId
  });
}

async function ensureFeeSettings({ input, organization, facility, actions }) {
  if (!input.feeProjectId || !input.feeSettingsTemplate) {
    return;
  }
  const path = feeSettingsPath(organization.orgId, facility.facilityId);
  const current = await getDoc(input.feeProjectId, path);
  const now = timestamp();
  const settings = compactObject({
    ...input.feeSettingsTemplate,
    orgId: organization.orgId,
    facilityId: facility.facilityId,
    schemaVersion: Number(input.feeSettingsTemplate.schemaVersion || 1),
    createdAt: current?.createdAt || now,
    updatedAt: now
  });
  actions.push(`upsert fee settings ${input.feeProjectId}/${facility.facilityId}`);
  if (input.apply) {
    await setDoc(input.feeProjectId, path, settings);
  }
}

async function ensureOrganization({ input, actions }) {
  const codeRecord = await getDoc(input.projectId, organizationCodePath(input.organizationCode));
  if (!codeRecord) {
    actions.push(`create organization ${input.organizationCode}`);
    if (!input.apply) {
      return null;
    }

    const now = timestamp();
    const orgId = createId("org");
    const organization = compactObject({
      orgId,
      organizationCode: input.organizationCode,
      displayName: input.organizationName,
      status: "active",
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
      billing: {
        status: "manual",
        provider: "manual"
      },
      access: {
        status: "active",
        enabledProducts: input.products
      },
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });
    const organizationCodeRecord = {
      organizationCode: input.organizationCode,
      orgId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    };

    await setDoc(input.projectId, organizationPath(orgId), organization);
    await setDoc(input.projectId, organizationCodePath(input.organizationCode), organizationCodeRecord);
    return organization;
  }

  const organization = await getDoc(input.projectId, organizationPath(codeRecord.orgId));
  if (!organization) {
    throw new Error(`organization_codes/${input.organizationCode} points to a missing organization`);
  }

  const updated = compactObject({
    ...organization,
    displayName: organization.displayName || input.organizationName,
    status: "active",
    access: {
      ...(organization.access || {}),
      status: "active",
      enabledProducts: input.products
    },
    updatedAt: timestamp()
  });

  if (JSON.stringify(updated) !== JSON.stringify(organization)) {
    actions.push(`update organization ${organization.orgId} access`);
    if (input.apply) {
      await setDoc(input.projectId, organizationPath(organization.orgId), updated);
    }
  }

  return input.apply ? updated : organization;
}

async function ensureMember({ input, organization, loginId, actions }) {
  const members = await listDocs(input.projectId, organizationPath(organization.orgId), "members");
  const existing = members.find((member) => member.loginId === loginId) || null;
  const now = timestamp();
  const access = memberAccessForSeed(input, loginId);
  const memberBase = compactObject({
    orgId: organization.orgId,
    loginId,
    displayName: access.displayName,
    email: input.emailDomain ? `${loginId}@${input.emailDomain}` : null,
    status: "active",
    globalRoles: access.globalRoles,
    productRoles: access.productRoles,
    facilityIds: [],
    departmentIds: [],
    updatedAt: now,
    schemaVersion: 1
  });

  if (!existing) {
    actions.push(`create member ${loginId}`);
    const memberId = createId("mem");
    const member = {
      memberId,
      ...memberBase,
      createdAt: now
    };
    if (input.apply) {
      await setDoc(input.projectId, memberPath(organization.orgId, memberId), member);
    }
    await ensureLoginIdentity({ input, organization, member, actions });
    return member;
  }

  const member = {
    ...existing,
    ...memberBase,
    memberId: existing.memberId,
    createdAt: existing.createdAt || now
  };
  actions.push(`update member ${loginId} roles`);
  if (input.apply) {
    await setDoc(input.projectId, memberPath(organization.orgId, member.memberId), member);
  }
  await ensureLoginIdentity({ input, organization, member, actions });
  return member;
}

function memberAccessForSeed(input, loginId) {
  if (input.memberRoleProfile !== "fee-demo") {
    return {
      displayName: loginId,
      globalRoles: ["org_admin", "billing_admin"],
      productRoles: Object.fromEntries(input.products.map((product) => [product, ["admin"]]))
    };
  }

  const prefix = String(input.memberDisplayPrefix || input.organizationName || "Demo").trim();
  if (loginId.endsWith("-clerk")) {
    return {
      displayName: `${prefix} 医事課`,
      globalRoles: [],
      productRoles: feeDemoProductRoles(input, ["medical_clerk"], ["medical_clerk"])
    };
  }
  if (loginId.endsWith("-doctor")) {
    return {
      displayName: `${prefix} 医師`,
      globalRoles: [],
      productRoles: feeDemoProductRoles(input, ["doctor"], ["doctor"])
    };
  }
  if (loginId.endsWith("-admin")) {
    return {
      displayName: `${prefix} 管理者`,
      globalRoles: ["org_admin", "billing_admin"],
      productRoles: feeDemoProductRoles(input, ["admin"], ["admin"])
    };
  }
  throw new Error(`fee-demo login ID must end with -admin, -clerk, or -doctor: ${loginId}`);
}

function feeDemoProductRoles(input, feeRoles, sidecarRoles) {
  return {
    fee: feeRoles,
    ...(input.products.includes("homis_sidecar") ? { homis_sidecar: sidecarRoles } : {})
  };
}

async function ensureLoginIdentity({ input, organization, member, actions }) {
  const identityPath = loginIdentityPath(organization.organizationCode, member.loginId);
  const identity = await getDoc(input.projectId, identityPath);
  const now = timestamp();
  const base = compactObject({
    identityKey: `${organization.organizationCode}:${member.loginId}`,
    organizationCode: organization.organizationCode,
    loginId: member.loginId,
    orgId: organization.orgId,
    memberId: member.memberId,
    mfaRequired: memberRequiresMfa(member),
    status: "active",
    failedLoginCount: 0,
    updatedAt: now,
    schemaVersion: 1
  });

  if (!identity) {
    actions.push(`create login identity ${organization.organizationCode}:${member.loginId}`);
    if (input.apply) {
      await setDoc(input.projectId, identityPath, {
        ...base,
        passwordHash: hashPassword(input.password),
        passwordUpdatedAt: now,
        tokenVersion: 1,
        mfaEnrolled: false,
        createdAt: now
      });
    }
    return;
  }

  if (input.resetPassword) {
    actions.push(`reset login password ${organization.organizationCode}:${member.loginId}`);
    if (input.apply) {
      await setDoc(input.projectId, identityPath, {
        ...identity,
        ...base,
        passwordHash: hashPassword(input.password),
        passwordUpdatedAt: now,
        tokenVersion: Number(identity.tokenVersion || 0) + 1
      });
    }
    return;
  }

  actions.push(`confirm login identity ${organization.organizationCode}:${member.loginId}`);
  if (input.apply) {
    await setDoc(input.projectId, identityPath, {
      ...identity,
      ...base,
      tokenVersion: Number(identity.tokenVersion || 1),
      passwordHash: identity.passwordHash,
      passwordUpdatedAt: identity.passwordUpdatedAt,
      mfaEnrolled: Boolean(identity.mfaEnrolled)
    });
  }
}

async function ensureFacility({ input, organization, actions }) {
  const facilities = await listDocs(input.projectId, organizationPath(organization.orgId), "facilities");
  const existing = facilities.find((facility) => facility.status === "active") || facilities[0] || null;
  if (existing) {
    const desiredKeys = Array.isArray(input.facilityStandardKeys) ? input.facilityStandardKeys : [];
    const currentKeys = Array.isArray(existing.facilityStandardKeys) ? existing.facilityStandardKeys : [];
    if (desiredKeys.length && !sameStringSet(currentKeys, desiredKeys)) {
      actions.push(`update facility standards ${input.facilityName}: ${desiredKeys.join(",")}`);
      const patched = {
        ...existing,
        facilityStandardKeys: desiredKeys,
        updatedAt: timestamp()
      };
      if (input.apply) {
        await setDoc(input.projectId, facilityPath(organization.orgId, existing.facilityId), patched);
      }
      return patched;
    }
    return existing;
  }

  actions.push(`create facility ${input.facilityName}`);
  const now = timestamp();
  const facility = {
    facilityId: createId("fac"),
    orgId: organization.orgId,
    displayName: input.facilityName,
    facilityType: "clinic",
    facilityStandardKeys: Array.isArray(input.facilityStandardKeys) ? input.facilityStandardKeys : [],
    status: "active",
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
  if (input.apply) {
    await setDoc(input.projectId, facilityPath(organization.orgId, facility.facilityId), facility);
  }
  return facility;
}

async function ensureDepartment({ input, organization, facility, actions }) {
  const departments = await listDocs(input.projectId, organizationPath(organization.orgId), "departments");
  const existing = departments.find((department) => department.status === "active") || departments[0] || null;
  if (existing) {
    return existing;
  }

  actions.push(`create department ${input.departmentName}`);
  const now = timestamp();
  const department = {
    departmentId: createId("dep"),
    orgId: organization.orgId,
    facilityId: facility.facilityId,
    displayName: input.departmentName,
    code: "general",
    specialty: "general",
    status: "active",
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
  if (input.apply) {
    await setDoc(input.projectId, departmentPath(organization.orgId, department.departmentId), department);
  }
  return department;
}

async function ensureOrganizationDefaults({ input, organization, facility, department, actions }) {
  const updated = {
    ...organization,
    defaultFacilityId: facility.facilityId,
    defaultDepartmentId: department.departmentId,
    updatedAt: timestamp()
  };
  if (
    organization.defaultFacilityId === facility.facilityId
    && organization.defaultDepartmentId === department.departmentId
  ) {
    return organization;
  }

  actions.push("set organization defaults");
  if (input.apply) {
    await setDoc(input.projectId, organizationPath(organization.orgId), updated);
  }
  return input.apply ? updated : organization;
}

async function ensureEntitlements({ input, organization, actions }) {
  for (const productId of input.products) {
    const entitlementPath = productEntitlementPath(organization.orgId, productId);
    const existing = await getDoc(input.projectId, entitlementPath);
    const now = timestamp();
    const entitlement = {
      ...(existing || {}),
      productId,
      orgId: organization.orgId,
      status: "enabled",
      plan: existing?.plan || "internal-test",
      limits: existing?.limits || {},
      features: existing?.features || {},
      startsAt: existing?.startsAt || now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      schemaVersion: 1
    };

    actions.push(`enable entitlement ${productId}`);
    if (input.apply) {
      await setDoc(input.projectId, entitlementPath, entitlement);
    }
  }
}

async function ensureDemoPatient({ input, organization, actions }) {
  if (!input.seedDemoPatient) {
    return;
  }

  const patients = await listDocs(input.projectId, organizationPath(organization.orgId), "patients");
  if (patients.length > 0) {
    return;
  }

  actions.push("create demo patient");
  const now = timestamp();
  const patient = {
    patientId: createId("pat"),
    orgId: organization.orgId,
    displayName: "Demo Patient",
    birthDate: "1990-01-01",
    sex: "unknown",
    primaryPatientNumber: "demo-001",
    patientIdentifiers: [],
    externalPatientIds: [],
    contact: {},
    insurance: {},
    publicInsurance: {},
    consent: {},
    duplicateCandidateIds: [],
    status: "active",
    notes: "Internal migration test patient",
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
  if (input.apply) {
    await setDoc(input.projectId, patientPath(organization.orgId, patient.patientId), patient);
  }
}

async function getDoc(projectId, path) {
  const response = await firestoreRequest(projectId, "GET", documentUrl(projectId, path), null, { allow404: true });
  return response ? decodeDocument(response) : null;
}

async function setDoc(projectId, path, data) {
  await firestoreRequest(projectId, "PATCH", documentUrl(projectId, path), {
    fields: encodeFields(data)
  });
}

async function listDocs(projectId, parentPath, collectionName) {
  const docs = [];
  let pageToken = "";
  do {
    const separator = pageToken ? "&" : "";
    const url = `${collectionUrl(projectId, parentPath, collectionName)}?pageSize=300${separator}${pageToken ? `pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const response = await firestoreRequest(projectId, "GET", url, null, { allow404: true });
    for (const doc of response?.documents || []) {
      docs.push(decodeDocument(doc));
    }
    pageToken = response?.nextPageToken || "";
  } while (pageToken);
  return docs;
}

async function firestoreRequest(projectId, method, url, body, options = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 404 && options.allow404) {
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${projectId} ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function documentUrl(projectId, path) {
  return `${firestoreBase(projectId)}/${encodeFirestorePath(path)}`;
}

function collectionUrl(projectId, parentPath, collectionName) {
  return `${firestoreBase(projectId)}/${encodeFirestorePath(parentPath)}/${encodeURIComponent(collectionName)}`;
}

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

function encodeFirestorePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function encodeFields(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)])
  );
}

function encodeValue(value) {
  if (value === null) {
    return { nullValue: null };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return { integerValue: String(value) };
  }
  if (typeof value === "number") {
    return { doubleValue: value };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFields(value) } };
  }
  return { stringValue: String(value) };
}

function decodeDocument(document) {
  return decodeFields(document.fields || {});
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function decodeValue(value) {
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return undefined;
}

async function resolvePassword() {
  const passwordEnv = args.get("password-env") || "HALUNASU_SEED_PASSWORD";
  const envPassword = process.env[passwordEnv] || "";
  if (envPassword) {
    return envPassword;
  }
  if (args.get("password")) {
    return args.get("password");
  }

  const passwordFile = args.get("password-file") || args.get("generate-password-file") || "";
  if (!passwordFile) {
    return "";
  }

  const fullPath = isAbsolute(passwordFile) ? passwordFile : join(root, passwordFile);
  const existing = await readFile(fullPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (existing.trim()) {
    return existing.trim();
  }
  if (!args.get("generate-password-file")) {
    throw new Error(`Password file is empty: ${fullPath}`);
  }

  const generated = `Halunasu-${randomBytes(18).toString("base64url")}!9`;
  await writeFile(fullPath, `${generated}\n`, { mode: 0o600 });
  await chmod(fullPath, 0o600);
  return generated;
}

function getAccessToken() {
  return execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function printSummary(input, actions, result = {}) {
  console.log(`${input.env}: ${input.apply ? "applied" : "dry-run"} ${input.projectId}`);
  for (const action of actions) {
    console.log(`- ${action}`);
  }
  if (Object.keys(result).length > 0) {
    console.log(JSON.stringify(result));
  }
  console.log();
}

function createId(prefix) {
  return `${prefix}_${randomBytes(13).toString("hex")}`;
}

function timestamp() {
  return new Date().toISOString();
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function requiredArg(name) {
  const value = args.get(name);
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = values[index + 1]?.startsWith("--") ? "true" : values[index + 1] || "true";
    parsed.set(key, value);
    if (value !== "true") {
      index += 1;
    }
  }
  return parsed;
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameStringSet(left = [], right = []) {
  const normalize = (items) => [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function printUsage() {
  console.log("Usage: npm run seed:core-account -- --env stg|prod|all --organization-code CODE --login-ids ID1,ID2 [--facility-standard-keys KEY1,KEY2] [--member-role-profile admin|fee-demo] [--fee-project-id PROJECT --fee-settings-file FILE] [--apply]");
  console.log("Set HALUNASU_SEED_PASSWORD, --password-file, or --generate-password-file for --apply.");
}
