import assert from "node:assert/strict";
import test from "node:test";
import { proxyApiRequest } from "../../app/api/proxy-utils.js";
import {
  adminRoutes,
  appUrl,
  installGatewayMocks,
  operatorSession,
  withPage
} from "./helpers/e2e-utils.js";

test("API proxy preserves all Set-Cookie headers on logout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    statusText: "OK",
    body: JSON.stringify({ ok: true }),
    headers: {
      *entries() {
        yield ["set-cookie", "soaplane_operator_session=; HttpOnly; Path=/; Max-Age=0; Secure; SameSite=None"];
        yield ["set-cookie", "soaplane_operator_csrf=; Path=/; Max-Age=0; Secure; SameSite=None"];
        yield ["content-type", "application/json; charset=utf-8"];
      }
    }
  });

  try {
    const response = await proxyApiRequest(
      new Request("https://charting.halunasu.com/api/v1/operator/logout", { method: "POST" }),
      ["operator", "logout"],
      "https://charting-gateway.example"
    );
    const cookies = response.headers.getSetCookie();
    assert.equal(response.status, 200);
    assert.equal(cookies.length, 2);
    assert.ok(cookies.some((cookie) => cookie.startsWith("soaplane_operator_session=")));
    assert.ok(cookies.some((cookie) => cookie.startsWith("soaplane_operator_csrf=")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("account logout waits for the server session to be cleared before returning home", { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    let isLoggedIn = true;
    let logoutCompleted = false;

    await installGatewayMocks(page, [
      {
        method: "GET",
        path: "/api/v1/operator/me",
        handler: () => (
          isLoggedIn
            ? operatorSession
            : { status: 401, body: { authenticated: false } }
        )
      },
      {
        method: "POST",
        path: "/api/v1/operator/logout",
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          isLoggedIn = false;
          logoutCompleted = true;
          return { ok: true };
        }
      },
      ...adminRoutes()
    ]);

    await page.goto(appUrl("/admin?section=account"), { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "ログアウト" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "ログアウト" }).click();
    await page.waitForURL(/\/$/);
    await page.getByLabel("病院コード").waitFor({ state: "visible" });

    assert.equal(logoutCompleted, true);
  });
});
