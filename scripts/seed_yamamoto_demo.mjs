#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configuration = Object.freeze({
  stg: {
    organizationCode: "yamamoto-demo-stg",
    organizationName: "Yamamoto Demo STG",
    feeProjectId: "halunasu-fee-stg",
    passwordPrefix: "yamamoto-demo-stg"
  },
  prod: {
    organizationCode: "yamamoto-demo",
    organizationName: "Yamamoto Demo",
    feeProjectId: "halunasu-fee-prod",
    passwordPrefix: "yamamoto-demo"
  }
});

const args = parseArgs(process.argv.slice(2));
if (args.has("help")) {
  printUsage();
  process.exit(0);
}

const targetEnvironment = String(args.get("env") || "").trim();
if (!configuration[targetEnvironment]) {
  throw new Error("--env must be explicitly set to stg or prod");
}
const apply = args.has("apply");
const resetPassword = args.has("reset-password");
const loginIds = csv(args.get("login-ids") || "keishi,goshi,yamamoto");
const selected = configuration[targetEnvironment];
const passwordDirectory = path.resolve(
  repositoryRoot,
  args.get("password-dir") || ".secrets"
);
await mkdir(passwordDirectory, { recursive: true });

for (const loginId of loginIds) {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(loginId)) {
    throw new Error(`invalid login ID: ${loginId}`);
  }
  const passwordFile = path.join(
    passwordDirectory,
    `${selected.passwordPrefix}-${loginId}-password.txt`
  );
  const passwordExists = await access(passwordFile).then(() => true).catch(() => false);
  const command = [
    process.execPath,
    path.join(repositoryRoot, "scripts", "p15_seed_core_account.mjs"),
    "--env", targetEnvironment,
    "--organization-code", selected.organizationCode,
    "--organization-name", selected.organizationName,
    "--login-id", loginId,
    "--products", "fee,homis_sidecar",
    "--facility-name", selected.organizationCode,
    "--department-name", "医事課",
    "--member-role-profile", "admin",
    "--member-display-prefix", "Yamamoto Demo",
    "--fee-project-id", selected.feeProjectId,
    "--fee-settings-file", "samples/yamamoto-demo-stg/fee-settings.json",
    "--skip-demo-patient",
    passwordExists ? "--password-file" : "--generate-password-file",
    passwordFile
  ];
  if (apply) {
    command.push("--apply");
  }
  if (resetPassword) {
    command.push("--reset-password");
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`unknown argument: ${value}`);
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

function printUsage() {
  console.log(
    "Usage: npm run seed:yamamoto-demo -- --env stg|prod "
    + "[--login-ids keishi,goshi,yamamoto] [--apply] [--reset-password]"
  );
}
