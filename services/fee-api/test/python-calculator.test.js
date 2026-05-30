import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { PythonFeeCalculator } from "../src/python-calculator.js";

test("expands gzip-compressed fee master DB into runtime tmp path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-master-"));
  const gzipPath = path.join(root, "standard-master.sqlite.gz");
  const dbPath = path.join(root, "runtime", "standard-master.sqlite");
  writeFileSync(gzipPath, gzipSync(Buffer.from("sqlite fixture", "utf8")));

  const calculator = new PythonFeeCalculator({
    masterDbPath: dbPath,
    masterDbGzipPath: gzipPath
  });

  assert.equal(calculator.readiness().masterDbPathExists, false);
  assert.equal(calculator.readiness().masterDbGzipPathExists, true);

  await calculator.ensureMasterDbReady();

  assert.equal(readFileSync(dbPath, "utf8"), "sqlite fixture");
  assert.equal(calculator.readiness().masterDbPathExists, true);
});
