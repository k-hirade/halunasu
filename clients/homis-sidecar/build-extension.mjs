#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(clientRoot, "../..");
const sourceDirectory = path.join(clientRoot, "extension");
const defaultOutputRoot = path.join(repositoryRoot, "dist", "homis-sidecar");
const approvalBaseUrls = Object.freeze({
  stg: "https://fee.stg.halunasu.com/settings/sidecar-approvals",
  prod: "https://fee.halunasu.com/settings/sidecar-approvals"
});

export async function buildExtension({
  environment,
  outputDirectory,
  proxyTargetsPath = path.join(repositoryRoot, "config", "runtime-proxy-targets.json")
}) {
  const normalizedEnvironment = normalizeEnvironment(environment);
  const targetDirectory = path.resolve(
    outputDirectory || path.join(defaultOutputRoot, normalizedEnvironment, "extension")
  );
  const proxyTargets = JSON.parse(await readFile(proxyTargetsPath, "utf8"));
  const targets = resolveTargets(proxyTargets, normalizedEnvironment);

  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(path.dirname(targetDirectory), { recursive: true });
  await cp(sourceDirectory, targetDirectory, {
    recursive: true,
    filter(source) {
      return path.basename(source) !== ".DS_Store";
    }
  });

  const manifestPath = path.join(targetDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = normalizedEnvironment === "prod"
    ? "ハルナス HOMIS算定サイドカー"
    : "ハルナス HOMIS算定サイドカー (STG)";
  manifest.version_name = `${manifest.version}-${normalizedEnvironment}`;
  manifest.host_permissions = [
    "http://localhost:8899/*",
    "http://127.0.0.1:8899/*",
    "http://0.0.0.0:8899/*",
    `${targets.platform}/*`,
    `${targets.fee}/*`
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const environmentPath = path.join(targetDirectory, "lib", "environment.js");
  await writeFile(environmentPath, renderEnvironment({
    environment: normalizedEnvironment,
    platformBaseUrl: targets.platform,
    feeBaseUrl: targets.fee,
    approvalBaseUrl: approvalBaseUrls[normalizedEnvironment]
  }));

  return {
    environment: normalizedEnvironment,
    extensionId: extensionIdForKey(manifest.key),
    outputDirectory: targetDirectory,
    platformBaseUrl: targets.platform,
    feeBaseUrl: targets.fee,
    approvalBaseUrl: approvalBaseUrls[normalizedEnvironment]
  };
}

export async function createZip({ extensionDirectory, zipPath }) {
  const resolvedExtensionDirectory = path.resolve(extensionDirectory);
  const resolvedZipPath = path.resolve(zipPath);
  await mkdir(path.dirname(resolvedZipPath), { recursive: true });
  await rm(resolvedZipPath, { force: true });
  const result = spawnSync("zip", ["-q", "-r", resolvedZipPath, "."], {
    cwd: resolvedExtensionDirectory,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error("zip command failed while packaging the HOMIS sidecar");
  }
  return resolvedZipPath;
}

function resolveTargets(config, environment) {
  const selected = config?.[environment] || {};
  return {
    platform: httpsOrigin(selected.platform, `${environment} platform target`),
    fee: httpsOrigin(selected.fee, `${environment} fee target`)
  };
}

function httpsOrigin(value, label) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  return url.origin;
}

function normalizeEnvironment(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!["stg", "prod"].includes(normalized)) {
    throw new Error("--env must be stg or prod");
  }
  return normalized;
}

function renderEnvironment(config) {
  return `(function registerSidecarEnvironment(global) {
  "use strict";

  global.HalunasuSidecarConfig = Object.freeze(${JSON.stringify(config, null, 4)});
})(globalThis);
`;
}

function extensionIdForKey(publicKey) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(String(publicKey || ""), "base64"))
    .digest()
    .subarray(0, 16);
  return [...digest]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed.set(key, "true");
      continue;
    }
    parsed.set(key, next);
    index += 1;
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help")) {
    console.log("Usage: node clients/homis-sidecar/build-extension.mjs --env stg|prod [--output-dir PATH] [--zip]");
    return;
  }
  const environment = args.get("env");
  const outputDirectory = args.get("output-dir") || undefined;
  const result = await buildExtension({ environment, outputDirectory });
  if (args.has("zip")) {
    result.zipPath = await createZip({
      extensionDirectory: result.outputDirectory,
      zipPath: args.get("zip") === "true"
        ? path.join(defaultOutputRoot, `homis-sidecar-${result.environment}.zip`)
        : args.get("zip")
    });
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
