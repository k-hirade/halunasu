import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = await readFile(path.resolve(here, "../extension/sidepanel.js"), "utf8");
const apiSource = await readFile(path.resolve(here, "../extension/lib/api.js"), "utf8");

test("calculate request snapshot keeps the v1 sidecar boundary", () => {
  for (const field of [
    "contractVersion", "sourceSystem", "externalPatientId", "sourceRecordId", "serviceDate",
    "setting", "encounterTypeSource", "clinicalText", "extractionProof"
  ]) {
    assert.match(panelSource, new RegExp(`\\b${field}\\b`));
  }
  assert.match(apiSource, /\/v1\/integrations\/sidecar\/calculate/);
  assert.doesNotMatch(apiSource, /\/v1\/fee\/(?:sessions|patients|calculate)/);
});

test("only the revocable grant and public device id enter extension storage", () => {
  const storageKeys = [...apiSource.matchAll(/const\s+([A-Z_]+)_KEY\s*=/g)].map((match) => match[1]).sort();
  assert.deepEqual(storageKeys, ["DEVICE_ID", "GRANT_ID"]);
  assert.doesNotMatch(apiSource, /storageSet\([^)]*accessToken/s);
  assert.doesNotMatch(apiSource, /storageSet\([^)]*verifier/s);
});
