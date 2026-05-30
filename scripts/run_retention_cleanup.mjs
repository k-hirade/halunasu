#!/usr/bin/env node

import { createStore, nowIso } from "@medical/core";

function readArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

const dryRun = !process.argv.includes("--apply");
const orgId = readArg("org-id") || null;
const store = createStore({
  backend: process.env.STORE_BACKEND || "firestore"
});

if (typeof store.runRetentionCleanup !== "function") {
  throw new Error("The configured store does not support retention cleanup");
}

const result = await store.runRetentionCleanup({
  orgId,
  dryRun,
  actorId: "retention-cleanup-script"
});

console.log(JSON.stringify({
  ok: true,
  dryRun,
  timestamp: nowIso(),
  result
}, null, 2));
