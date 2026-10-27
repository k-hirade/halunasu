#!/usr/bin/env node
// config/cloudflare-dns-records.json の web レコードのうち、指定した名前だけを Cloudflare に作成・更新する。
// 既定は dry-run。トークンは環境変数 CLOUDFLARE_API_TOKEN か .secrets/cloudflare-dns-token.txt から読む
// （halunasu.com の DNS 編集だけに絞ったトークンを使う）。
//
//   node scripts/cloudflare_upsert_dns_records.mjs --names eye.stg,eye
//   node scripts/cloudflare_upsert_dns_records.mjs --names eye.stg,eye --apply
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const apply = args.get("apply") === "true";
const names = String(args.get("names") || "").split(",").map((name) => name.trim()).filter(Boolean);
if (names.length === 0) {
  console.error("Usage: node scripts/cloudflare_upsert_dns_records.mjs --names eye.stg,eye [--apply]");
  process.exit(64);
}

const config = JSON.parse(await readFile(join(root, "config", "cloudflare-dns-records.json"), "utf8"));
const token = (process.env.CLOUDFLARE_API_TOKEN || await readFile(join(root, ".secrets", "cloudflare-dns-token.txt"), "utf8").catch(() => "")).trim();
if (!token) {
  console.error("CLOUDFLARE_API_TOKEN or .secrets/cloudflare-dns-token.txt is required");
  process.exit(65);
}

const zone = await cloudflare(`/zones?name=${encodeURIComponent(config.zone)}`);
if (zone.result.length !== 1) throw new Error(`Zone not found or ambiguous: ${config.zone}`);
const zoneId = zone.result[0].id;

console.log(`Cloudflare DNS ${apply ? "APPLY" : "DRY RUN"}: ${config.zone}`);
for (const name of names) {
  const record = config.web.find((candidate) => candidate.name === name);
  if (!record) throw new Error(`Record is not declared in config/cloudflare-dns-records.json: ${name}`);
  const fqdn = `${name}.${config.zone}`;
  const existing = (await cloudflare(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(fqdn)}`)).result;
  const body = { type: record.type, name: fqdn, content: record.content, proxied: Boolean(record.proxied), ttl: 1 };
  const same = existing.find((item) => item.type === body.type && item.content === body.content && item.proxied === body.proxied);
  if (same) {
    console.log(`- ${fqdn}: already ${body.type} → ${body.content}`);
    continue;
  }
  if (existing.some((item) => item.type !== body.type || existing.length > 1)) {
    throw new Error(`Refusing to change ${fqdn}: existing records differ in type or count (${existing.map((item) => `${item.type}:${item.content}`).join(", ")})`);
  }
  console.log(`- ${fqdn}: ${existing.length ? "update" : "create"} ${body.type} → ${body.content} (proxied=${body.proxied})`);
  if (!apply) continue;
  if (existing.length) {
    await cloudflare(`/zones/${zoneId}/dns_records/${existing[0].id}`, { method: "PUT", body });
  } else {
    await cloudflare(`/zones/${zoneId}/dns_records`, { method: "POST", body });
  }
}
if (!apply) console.log("DRY RUN: no records changed. Add --apply to write.");

async function cloudflare(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(`Cloudflare ${method} ${path} failed: ${JSON.stringify(payload.errors || payload).slice(0, 300)}`);
  }
  return payload;
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed.set(value.slice(2), "true");
    } else {
      parsed.set(value.slice(2), next);
      index += 1;
    }
  }
  return parsed;
}
