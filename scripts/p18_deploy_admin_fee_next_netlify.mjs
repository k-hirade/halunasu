#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sitesPath = join(root, "config", "netlify-sites.json");
const proxyTargetsPath = join(root, "config", "runtime-proxy-targets.json");

const appConfigs = {
  "core-admin": {
    baseDir: "apps/core-admin",
    packageName: "@halunasu/core-admin",
    requiredTargets: ["platform"],
    envForTarget(env, targets) {
      return {
        HALUNASU_ENV: env,
        NEXT_PUBLIC_HALUNASU_ENV: env,
        PLATFORM_PROXY_TARGET: targets.platform,
        PLATFORM_BASE_URL: targets.platform,
        NEXT_PUBLIC_PLATFORM_BASE_URL: "/api/platform"
      };
    }
  },
  "fee-web": {
    baseDir: "apps/fee-web",
    packageName: "@halunasu/fee-web",
    requiredTargets: ["platform", "fee"],
    envForTarget(env, targets) {
      const values = {
        HALUNASU_ENV: env,
        NEXT_PUBLIC_HALUNASU_ENV: env,
        PLATFORM_PROXY_TARGET: targets.platform,
        FEE_PROXY_TARGET: targets.fee,
        PLATFORM_BASE_URL: targets.platform,
        NEXT_PUBLIC_PLATFORM_BASE_URL: "/api/platform",
        FEE_BASE_URL: targets.fee,
        NEXT_PUBLIC_FEE_BASE_URL: "/api/fee",
        CORE_ADMIN_BASE_URL: env === "stg" ? "https://admin.stg.halunasu.com" : "https://admin.halunasu.com",
        NEXT_PUBLIC_CORE_ADMIN_BASE_URL: env === "stg" ? "https://admin.stg.halunasu.com" : "https://admin.halunasu.com"
      };
      const receptCheckerUrl = process.env.NEXT_PUBLIC_RECEPT_CHECKER_URL || process.env.RECEPT_CHECKER_URL;
      const stgReceptCheckerUrl = process.env.NEXT_PUBLIC_RECEPT_CHECKER_STG_URL || process.env.RECEPT_CHECKER_STG_URL;
      if (receptCheckerUrl) {
        values.NEXT_PUBLIC_RECEPT_CHECKER_URL = receptCheckerUrl;
      }
      if (env === "stg" && stgReceptCheckerUrl) {
        values.NEXT_PUBLIC_RECEPT_CHECKER_STG_URL = stgReceptCheckerUrl;
      }
      return values;
    }
  }
};

const args = parseArgs(process.argv.slice(2));
const apply = args.get("apply") === "true";
const targetEnv = args.get("env") || "all";
const targetApp = args.get("app") || "all";

if (args.has("help")) {
  printUsage();
  process.exit(0);
}

const sites = JSON.parse(await readFile(sitesPath, "utf8"));
const proxyTargets = JSON.parse(await readFile(proxyTargetsPath, "utf8"));
const envs = targetEnv === "all" ? ["stg", "prod"] : [targetEnv];
const apps = targetApp === "all" ? Object.keys(appConfigs) : [targetApp];

for (const env of envs) {
  if (!sites[env]) {
    throw new Error(`Unknown Netlify environment: ${env}`);
  }
  if (!proxyTargets[env]) {
    throw new Error(`Unknown proxy environment: ${env}`);
  }
}
for (const app of apps) {
  if (!appConfigs[app]) {
    throw new Error(`Unknown Next app: ${app}`);
  }
}

console.log("P18 Netlify Core Admin / Fee Next.js deploy");
console.log(`Apply: ${apply}`);
console.log(`Environment: ${targetEnv}`);
console.log(`App: ${targetApp}`);
console.log();

for (const env of envs) {
  for (const app of apps) {
    const config = appConfigs[app];
    const site = sites[env]?.[app];
    if (!site) {
      throw new Error(`Missing ${app} Netlify site config for ${env}`);
    }

    const targets = normalizeTargets(env, config.requiredTargets);
    const appEnv = {
      ...config.envForTarget(env, targets),
      ...stgGateEnvForDeploy(env)
    };
    const baseDir = join(root, config.baseDir);
    const deployCommand = buildDeployCommand({ baseDir, packageName: config.packageName, siteId: site.siteId, message: `P18 ${env}/${app} Next.js` });

    console.log(`== ${env}/${app} -> ${site.siteName} ==`);
    console.log(`Target domain: ${site.targetDomain}`);
    console.log(`Base dir: ${config.baseDir}`);
    for (const key of config.requiredTargets) {
      console.log(`${key} proxy: ${targets[key]}`);
    }

    if (!apply) {
      console.log("DRY RUN: netlify env:set ... --force");
      console.log("DRY RUN: netlify build");
      console.log(`DRY RUN: ${formatCommand(deployCommand)}`);
      console.log();
      continue;
    }

    for (const [key, value] of Object.entries(appEnv)) {
      setNetlifyEnv({ key, packageName: config.packageName, siteId: site.siteId, value });
    }

    const buildEnv = {
      ...process.env,
      ...appEnv,
      NETLIFY_SITE_ID: site.siteId
    };

    await cleanNetlifyNextBuildOutput({ appDirName: config.baseDir, baseDir });
    runCommand(["netlify", "build"], {
      cwd: baseDir,
      env: buildEnv
    });

    await prepareNetlifyFrameworkOutput({ appDirName: config.baseDir, baseDir });
    runCommand(deployCommand, {
      cwd: root,
      env: buildEnv
    });
    console.log();
  }
}

function normalizeTargets(env, requiredTargets) {
  const targets = {};
  for (const key of requiredTargets) {
    const value = proxyTargets[env]?.[key];
    if (!value || !/^https:\/\/[a-z0-9-]+[a-z0-9.-]*\.run\.app$/u.test(value)) {
      throw new Error(`Missing or invalid ${key} proxy target for ${env}: ${value || "(empty)"}`);
    }
    targets[key] = value.replace(/\/$/u, "");
  }
  return targets;
}

function buildDeployCommand({ baseDir, packageName, siteId, message }) {
  return [
    "netlify",
    "deploy",
    "--prod",
    "--site",
    siteId,
    "--filter",
    packageName,
    "--no-build",
    "--dir",
    join(baseDir, "apps", baseDir.split("/").at(-1), ".netlify", "static"),
    "--message",
    message,
    "--skip-functions-cache"
  ];
}

async function cleanNetlifyNextBuildOutput({ appDirName, baseDir }) {
  const deployRoot = join(baseDir, ".netlify");
  const generatedRoot = join(baseDir, appDirName, ".netlify");
  for (const path of [
    join(baseDir, ".next"),
    generatedRoot,
    join(deployRoot, "deploy"),
    join(deployRoot, "edge-functions"),
    join(deployRoot, "edge-functions-dist"),
    join(deployRoot, "edge-functions-import-map.json"),
    join(deployRoot, "functions"),
    join(deployRoot, "functions-internal"),
    join(deployRoot, "static")
  ]) {
    await rm(path, { recursive: true, force: true });
  }
}

async function prepareNetlifyFrameworkOutput({ appDirName, baseDir }) {
  const generatedRoot = join(baseDir, appDirName, ".netlify");
  const deployRoot = join(baseDir, ".netlify");
  const staticDir = join(generatedRoot, "static");
  if (!existsSync(staticDir)) {
    throw new Error(`Missing Netlify generated static dir: ${staticDir}`);
  }

  for (const name of ["functions", "functions-internal", "deploy", "edge-functions", "edge-functions-dist"]) {
    const source = join(generatedRoot, name);
    if (!existsSync(source)) {
      continue;
    }
    const destination = join(deployRoot, name);
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  for (const name of ["edge-functions-import-map.json"]) {
    const source = join(generatedRoot, name);
    if (!existsSync(source)) {
      continue;
    }
    await cp(source, join(deployRoot, name));
  }

  const handlerDir = join(deployRoot, "functions-internal", "___netlify-server-handler");
  const handlerPath = join(handlerDir, "___netlify-server-handler.mjs");
  const handlerJsonPath = join(handlerDir, "___netlify-server-handler.json");
  const manifestPath = join(deployRoot, "functions", "manifest.json");

  let handler = await readFile(handlerPath, "utf8");
  const taskPath = appDirName;
  handler = handler
    .replaceAll(`from '/var/task/${taskPath}/.netlify/dist/run/handlers/request-context.cjs'`, `from './${taskPath}/.netlify/dist/run/handlers/request-context.cjs'`)
    .replaceAll(`from '/var/task/${taskPath}/.netlify/dist/run/handlers/tracer.cjs'`, `from './${taskPath}/.netlify/dist/run/handlers/tracer.cjs'`)
    .replaceAll(`process.chdir('/var/task/${taskPath}')`, `process.chdir(new URL('./${taskPath}', import.meta.url).pathname)`)
    .replaceAll(`import('/var/task/${taskPath}/.netlify/dist/run/handlers/server.js')`, `import('./${taskPath}/.netlify/dist/run/handlers/server.js')`);
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
}

function setNetlifyEnv({ key, packageName, siteId, value }) {
  runCommand([
    "netlify",
    "env:set",
    key,
    value,
    "--filter",
    packageName,
    "--context",
    "production",
    "--force"
  ], {
    cwd: root,
    env: {
      ...process.env,
      NETLIFY_SITE_ID: siteId
    }
  });
}

function stgGateEnvForDeploy(env) {
  const values = {
    STG_GATE_ENABLED: env === "stg" ? "true" : "false"
  };
  if (env === "stg" && process.env.STG_GATE_ALLOWED_IPS) {
    values.STG_GATE_ALLOWED_IPS = process.env.STG_GATE_ALLOWED_IPS;
  }
  return values;
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
  console.log("Usage: npm run deploy:netlify-admin-fee-next -- [--env stg|prod|all] [--app core-admin|fee-web|all] [--apply]");
}
