import assert from "node:assert/strict";
import test from "node:test";
import {
  appUrl,
  installGatewayMocks,
  operatorSession,
  withPage
} from "./helpers/e2e-utils.js";

test("session quick start uses a refreshed CSRF cookie after login", { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    let isLoggedIn = false;
    let csrfRefreshCount = 0;
    let latestCsrfToken = "";
    let createSessionCsrfToken = "";

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
        path: "/api/v1/operator/login",
        handler: () => {
          isLoggedIn = true;
          return {
            accessToken: "__cookie_operator_session__",
            csrfToken: "csrf-from-login",
            ...operatorSession
          };
        }
      },
      {
        method: "GET",
        path: "/api/v1/operator/csrf",
        handler: () => {
          csrfRefreshCount += 1;
          latestCsrfToken = `csrf-from-refresh-${csrfRefreshCount}`;
          return { csrfToken: latestCsrfToken };
        }
      },
      {
        method: "GET",
        path: "/api/v1/sessions",
        handler: () => ({
          sessions: [],
          page: 1,
          pageSize: 20,
          totalCount: 0,
          totalPages: 0
        })
      },
      {
        method: "POST",
        path: "/api/v1/sessions",
        handler: ({ request }) => {
          createSessionCsrfToken = request.headers()["x-csrf-token"] || "";
          return {
            body: {
              sessionId: "session-created",
              status: "ready",
              pairingId: "pairing-created",
              pairingToken: "pairing-token",
              pairingCode: "123456",
              expiresAt: "2026-05-30T07:00:00.000Z"
            }
          };
        }
      }
    ]);

    await page.goto(appUrl("/sessions"), { waitUntil: "domcontentloaded" });
    await page.getByLabel("病院コード").fill("prod-test");
    await page.getByLabel("個人ID").fill("keishi");
    await page.getByLabel("ログイン用パスワード").fill("secret");
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.getByRole("button", { name: "診療記録を作成" }).waitFor({ state: "visible" });

    assert.ok(csrfRefreshCount >= 1);

    await page.getByRole("button", { name: "診療記録を作成" }).click();
    await page.waitForURL(/\/sessions\/session-created$/);

    assert.equal(createSessionCsrfToken, latestCsrfToken);
    assert.notEqual(createSessionCsrfToken, "csrf-from-login");
  });
});
