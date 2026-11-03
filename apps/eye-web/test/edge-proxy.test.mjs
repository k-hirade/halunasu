import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { matchProxyRoute, proxyToTarget } from "../lib/edge-proxy.mjs";

async function withUpstream(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("routes only the eye and platform API prefixes", () => {
  assert.equal(matchProxyRoute("/api/eye/v1/eye/context").targetEnv, "EYE_PROXY_TARGET");
  assert.equal(matchProxyRoute("/api/platform/v1/auth/session").targetEnv, "PLATFORM_PROXY_TARGET");
  assert.equal(matchProxyRoute("/reception"), null);
  assert.equal(matchProxyRoute("/api/eyes/x"), null);
});

test("forwards method, path, query, body and headers, and returns every Set-Cookie", async () => {
  let seen;
  await withUpstream((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen = { method: req.method, url: req.url, body, headers: req.headers };
      res.setHeader("set-cookie", ["session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "csrf=xyz; Path=/"]);
      res.setHeader("content-type", "application/json");
      res.writeHead(201);
      res.end(JSON.stringify({ ok: true }));
    });
  }, async (target) => {
    const request = new Request("https://eye.stg.halunasu.com/api/eye/v1/eye/patients/search?x=1", {
      method: "POST",
      headers: { cookie: "session=old", "x-csrf-token": "t", "content-type": "application/json", "x-forwarded-for": "6.6.6.6", connection: "keep-alive" },
      body: JSON.stringify({ q: "見本" })
    });
    const response = await proxyToTarget(request, { targetBaseUrl: target, prefix: "/api/eye/", clientIp: "203.0.113.5" });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(response.headers.getSetCookie(), ["session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "csrf=xyz; Path=/"]);
    assert.equal(response.headers.get("x-halunasu-proxy"), "edge");
  });
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/eye/patients/search?x=1");
  assert.equal(seen.body, JSON.stringify({ q: "見本" }));
  assert.equal(seen.headers.cookie, "session=old");
  assert.equal(seen.headers["x-csrf-token"], "t");
  assert.equal(seen.headers["x-forwarded-for"], "203.0.113.5", "the client cannot choose the IP used for rate limiting");
  assert.equal(seen.headers["x-forwarded-host"], "eye.stg.halunasu.com");
  assert.equal(seen.headers["x-forwarded-proto"], "https");
});

test("passes error statuses and redirects through unchanged", async () => {
  await withUpstream((req, res) => {
    if (req.url.startsWith("/v1/redirect")) {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ authenticated: false }));
  }, async (target) => {
    const denied = await proxyToTarget(new Request("https://x.test/api/platform/v1/auth/session"), { targetBaseUrl: target, prefix: "/api/platform/" });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { authenticated: false });
    const redirect = await proxyToTarget(new Request("https://x.test/api/platform/v1/redirect"), { targetBaseUrl: target, prefix: "/api/platform/" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/elsewhere");
  });
});

test("answers 502 when the API cannot be reached", async () => {
  const response = await proxyToTarget(new Request("https://x.test/api/eye/v1/eye/context"), {
    targetBaseUrl: "http://127.0.0.1:9",
    prefix: "/api/eye/",
    fetchImpl: () => Promise.reject(new Error("connect ECONNREFUSED"))
  });
  assert.equal(response.status, 502);
});
