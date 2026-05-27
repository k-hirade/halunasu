import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePlatformApiResponse } from "../src/server.js";

test("GET /healthz returns ok", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/healthz"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.service, "platform-api");
});

test("GET /readyz includes environment metadata", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/readyz",
    env: "test",
    projectId: "medical-core-stg",
    region: "asia-northeast1",
    startedAt: new Date("2026-05-27T00:00:00.000Z")
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.env, "test");
  assert.equal(response.body.projectId, "medical-core-stg");
  assert.equal(response.body.region, "asia-northeast1");
  assert.equal(response.body.startedAt, "2026-05-27T00:00:00.000Z");
});

test("unknown route returns 404", async () => {
  const response = resolvePlatformApiResponse({
    method: "GET",
    path: "/missing"
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "not_found");
});
