import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = await readFile(path.resolve(here, "../extension/sidepanel.js"), "utf8");
const apiSource = await readFile(path.resolve(here, "../extension/lib/api.js"), "utf8");
const environmentSource = await readFile(path.resolve(here, "../extension/lib/environment.js"), "utf8");

test("calculate request snapshot keeps the v1 sidecar boundary", () => {
  for (const field of [
    "contractVersion", "sourceSystem", "externalPatientId", "sourceRecordId", "serviceDate",
    "setting", "encounterTypeSource", "visitKind", "visitKindSource", "telephoneEligibility",
    "sameBuilding", "sameBuildingSource",
    "singleBuildingPatientCount", "clinicalText", "sourceSurfaces", "extractionProof"
  ]) {
    assert.match(panelSource, new RegExp(`\\b${field}\\b`));
  }
  assert.match(apiSource, /\/v1\/integrations\/sidecar\/calculate/);
  assert.match(apiSource, /\/candidate-acknowledgements\//);
  assert.match(apiSource, /setCandidateAcknowledgement/);
  assert.match(apiSource, /expectedSourceRevision/);
  assert.match(apiSource, /expectedCalculationRevision/);
  assert.match(apiSource, /expectedAcknowledgementVersion/);
  assert.match(apiSource, /candidateFingerprint/);
  assert.doesNotMatch(apiSource, /\/v1\/fee\/(?:sessions|patients|calculate)/);
});

test("only the revocable grant and public device id enter extension storage", () => {
  assert.match(apiSource, /halunasuSidecar:\$\{configuration\.environment\}/);
  assert.match(apiSource, /LEGACY_DEVICE_ID_KEY/);
  assert.match(apiSource, /LEGACY_GRANT_ID_KEY/);
  assert.doesNotMatch(apiSource, /storageSet\([^)]*accessToken/s);
  assert.doesNotMatch(apiSource, /storageSet\([^)]*verifier/s);
  assert.doesNotMatch(apiSource, /storageSet\([^)]*(?:candidateKey|candidateFingerprint|acknowledgement)/s);
});

test("API endpoints come from validated build-time environment config", () => {
  assert.match(apiSource, /validateConfiguration\(global\.HalunasuSidecarConfig\)/);
  assert.doesNotMatch(apiSource, /platform-api-(?:stg|prod)-/);
  assert.doesNotMatch(apiSource, /fee-api-(?:stg|prod)-/);
  assert.match(environmentSource, /environment: "stg"/);
});
