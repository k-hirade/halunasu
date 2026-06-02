#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sitesPath = join(root, "config", "netlify-sites.json");
const proxyTargetsPath = join(root, "config", "runtime-proxy-targets.json");
const chartingBaseDir = join(root, "apps", "charting-web");
const region = process.env.REGION || "asia-northeast1";
const chartingProjectByEnv = Object.freeze({
  stg: "halunasu-charting-stg",
  prod: "halunasu-charting-prod"
});

const args = parseArgs(process.argv.slice(2));
const apply = args.get("apply") === "true";
const targetEnv = args.get("env") || "all";

if (args.has("help")) {
  printUsage();
  process.exit(0);
}

const sites = JSON.parse(await readFile(sitesPath, "utf8"));
const proxyTargets = JSON.parse(await readFile(proxyTargetsPath, "utf8"));
const envs = targetEnv === "all" ? ["stg", "prod"] : [targetEnv];

console.log("P16 Netlify Charting Next.js deploy");
console.log(`Apply: ${apply}`);
console.log(`Environment: ${targetEnv}`);
console.log();

for (const env of envs) {
  const site = sites[env]?.["charting-web"];
  if (!site) {
    throw new Error(`Missing charting-web Netlify site config for ${env}`);
  }

  const gatewayUrl = resolveGatewayUrl(env, proxyTargets[env] || {});
  const billingUrl = proxyTargets[env]?.platform || "";
  const gatewayWsUrl = gatewayUrl.replace(/^http/u, "ws").replace(/\/$/u, "") + "/ws";
  const lpBaseUrl = env === "stg" ? "https://stg.halunasu.com" : "https://halunasu.com";
  const deployCommand = buildDeployCommand(site.siteId, `P16 ${env}/charting-web Next.js`);

  console.log(`== ${env}/charting-web -> ${site.siteName} ==`);
  console.log(`Target domain: ${site.targetDomain}`);
  console.log(`Gateway API base: ${gatewayUrl}`);
  console.log("Gateway auth base: same-origin /api/v1 proxy");
  console.log(`Gateway proxy fallback: ${gatewayUrl}`);
  console.log(`Gateway WS: ${gatewayWsUrl}`);
  console.log(`Billing proxy: ${billingUrl || "(not configured)"}`);
  console.log(`LP signup base: ${lpBaseUrl}`);

  if (!apply) {
    console.log(`DRY RUN: netlify build`);
    console.log(`DRY RUN: ${formatCommand(deployCommand)}`);
    console.log();
    continue;
  }

  setNetlifyEnv(site.siteId, "GATEWAY_PROXY_TARGET", gatewayUrl);
  setNetlifyEnv(site.siteId, "GATEWAY_BASE_URL", gatewayUrl);
  setNetlifyEnv(site.siteId, "NEXT_PUBLIC_GATEWAY_BASE_URL", gatewayUrl);
  setNetlifyEnv(site.siteId, "GATEWAY_AUTH_BASE_URL", "");
  setNetlifyEnv(site.siteId, "NEXT_PUBLIC_GATEWAY_AUTH_BASE_URL", "");
  setNetlifyEnv(site.siteId, "GATEWAY_WS_URL", gatewayWsUrl);
  setNetlifyEnv(site.siteId, "NEXT_PUBLIC_GATEWAY_WS_URL", gatewayWsUrl);
  setNetlifyEnv(site.siteId, "BILLING_BASE_URL", "/billing");
  setNetlifyEnv(site.siteId, "NEXT_PUBLIC_BILLING_BASE_URL", "/billing");
  setNetlifyEnv(site.siteId, "BILLING_PROXY_TARGET", billingUrl);
  setNetlifyEnv(site.siteId, "HALUNASU_ENV", env);
  setNetlifyEnv(site.siteId, "LP_BASE_URL", lpBaseUrl);
  setNetlifyEnv(site.siteId, "NEXT_PUBLIC_LP_BASE_URL", lpBaseUrl);

  const buildEnv = {
    ...process.env,
    NETLIFY_SITE_ID: site.siteId,
    HALUNASU_ENV: env,
    GATEWAY_BASE_URL: gatewayUrl,
    NEXT_PUBLIC_GATEWAY_BASE_URL: gatewayUrl,
    GATEWAY_AUTH_BASE_URL: "",
    NEXT_PUBLIC_GATEWAY_AUTH_BASE_URL: "",
    GATEWAY_PROXY_TARGET: gatewayUrl,
    GATEWAY_WS_URL: gatewayWsUrl,
    NEXT_PUBLIC_GATEWAY_WS_URL: gatewayWsUrl,
    BILLING_BASE_URL: "/billing",
    NEXT_PUBLIC_BILLING_BASE_URL: "/billing",
    BILLING_PROXY_TARGET: billingUrl,
    LP_BASE_URL: lpBaseUrl,
    NEXT_PUBLIC_LP_BASE_URL: lpBaseUrl
  };

  runCommand(["netlify", "build"], {
    cwd: chartingBaseDir,
    env: buildEnv
  });

  const staticDir = await prepareNetlifyFrameworkOutput();
  runCommand(deployCommand, {
    cwd: root,
    env: {
      ...buildEnv,
      CHARTING_NETLIFY_STATIC_DIR: staticDir
    }
  });
  console.log();
}

function buildDeployCommand(siteId, message) {
  return [
    "netlify",
    "deploy",
    "--prod",
    "--site",
    siteId,
    "--filter",
    "@halunasu/charting-web",
    "--no-build",
    "--dir",
    join(chartingBaseDir, "apps", "charting-web", ".netlify", "static"),
    "--message",
    message,
    "--skip-functions-cache"
  ];
}

async function prepareNetlifyFrameworkOutput() {
  const generatedRoot = join(chartingBaseDir, "apps", "charting-web", ".netlify");
  const deployRoot = join(chartingBaseDir, ".netlify");
  const staticDir = join(generatedRoot, "static");
  if (!existsSync(staticDir)) {
    throw new Error(`Missing Netlify generated static dir: ${staticDir}`);
  }

  for (const name of ["functions", "functions-internal", "deploy"]) {
    const source = join(generatedRoot, name);
    if (!existsSync(source)) {
      continue;
    }
    const destination = join(deployRoot, name);
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }

  const handlerDir = join(deployRoot, "functions-internal", "___netlify-server-handler");
  const handlerPath = join(handlerDir, "___netlify-server-handler.mjs");
  const handlerJsonPath = join(handlerDir, "___netlify-server-handler.json");
  const manifestPath = join(deployRoot, "functions", "manifest.json");

  let handler = await readFile(handlerPath, "utf8");
  handler = handler
    .replaceAll("from '/var/task/apps/charting-web/.netlify/dist/run/handlers/request-context.cjs'", "from './apps/charting-web/.netlify/dist/run/handlers/request-context.cjs'")
    .replaceAll("from '/var/task/apps/charting-web/.netlify/dist/run/handlers/tracer.cjs'", "from './apps/charting-web/.netlify/dist/run/handlers/tracer.cjs'")
    .replaceAll("process.chdir('/var/task/apps/charting-web')", "process.chdir(new URL('./apps/charting-web', import.meta.url).pathname)")
    .replaceAll("import('/var/task/apps/charting-web/.netlify/dist/run/handlers/server.js')", "import('./apps/charting-web/.netlify/dist/run/handlers/server.js')");
  await writeFile(handlerPath, handler);

  const handlerJson = JSON.parse(await readFile(handlerJsonPath, "utf8"));
  handlerJson.config.includedFilesBasePath = handlerDir;
  await writeFile(handlerJsonPath, JSON.stringify(handlerJson));

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const fn of manifest.functions || []) {
    if (fn.name === "___netlify-server-handler") {
      fn.mainFile = handlerPath;
      fn.path = join(deployRoot, "functions", "___netlify-server-handler.zip");
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest));

  return staticDir;
}

function setNetlifyEnv(siteId, key, value) {
  runCommand([
    "netlify",
    "env:set",
    key,
    value,
    "--filter",
    "@halunasu/charting-web",
    "--context",
    "production"
  ], {
    cwd: root,
    env: {
      ...process.env,
      NETLIFY_SITE_ID: siteId
    }
  });
}

function runCommand(command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function resolveGatewayUrl(env, targets) {
  const configuredGatewayUrl = targets.chartingGateway || targets.charting;
  if (configuredGatewayUrl) {
    return configuredGatewayUrl.replace(/\/$/u, "");
  }

  if (!apply) {
    return `https://charting-gateway-${env}.run.app`;
  }

  const project = chartingProjectByEnv[env];
  if (!project) {
    throw new Error(`Unknown env: ${env}`);
  }
  const result = spawnSync("gcloud", [
    "run",
    "services",
    "describe",
    `charting-gateway-${env}`,
    "--project",
    project,
    "--region",
    region,
    "--format=value(status.url)"
  ], {
    env: process.env,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`Unable to resolve charting-gateway-${env} Cloud Run URL: ${result.stderr || result.stdout}`);
  }

  const url = result.stdout.trim();
  if (!/^https:\/\/.+\.run\.app$/u.test(url)) {
    throw new Error(`Invalid charting gateway URL for ${env}: ${url}`);
  }
  return url;
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

function formatCommand(parts) {
  return parts.map((part) => {
    if (/^[A-Za-z0-9_./:=@-]+$/u.test(part)) {
      return part;
    }
    return `'${part.replaceAll("'", "'\\''")}'`;
  }).join(" ");
}

function printUsage() {
  console.log("Usage: npm run deploy:netlify-charting-next -- [--env stg|prod|all] [--apply]");
}
