#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sitesPath = join(root, "config", "netlify-sites.json");

const args = parseArgs(process.argv.slice(2));
const apply = args.get("apply") === "true";
const targetEnv = args.get("env") || "all";
const targetApp = args.get("app") || "all";

if (args.has("help")) {
  printUsage();
  process.exit(0);
}

const sites = JSON.parse(await readFile(sitesPath, "utf8"));
const envs = targetEnv === "all" ? Object.keys(sites) : [targetEnv];

for (const env of envs) {
  if (!sites[env]) {
    throw new Error(`Unknown Netlify environment: ${env}`);
  }
}

const jobs = [];
for (const env of envs) {
  const apps = targetApp === "all" ? Object.keys(sites[env]) : [targetApp];
  for (const app of apps) {
    if (!sites[env][app]) {
      throw new Error(`Unknown Netlify app for ${env}: ${app}`);
    }
    jobs.push({ env, app, site: sites[env][app] });
  }
}

console.log("P13 Netlify static deploy");
console.log(`Apply: ${apply}`);
console.log(`Environment: ${targetEnv}`);
console.log(`App: ${targetApp}`);
console.log();

for (const job of jobs) {
  const publishDir = join(root, job.site.publishDir);
  const indexPath = join(publishDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(
      `Missing ${relative(root, indexPath)}. Run npm run build:runtime-apps before deploying.`
    );
  }

  const command = [
    "netlify",
    "deploy",
    "--no-build",
    "--prod",
    "--site",
    job.site.siteId,
    "--dir",
    publishDir,
    "--message",
    `P13 ${job.env}/${job.app}`
  ];

  console.log(`== ${job.env}/${job.app} -> ${job.site.siteName} ==`);
  console.log(`Netlify URL: ${job.site.netlifyUrl}`);
  console.log(`Target domain: ${job.site.targetDomain}`);

  if (apply) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: tmpdir(),
      env: process.env,
      stdio: "inherit"
    });
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  } else {
    console.log(`DRY RUN: ${formatCommand(command)}`);
  }
  console.log();
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
    if (/^[A-Za-z0-9_./:=@-]+$/.test(part)) {
      return part;
    }
    return `'${part.replaceAll("'", "'\\''")}'`;
  }).join(" ");
}

function printUsage() {
  console.log("Usage: npm run deploy:netlify-static -- [--env stg|prod|all] [--app lp|core-admin|charting-web|fee-web|referral-web|all] [--apply]");
}
