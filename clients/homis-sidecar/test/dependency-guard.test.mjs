import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "../extension");

test("extension has no server-internal imports or sensitive input surface", async () => {
  const files = await sourceFiles(extensionDir);
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /(?:packages|services)\//);
  assert.doesNotMatch(source, /sourceUrl/);
  assert.doesNotMatch(source, /type=["']password["']/i);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(source, /candidateOnly|承認前/);
});

test("manifest public key fixes the unpacked extension id", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
  const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  const extensionId = [...digest]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
  assert.equal(extensionId, "nhbmaniknlcaaelpaoogepmkhphmmjof");
  assert.deepEqual(manifest.permissions.sort(), ["sidePanel", "storage", "tabs"]);
  for (const origin of ["localhost", "127.0.0.1", "0.0.0.0"]) {
    assert.equal(manifest.host_permissions.includes(`http://${origin}:8899/*`), true);
    assert.equal(manifest.content_scripts[0].matches.includes(`http://${origin}:8899/homic/*`), true);
  }
  assert.equal(manifest.host_permissions.some((value) => value.includes("fee-api-stg")), true);
  assert.equal(manifest.host_permissions.some((value) => value.includes("fee-api-prod")), false);
});

test("side panel hides inactive sections and explains a missing content script", async () => {
  const [css, panel] = await Promise.all([
    readFile(path.join(extensionDir, "sidepanel.css"), "utf8"),
    readFile(path.join(extensionDir, "sidepanel.js"), "utf8")
  ]);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(panel, /Receiving end does not exist/);
  assert.match(panel, /拡張機能とカルテ画面を再読み込みしてください/);
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(target);
    }
    return /\.(?:js|html|json)$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}
