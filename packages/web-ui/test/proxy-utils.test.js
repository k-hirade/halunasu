import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyApiRequest, splitSetCookieHeader } from "../src/proxy-utils.js";

test("splitSetCookieHeader splits multiple cookies and respects Expires commas", () => {
  assert.deepEqual(splitSetCookieHeader(""), []);
  assert.deepEqual(splitSetCookieHeader("a=1"), ["a=1"]);
  assert.deepEqual(splitSetCookieHeader("a=1, b=2"), ["a=1", "b=2"]);
  // Expires の値内コンマは区切りにせず、属性区切りの ; 後の , で分割する
  const withExpires = "s=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly, t=2; Path=/";
  assert.deepEqual(splitSetCookieHeader(withExpires), [
    "s=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly",
    "t=2; Path=/"
  ]);
});

test("proxyApiRequest returns 503 when target is not configured", async () => {
  const response = await proxyApiRequest({ url: "http://localhost/api/x", method: "GET", headers: new Map() }, ["x"], "");
  assert.equal(response.status, 503);
});
