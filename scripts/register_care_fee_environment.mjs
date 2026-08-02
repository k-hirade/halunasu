#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultSitesPath = resolve(root, "config/netlify-sites.json");
const defaultProxyTargetsPath = resolve(root, "config/runtime-proxy-targets.json");
const VALID_ENVIRONMENTS = new Set(["stg", "prod"]);
const SITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function buildCareFeeEnvironmentRegistration(input = {}) {
  const env = String(input.env || "").trim().toLowerCase();
  if (!VALID_ENVIRONMENTS.has(env)) {
    throw new Error("--env must be stg or prod");
  }

  const siteId = String(input.siteId || "").trim().toLowerCase();
  if (!SITE_ID_PATTERN.test(siteId)) {
    throw new Error("--site-id must be a Netlify UUID");
  }

  const careFeeApiUrl = normalizeCloudRunUrl(input.careFeeApiUrl);
  const sites = structuredClone(input.sites || {});
  const proxyTargets = structuredClone(input.proxyTargets || {});
  const site = sites[env]?.["care-fee-web"];
  if (!site) {
    throw new Error(`Missing config.netlify-sites entry for ${env}/care-fee-web`);
  }
  if (!proxyTargets[env]) {
    throw new Error(`Missing runtime proxy target environment: ${env}`);
  }

  assertNoConflictingRegistration({
    current: site.siteId,
    next: siteId,
    label: `${env}/care-fee-web siteId`
  });
  assertNoConflictingRegistration({
    current: proxyTargets[env].careFee,
    next: careFeeApiUrl,
    label: `${env}/careFee proxy target`
  });

  sites[env]["care-fee-web"] = {
    ...site,
    siteId,
    provisioningStatus: "registered"
  };
  proxyTargets[env].careFee = careFeeApiUrl;

  return {
    env,
    siteId,
    careFeeApiUrl,
    sites,
    proxyTargets
  };
}

export function normalizeCloudRunUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("--care-fee-api-url must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("--care-fee-api-url must use https");
  }
  if (!/^[a-z0-9-]+(?:[a-z0-9.-]*)\.run\.app$/u.test(url.hostname)) {
    throw new Error("--care-fee-api-url must be a Cloud Run run.app service URL");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("--care-fee-api-url must not include a path, query, or fragment");
  }
  return url.origin;
}

function assertNoConflictingRegistration({ current, next, label }) {
  if (current && current !== next) {
    throw new Error(`${label} is already registered with a different value`);
  }
}

async function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.care-fee-registration-${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.has("help")) {
    printUsage();
    return;
  }

  const sitesPath = resolve(args.get("sites-config") || defaultSitesPath);
  const proxyTargetsPath = resolve(args.get("proxy-config") || defaultProxyTargetsPath);
  const [sites, proxyTargets] = await Promise.all([
    readJson(sitesPath),
    readJson(proxyTargetsPath)
  ]);
  const registration = buildCareFeeEnvironmentRegistration({
    env: args.get("env"),
    siteId: args.get("site-id"),
    careFeeApiUrl: args.get("care-fee-api-url"),
    sites,
    proxyTargets
  });
  const apply = args.get("apply") === "true";

  console.log("Care Fee environment registration");
  console.log(`Apply: ${apply}`);
  console.log(`Environment: ${registration.env}`);
  console.log(`Netlify site ID: ${registration.siteId}`);
  console.log(`Care Fee API: ${registration.careFeeApiUrl}`);
  console.log(`Sites config: ${sitesPath}`);
  console.log(`Proxy config: ${proxyTargetsPath}`);

  if (!apply) {
    console.log("DRY RUN: no files changed");
    return;
  }

  await writeJsonAtomically(sitesPath, registration.sites);
  await writeJsonAtomically(proxyTargetsPath, registration.proxyTargets);
  console.log("Registration applied");
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply" || token === "--help") {
      parsed.set(token.slice(2), "true");
      continue;
    }
    if (!token.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete option: ${token}`);
    }
    parsed.set(token.slice(2), argv[index + 1]);
    index += 1;
  }
  return parsed;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function printUsage() {
  console.log(`Usage:
  npm run register:care-fee-environment -- \\
    --env stg|prod \\
    --site-id <netlify-site-uuid> \\
    --care-fee-api-url https://<cloud-run-service>.run.app [--apply]

Dry-run is the default. --apply updates only config/netlify-sites.json and
config/runtime-proxy-targets.json after validating both values.`);
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
