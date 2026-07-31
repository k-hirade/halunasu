import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildExtension } from "../build-extension.mjs";

test("prod build uses only PROD APIs while preserving the approved extension id", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "homis-sidecar-prod-build-"));
  const outputDirectory = path.join(temporaryRoot, "extension");
  try {
    const result = await buildExtension({ environment: "prod", outputDirectory });
    const manifest = JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"));
    const environmentSource = await readFile(
      path.join(outputDirectory, "lib", "environment.js"),
      "utf8"
    );

    assert.equal(result.extensionId, "nhbmaniknlcaaelpaoogepmkhphmmjof");
    assert.equal(extensionIdForKey(manifest.key), result.extensionId);
    assert.equal(manifest.version_name.endsWith("-prod"), true);
    assert.equal(
      manifest.host_permissions.includes("https://platform-api-prod-3ia4p23nna-an.a.run.app/*"),
      true
    );
    assert.equal(
      manifest.host_permissions.includes("https://fee-api-prod-litocmjdaa-an.a.run.app/*"),
      true
    );
    assert.equal(manifest.host_permissions.some((value) => value.includes("-stg-")), false);
    assert.match(environmentSource, /"environment": "prod"/);
    assert.match(environmentSource, /https:\/\/fee\.halunasu\.com\/settings\/sidecar-approvals/);
    assert.doesNotMatch(environmentSource, /stg\.halunasu/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("stg and prod builds use isolated endpoint and storage environments", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "homis-sidecar-env-build-"));
  try {
    const stgDirectory = path.join(temporaryRoot, "stg");
    const prodDirectory = path.join(temporaryRoot, "prod");
    const [stg, prod] = await Promise.all([
      buildExtension({ environment: "stg", outputDirectory: stgDirectory }),
      buildExtension({ environment: "prod", outputDirectory: prodDirectory })
    ]);
    const [stgEnvironment, prodEnvironment] = await Promise.all([
      readFile(path.join(stgDirectory, "lib", "environment.js"), "utf8"),
      readFile(path.join(prodDirectory, "lib", "environment.js"), "utf8")
    ]);

    assert.equal(stg.extensionId, prod.extensionId);
    assert.match(stgEnvironment, /"environment": "stg"/);
    assert.match(prodEnvironment, /"environment": "prod"/);
    assert.notEqual(stg.platformBaseUrl, prod.platformBaseUrl);
    assert.notEqual(stg.feeBaseUrl, prod.feeBaseUrl);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function extensionIdForKey(publicKey) {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}
