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

test("routes master search through persistent worker and caches identical queries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-master-search-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  writeFileSync(dbPath, "sqlite fixture");

  const calculator = new PythonFeeCalculator({
    masterDbPath: dbPath,
    workerMode: true,
    masterSearchCacheTtlMs: 60_000
  });
  let workerCalls = 0;
  calculator.runWorkerJson = async (payload, options) => {
    workerCalls += 1;
    assert.equal(payload.op, "master_search");
    assert.equal(payload.db_path, dbPath);
    assert.equal(payload.type, "procedure");
    assert.equal(payload.query, "再診料");
    assert.equal(payload.limit, 5);
    assert.equal(options.requestIdPrefix, "fee_master_search");
    return {
      query: payload.query,
      type: payload.type,
      items: [{ kind: "procedure", code: "112007410", name: "再診料" }]
    };
  };

  const first = await calculator.searchMaster({ type: "procedure", query: "再診料", limit: 5 });
  const second = await calculator.searchMaster({ type: "procedure", query: "再診料", limit: 5 });

  assert.equal(workerCalls, 1);
  assert.deepEqual(second, first);
  assert.equal(calculator.readiness().masterSearchCacheEntries, 1);
});

test("reports detailed master readiness with checksums and source metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fee-master-readyz-"));
  const dbPath = path.join(root, "standard-master.sqlite");
  const gzipPath = path.join(root, "standard-master.sqlite.gz");
  writeFileSync(dbPath, "sqlite fixture");
  writeFileSync(gzipPath, gzipSync(Buffer.from("sqlite fixture", "utf8")));

  const calculator = new PythonFeeCalculator({
    masterDbPath: dbPath,
    masterDbGzipPath: gzipPath
  });
  calculator.browseMaster = async (input) => {
    assert.equal(input.type, "sources");
    return {
      sources: [{
        sourceType: "medical_procedure_master",
        sourceVersion: "2026-06-15",
        publishedAt: "2026-06-05",
        rowCount: 11746,
        checksumSha256: "procedure-checksum",
        sourceUrl: "https://www.ssk.or.jp/example.zip"
      }],
      medicalElectronicFeeTableVersion: "2026-06-15",
      dpcStatus: { mode: "review_only", counts: { electronicTableRows: 0 } }
    };
  };

  const detailed = await calculator.readinessDetailed();

  assert.equal(detailed.masterDbChecksumSha256.length, 64);
  assert.equal(detailed.masterDbGzipChecksumSha256.length, 64);
  assert.equal(detailed.masterSources[0].sourceVersion, "2026-06-15");
  assert.equal(detailed.medicalElectronicFeeTableVersion, "2026-06-15");
  assert.equal(detailed.dpcStatus.mode, "review_only");
});
