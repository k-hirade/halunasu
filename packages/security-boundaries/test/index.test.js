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

test("P10 project readiness preflight remains read-only", () => {
  const source = readText(join(root, "scripts", "p10_project_split_preflight.sh"));
  const forbidden = [
    /gcloud\s+projects\s+create/,
    /gcloud\s+projects\s+delete/,
    /gcloud\s+services\s+enable/,
    /gcloud\s+billing\s+projects\s+link/,
    /gcloud\s+run\s+deploy/,
    /gcloud\s+builds\s+submit/,
    /gcloud\s+firestore\s+databases\s+create/,
    /gcloud\s+firestore\s+export/,
    /gcloud\s+storage\s+buckets\s+create/,
    /gcloud\s+secrets\s+create/,
    /terraform\s+apply/
  ];

  assert.match(source, /read-only preflight/, "P10 project preflight must be read-only");
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `P10 preflight must not contain ${pattern}`);
  }
});

test("P10 product activation script remains guarded", () => {
  const source = readText(join(root, "scripts", "p10_activate_product_project_guarded.sh"));
  const forbidden = [
    /gcloud\s+run\s+deploy/,
    /gcloud\s+builds\s+submit/,
    /gcloud\s+firestore\s+databases\s+create/,
    /gcloud\s+firestore\s+export/,
    /gcloud\s+artifacts\s+repositories\s+create/,
    /gcloud\s+iam\s+service-accounts\s+create/,
    /gcloud\s+storage\s+buckets\s+create/,
    /gcloud\s+secrets\s+create/,
    /terraform\s+apply/
  ];

  assert.match(source, /APPLY="false"/, "P10 activation must dry-run by default");
  assert.match(source, /P10_ALLOW_BILLING/, "P10 activation must require billing acknowledgement");
  assert.match(source, /BILLING_ACCOUNT_ID/, "P10 activation must require explicit billing account");
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `P10 activation must not contain ${pattern}`);
  }
});

test("P10 runtime provisioning and deploy scripts keep low-cost guardrails", () => {
  const provision = readText(join(root, "scripts", "p10_provision_runtime_projects_low_cost.sh"));
  const deploy = readText(join(root, "scripts", "p10_deploy_runtime_services_low_cost.sh"));

  assert.match(provision, /APPLY="false"/, "P10 provision must dry-run by default");
  assert.match(provision, /P10_ALLOW_BILLING/, "P10 provision must require billing acknowledgement");
  assert.match(provision, /no Cloud Run minimum instances/, "P10 provision must document no minimum instances");
  assert.equal(/gcloud\s+run\s+deploy/.test(provision), false, "P10 provision must not deploy Cloud Run");
  assert.equal(/terraform\s+apply/.test(provision), false, "P10 provision must not run Terraform");

  assert.match(deploy, /MIN_INSTANCES="\$\{MIN_INSTANCES:-0\}"/, "P10 deploy must default min instances to zero");
  assert.match(deploy, /MAX_INSTANCES="\$\{MAX_INSTANCES:-1\}"/, "P10 deploy must default max instances to one");
  assert.match(deploy, /--cpu-throttling/, "P10 deploy must keep CPU throttling enabled");
  assert.match(deploy, /--no-allow-unauthenticated/, "P10 deploy must support private worker services");
  assert.equal(/terraform\s+apply/.test(deploy), false, "P10 deploy must not run Terraform");
});

test("P11 runtime endpoint config points static apps at same-origin API proxies", () => {
  const config = JSON.parse(readText(join(root, "config", "runtime-endpoints.json")));
  const proxyTargets = JSON.parse(readText(join(root, "config", "runtime-proxy-targets.json")));
  const script = readText(join(root, "scripts", "p11_build_static_apps_runtime_config.mjs"));

  for (const env of ["stg", "prod"]) {
    for (const key of ["platformApi", "chartingApi", "feeApi", "referralApi"]) {
      assert.match(config[env][key], /^\/api\/[a-z]+$/);
      assert.equal(config[env][key].includes("run.app"), false);
      assert.equal(config[env][key].includes("localhost"), false);
    }
    for (const key of ["platform", "charting", "fee", "referral"]) {
      assert.match(proxyTargets[env][key], /^https:\/\/[a-z0-9-]+[a-z0-9.-]*\.run\.app$/);
    }
  }

  assert.match(script, /dist", "runtime-apps"/, "P11 build output must stay under ignored dist");
  assert.match(script, /replaceMetaContent/, "P11 build must inject runtime meta values");
  assert.match(script, /runtime-proxy-targets\.json/, "P11 build must load Netlify proxy targets");
  assert.match(script, /\/api\/platform\/\*/, "P11 build must emit same-origin API proxy redirects");
});

test("P12 domain plan separates staging and production browser cookies", () => {
  const domains = JSON.parse(readText(join(root, "config", "runtime-domains.json")));

  assert.equal(domains.stg.cookies.domain, null);
  assert.equal(domains.stg.cookies.sessionCookieName, "halunasu_stg_session");
  assert.equal(domains.stg.cookies.csrfCookieName, "halunasu_stg_csrf");
  assert.equal(domains.prod.cookies.domain, null);
  assert.equal(domains.prod.cookies.sessionCookieName, "halunasu_session");
  assert.equal(domains.prod.cookies.csrfCookieName, "halunasu_csrf");

  for (const env of ["stg", "prod"]) {
    for (const url of Object.values(domains[env].api)) {
      assert.equal(url, null, "direct API custom domains should stay disabled while Netlify /api proxying is active");
    }
  }
});

test("P13 Netlify static sites are explicit and deploys are guarded", () => {
  const sites = JSON.parse(readText(join(root, "config", "netlify-sites.json")));
  const deployScript = readText(join(root, "scripts", "p13_deploy_netlify_static_apps.mjs"));
  const buildScript = readText(join(root, "scripts", "p11_build_static_apps_runtime_config.mjs"));
  const apps = ["lp", "core-admin", "charting-web", "fee-web", "referral-web"];

  for (const env of ["stg", "prod"]) {
    for (const app of apps) {
      const site = sites[env][app];
      assert.match(site.siteName, /^halunasu-[a-z-]+-(stg|prod)$/);
      assert.match(site.siteId, /^[0-9a-f-]{36}$/);
      assert.equal(site.netlifyUrl, `https://${site.siteName}.netlify.app`);
      assert.equal(site.publishDir, `dist/runtime-apps/${env}/${app}`);
      assert.match(site.targetDomain, /^https:\/\/([a-z0-9-]+(\.stg)?\.)?halunasu\.com$/);
    }
  }

  assert.equal(sites.prod.lp.targetDomain, "https://halunasu.com");
  assert.deepEqual(sites.prod.lp.aliasDomains, ["https://www.halunasu.com"]);

  assert.match(deployScript, /apply = args\.get\("apply"\) === "true"/, "P13 deploy must dry-run by default");
  assert.match(deployScript, /"netlify",\s+"deploy"/, "P13 deploy must use Netlify deploy");
  assert.match(deployScript, /"--no-build"/, "P13 deploy must use prebuilt output");
  assert.match(deployScript, /"--prod"/, "P13 deploy should publish each env-specific site production deploy");
  assert.match(buildScript, /"_headers"/, "runtime app build must emit Netlify headers");
  assert.match(buildScript, /"_redirects"/, "runtime app build must emit Netlify redirects");
});

test("P14 Cloudflare DNS records cover Halunasu web domains and omit unused API DNS", () => {
  const records = JSON.parse(readText(join(root, "config", "cloudflare-dns-records.json")));
  const webNames = new Set(records.web.map((record) => record.name));

  for (const name of ["stg", "admin.stg", "charting.stg", "fee.stg", "referral.stg", "admin", "charting", "fee", "referral", "www"]) {
    assert.equal(webNames.has(name), true, `missing web DNS record ${name}`);
  }

  assert.deepEqual(records.api, [], "API DNS records should stay empty while active apps use Netlify /api proxy routes");

  for (const record of records.web) {
    assert.equal(record.type, "CNAME");
    assert.equal(record.proxied, false, `${record.name} must be DNS-only unless proxying is intentionally enabled`);
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
