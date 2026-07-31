#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createTotpCode } from "../services/platform-api/src/auth/mfa.js";

const options = parseArgs(process.argv.slice(2));

if (!options.apply) {
  throw new Error("Refusing to enroll MFA without --apply.");
}

const password = readSecret(options.passwordFile);
const outputPath = path.resolve(options.secretOutput);

if (fs.existsSync(outputPath)) {
  throw new Error(`Refusing to overwrite an existing MFA secret: ${outputPath}`);
}

const login = await requestJson(`${options.baseUrl}/v1/auth/login`, {
  method: "POST",
  body: {
    organizationCode: options.organizationCode,
    loginId: options.loginId,
    password
  }
});

assertResponse(login, "login", 200);

if (login.body?.session?.mfaEnrolled) {
  throw new Error("The account already has MFA enrolled; no local secret was changed.");
}

if (!login.body?.session?.mfaRequired) {
  throw new Error("The account does not require MFA; refusing to create an unused secret.");
}

const cookie = cookieHeader(login.headers);
const csrfToken = String(login.body?.csrfToken || "");

if (!cookie || !csrfToken) {
  throw new Error("Login did not return the session cookie and CSRF token required for MFA enrollment.");
}

const enrollment = await requestJson(`${options.baseUrl}/v1/auth/mfa/enroll`, {
  method: "POST",
  cookie,
  csrfToken,
  body: {}
});

assertResponse(enrollment, "MFA enrollment", 201);

const secret = String(enrollment.body?.mfa?.secret || "").trim();

if (!secret) {
  throw new Error("MFA enrollment did not return a TOTP secret.");
}

const verification = await requestJson(`${options.baseUrl}/v1/auth/mfa/verify`, {
  method: "POST",
  cookie,
  csrfToken,
  body: {
    code: createTotpCode(secret)
  }
});

assertResponse(verification, "MFA verification", 200);

if (
  verification.body?.mfa?.enrolled !== true
  || verification.body?.session?.mfaEnrolled !== true
  || verification.body?.session?.mfaVerified !== true
) {
  throw new Error("MFA verification returned an incomplete enrolled session.");
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputPath, `${secret}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx"
});
fs.chmodSync(outputPath, 0o600);

console.log(JSON.stringify({
  status: "enrolled",
  organizationCode: options.organizationCode,
  loginId: options.loginId,
  mfaRequired: true,
  mfaEnrolled: true,
  secretOutput: outputPath
}, null, 2));

function parseArgs(argv) {
  const parsed = {
    apply: false,
    baseUrl: "",
    organizationCode: "",
    loginId: "",
    passwordFile: "",
    secretOutput: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--apply") {
      parsed.apply = true;
      continue;
    }

    const name = {
      "--base-url": "baseUrl",
      "--organization-code": "organizationCode",
      "--login-id": "loginId",
      "--password-file": "passwordFile",
      "--secret-output": "secretOutput"
    }[argument];

    if (!name || index + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }

    parsed[name] = String(argv[index + 1] || "").trim();
    index += 1;
  }

  for (const name of ["baseUrl", "organizationCode", "loginId", "passwordFile", "secretOutput"]) {
    if (!parsed[name]) {
      throw new Error(`Missing required option: ${name}`);
    }
  }

  const baseUrl = new URL(parsed.baseUrl);

  if (baseUrl.protocol !== "https:" || baseUrl.pathname !== "/") {
    throw new Error("--base-url must be an HTTPS origin without a path.");
  }

  parsed.baseUrl = baseUrl.origin;
  return parsed;
}

function readSecret(filename) {
  const value = fs.readFileSync(path.resolve(filename), "utf8").trim();

  if (!value) {
    throw new Error(`Secret file is empty: ${filename}`);
  }

  return value;
}

async function requestJson(url, {
  method,
  body,
  cookie = "",
  csrfToken = ""
}) {
  const headers = {
    "content-type": "application/json"
  };

  if (cookie) {
    headers.cookie = cookie;
  }

  if (csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  return {
    status: response.status,
    headers: response.headers,
    body: payload
  };
}

function cookieHeader(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);

  return values
    .map((value) => String(value).split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

function assertResponse(response, label, expectedStatus) {
  if (response.status === expectedStatus) {
    return;
  }

  const message = response.body?.message || response.body?.error || "unknown error";
  throw new Error(`${label} failed (HTTP ${response.status}): ${message}`);
}
