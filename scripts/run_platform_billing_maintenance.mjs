#!/usr/bin/env node

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const urlArg = process.argv.find((arg) => arg.startsWith("--url="));
const secretArg = process.argv.find((arg) => arg.startsWith("--secret="));
const baseUrl = (urlArg ? urlArg.slice("--url=".length) : process.env.PLATFORM_API_BASE_URL || "").replace(/\/$/u, "");
const secret = secretArg ? secretArg.slice("--secret=".length) : process.env.PLATFORM_MAINTENANCE_SECRET || "";

if (!baseUrl || !secret) {
  console.error("Usage: PLATFORM_API_BASE_URL=https://... PLATFORM_MAINTENANCE_SECRET=... node scripts/run_platform_billing_maintenance.mjs [--dry-run]");
  process.exit(1);
}

const response = await fetch(`${baseUrl}/v1/internal/billing/maintenance`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Halunasu-Maintenance-Secret": secret
  },
  body: JSON.stringify({ dryRun })
});
const payload = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload.billingMaintenance || payload, null, 2));
