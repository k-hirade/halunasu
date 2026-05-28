import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = new URL("../../..", import.meta.url).pathname;
const productApis = ["charting-api", "fee-api", "referral-api"];
const allApis = ["platform-api", ...productApis, "charting-finalize"];
const phiFieldTokens = [
  "displayName",
  "displayNameKana",
  "birthDate",
  "clinicalSummary",
  "transcript",
  "notes",
  "purpose",
  "recipientInstitution",
  "recipientDoctor",
  "patientSnapshot",
  "facilitySnapshot",
  "departmentSnapshot",
  "authorMemberSnapshot"
];

test("API responses include no-store and nosniff security headers", () => {
  for (const service of allApis) {
    const source = readText(join(root, "services", service, "src", "server.js"));

    assert.match(source, /"cache-control": "no-store"/, `${service} must disable response caching`);
    assert.match(source, /"x-content-type-options": "nosniff"/, `${service} must set nosniff`);
  }
});

test("CORS allowlists do not use wildcard origins", () => {
  for (const service of allApis) {
    const source = readText(join(root, "services", service, "src", "server.js"));

    assert.equal(source.includes('"access-control-allow-origin": "*"'), false, `${service} must not allow wildcard CORS`);
    assert.equal(source.includes("'access-control-allow-origin': '*'"), false, `${service} must not allow wildcard CORS`);
    if (source.includes("access-control-allow-origin")) {
      assert.match(source, /"vary": "Origin"/, `${service} CORS responses must vary by Origin`);
    }
  }
});

test("product APIs enforce Platform product context and CSRF on mutating browser routes", () => {
  for (const service of productApis) {
    const source = readText(join(root, "services", service, "src", "server.js"));

    assert.match(source, /requireProductContext/, `${service} must enforce Platform product context`);
    assert.match(source, /requirePlatformCsrf/, `${service} must enforce CSRF for mutations`);
    assert.equal(source.includes("OPERATOR_ACCOUNTS_JSON"), false, `${service} must not use old operator auth`);
  }
});

test("Platform auth has rate limits and secure cookie support", () => {
  const platformServer = readText(join(root, "services", "platform-api", "src", "server.js"));
  const session = readText(join(root, "services", "platform-api", "src", "auth", "session.js"));

  assert.match(platformServer, /consumeLoginRateLimit/, "platform-api must rate-limit login");
  assert.match(platformServer, /consumeSignupRateLimit/, "platform-api must rate-limit signup");
  assert.match(platformServer, /requirePlatformAdmin/, "platform-api must protect global Core admin routes");
  assert.match(platformServer, /requireOrgAdmin/, "platform-api must protect organization-scoped Core admin routes");
  assert.match(platformServer, /requireBillingAdmin/, "platform-api must protect billing/product entitlement routes");
  assert.match(platformServer, /secureCookiesDefault/, "platform-api must default secure cookies outside local/test");
  assert.match(session, /APP_SESSION_SIGNING_SECRET is required/, "production-like sessions must require configured signing secret");
  assert.match(session, /SameSite=Lax/, "session cookies must use SameSite=Lax");
  assert.match(session, /HttpOnly/, "session cookie builder must support HttpOnly");
  assert.match(session, /Secure/, "session cookie builder must support Secure");
});

test("Core data request and audit payload hardening remain in Platform contracts", () => {
  const contracts = readText(join(root, "packages", "platform-contracts", "src", "index.js"));
  const platformServer = readText(join(root, "services", "platform-api", "src", "server.js"));

  assert.match(contracts, /sanitizeSafePayload/, "audit/data request payloads must be allowlisted");
  assert.match(contracts, /validateCreateDataRequestInput/, "data request creation contract must exist");
  assert.match(platformServer, /data-requests/, "platform-api must expose data request workflow routes");
  assert.match(platformServer, /data_request\.created/, "data request creation must be audited");
  assert.match(platformServer, /data_request\.updated/, "data request updates must be audited");
});

test("browser apps do not import Firestore or Firebase client SDKs", () => {
  const source = readDirectoryText(join(root, "apps"), /\.(html|js|mjs|ts|tsx)$/);
  const forbidden = [
    "firebase/app",
    "firebase/firestore",
    "getFirestore(",
    "initializeApp("
  ];

  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `browser apps must not contain ${token}`);
  }
});

test("Firestore Admin SDK usage stays inside server store adapters", () => {
  const files = walkFiles(root).filter((file) => /\.(js|mjs|json)$/.test(file));
  const matches = files.filter((file) => {
    const source = readText(file);
    return source.includes('firebase-admin/firestore') || source.includes("getFirestore");
  });

  for (const file of matches) {
    const relativePath = relative(root, file);
    assert.match(
      relativePath,
      /^services\/[a-z-]+\/src\/store\/firestore-store\.js$/,
      `${relativePath} must not access Firestore directly`
    );
  }
});

test("service runtime logs do not print request or clinical payloads", () => {
  const serviceFiles = walkFiles(join(root, "services"))
    .filter((file) => file.endsWith(".js"));
  const consoleLines = [];

  for (const file of serviceFiles) {
    const lines = readText(file).split("\n");
    lines.forEach((line, index) => {
      if (line.includes("console.")) {
        consoleLines.push({
          file: relative(root, file),
          line: index + 1,
          text: line.trim()
        });
      }
    });
  }

  const unsafe = consoleLines.filter((line) => !/listening on/.test(line.text));
  assert.deepEqual(unsafe, []);
});

test("audit safePayload blocks avoid obvious PHI fields", () => {
  const serviceFiles = walkFiles(join(root, "services"))
    .filter((file) => /src\/.*\.js$/.test(file));

  for (const file of serviceFiles) {
    const source = readText(file);
    const blocks = source.match(/safePayload:\s*\{[^}]*\}/gs) || [];
    for (const block of blocks) {
      for (const token of phiFieldTokens) {
        assert.equal(
          block.includes(token),
          false,
          `${relative(root, file)} safePayload must not include PHI field ${token}`
        );
      }
    }
  }
});

test("P9 old-environment scripts do not create GCP resources by default", () => {
  const inventory = readText(join(root, "scripts", "p9_old_environment_inventory.sh"));
  const shutdown = readText(join(root, "scripts", "p9_old_environment_shutdown.sh"));
  const combined = `${inventory}\n${shutdown}`;
  const forbidden = [
    /gcloud\s+services\s+enable/,
    /gcloud\s+run\s+deploy/,
    /gcloud\s+builds\s+submit/,
    /gcloud\s+firestore\s+export/,
    /gcloud\s+storage\s+buckets\s+create/,
    /gcloud\s+secrets\s+create/,
    /gcloud\s+tasks\s+queues\s+create/,
    /gcloud\s+scheduler\s+jobs\s+create/,
    /terraform\s+apply/
  ];

  assert.match(inventory, /read-only inventory/, "P9 inventory must be read-only");
  assert.match(shutdown, /APPLY="false"/, "P9 shutdown must dry-run by default");
  assert.match(shutdown, /P9_ALLOW_MUTATION/, "P9 shutdown apply must require explicit mutation acknowledgement");
  for (const pattern of forbidden) {
    assert.equal(pattern.test(combined), false, `P9 scripts must not contain ${pattern}`);
  }
});

function readDirectoryText(path, pattern) {
  return walkFiles(path)
    .filter((file) => pattern.test(file))
    .map(readText)
    .join("\n");
}

function walkFiles(path) {
  const entries = readdirSync(path);
  return entries.flatMap((entry) => {
    if ([".git", "node_modules", ".venv", "__pycache__"].includes(entry)) {
      return [];
    }
    const entryPath = join(path, entry);
    const relativePath = relative(root, entryPath);
    if (relativePath.startsWith("packages/security-boundaries")) {
      return [];
    }
    return statSync(entryPath).isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

function readText(path) {
  return readFileSync(path, "utf8");
}
