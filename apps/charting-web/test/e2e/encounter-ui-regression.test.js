import assert from "node:assert/strict";
import test from "node:test";
import {
  appUrl,
  assertElementCanScroll,
  assertNoPageHorizontalOverflow,
  createLongEncounterFixture,
  encounterRoutes,
  installGatewayMocks,
  withPage
} from "./helpers/e2e-utils.js";

const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "tablet", width: 768, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];

test("SOAP-ready encounter keeps transcript, SOAP output, copy, and approval controls usable", { timeout: 90_000 }, async () => {
  for (const viewport of viewports) {
    await withPage(async (page) => {
      await installGatewayMocks(page, encounterRoutes(createLongEncounterFixture()));
      await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });

      await page.getByRole("heading", { name: "診療記録" }).waitFor({ state: "visible" });
      assert.equal(await page.locator(".workspace-bar").count(), 0);
      assert.equal(await page.getByRole("button", { name: /^レイアウト：/ }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "キーボードショートカット" }).count(), 0);
      await page.locator(".soap-prompt-trigger").click();
      assert.equal(await page.locator(".soap-prompt-menu-head small").count(), 0);
      await page.keyboard.press("Escape");
      if (viewport.name === "desktop") {
        await page.keyboard.press("l");
        await page.waitForFunction(() => document.querySelector(".workspace")?.className.includes("workspace--layout-soap"));
      }
      await assertNoPageHorizontalOverflow(page, viewport.name);

      const copyButton = page.getByRole("button", { name: "診療記録全文をコピー" });
      await copyButton.scrollIntoViewIfNeeded();
      await copyButton.click();
      assert.match(await page.evaluate(() => window.__lastClipboardText || ""), /診療記録本文 1/);

      const approveButton = page.getByRole("button", { name: /確定する/ });
      await approveButton.scrollIntoViewIfNeeded();
      assert.equal(await approveButton.isEnabled(), true, `${viewport.name}: approval button should be enabled`);

      await page.locator(".transcript-reference").evaluate((element) => {
        element.open = true;
      });
      await page.locator(".transcript-reference-body").waitFor({ state: "visible" });

      if (viewport.width >= 769) {
        await assertElementCanScroll(page, ".review-transcript-readonly", `${viewport.name} final transcript`);
        await assertElementCanScroll(page, ".transcript-reference-body", `${viewport.name} realtime transcript reference`);
        await assertElementCanScroll(page, ".editor-textarea--soap-output", `${viewport.name} SOAP output`);
      }

      await assertNoPageHorizontalOverflow(page, `${viewport.name} after interactions`);
    }, { viewport });
  }
});

test("ready encounter patient information controls do not force horizontal scrolling", { timeout: 60_000 }, async () => {
  const fixture = createLongEncounterFixture({ status: "ready" });
  fixture.latestSoap = null;
  fixture.turns = [];
  fixture.session.patientDisplayName = "";
  fixture.session.visitReason = "";

  await withPage(async (page) => {
    await installGatewayMocks(page, [
      ...encounterRoutes(fixture),
      {
        method: "GET",
        path: "/api/v1/core/patients",
        handler: () => ({
          patients: [
            {
              patientId: "pat_001",
              displayName: "山田 花子",
              patientCode: "P-001"
            }
          ]
        })
      },
      {
        method: "GET",
        path: "/api/v1/core/facilities",
        handler: () => ({
          facilities: [
            {
              facilityId: "fac_001",
              displayName: "prod-test"
            }
          ]
        })
      },
      {
        method: "GET",
        path: "/api/v1/core/departments",
        handler: () => ({
          departments: [
            {
              departmentId: "dep_001",
              facilityId: "fac_001",
              displayName: "内科"
            }
          ]
        })
      },
      {
        method: "POST",
        path: "/api/v1/sessions/session-e2e/metadata",
        handler: async ({ request }) => {
          const body = await request.postDataJSON();
          return {
            session: {
              ...fixture.session,
              ...body
            }
          };
        }
      }
    ]);
    await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });

    await page.getByRole("heading", { name: "診療記録" }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".session-settings-meta").count(), 0);
    assert.equal(await page.locator(".patient-info-card").getByText("未入力").count(), 0);
    await page.getByRole("button", { name: /患者情報/ }).click();
    assert.equal(await page.locator(".patient-info-card").getByText("未入力").count(), 0);
    assert.equal(await page.locator(".patient-info-card .field-label", { hasText: "施設" }).count(), 0);
    assert.equal(await page.locator(".patient-info-card").getByText("この病院では施設は固定です").count(), 0);
    assert.equal(await page.locator(".patient-info-card").getByText("prod-test").count(), 0);
    await page.getByLabel("患者名").fill("横幅が狭い端末でも折り返す確認用の長い患者名");
    await page.getByLabel("症状・相談内容").fill("長い主訴を入力しても、保存ボタンや録音操作が横スクロール前提にならないことを確認する。");

    await assertNoPageHorizontalOverflow(page, "mobile patient info");
    const saveButton = page.getByRole("button", { name: "保存", exact: true });
    await saveButton.scrollIntoViewIfNeeded();
    await saveButton.click();
    await page.getByText("患者情報を保存しました").waitFor({ state: "visible" });
    await assertNoPageHorizontalOverflow(page, "mobile patient info after save");
  }, { viewport: { width: 390, height: 844 } });
});

test("stopped encounter can discard recording and return to recording-ready state", { timeout: 30_000 }, async () => {
  const stoppedFixture = createLongEncounterFixture({ status: "stopped" });
  stoppedFixture.latestSoap = null;
  stoppedFixture.turns = [
    {
      turnId: "turn-discard",
      turnIndex: 1,
      speaker: "doctor",
      text: "破棄される録音の書き起こしです。",
      startMs: 0,
      endMs: 3000,
      confidence: 0.9
    }
  ];
  stoppedFixture.session.audioSourceType = "local_browser";
  stoppedFixture.session.audioConnectionState = "disconnected";

  const readyFixture = createLongEncounterFixture({ status: "ready" });
  readyFixture.latestSoap = null;
  readyFixture.turns = [];
  readyFixture.session.audioSourceType = null;
  readyFixture.session.audioConnectionState = "disconnected";
  readyFixture.session.latestFinalTurnIndex = 0;

  let discarded = false;
  let discardCalls = 0;

  await withPage(async (page) => {
    const calls = await installGatewayMocks(page, [
      {
        method: "GET",
        path: "/api/v1/sessions/session-e2e",
        handler: () => (discarded ? readyFixture : stoppedFixture)
      },
      {
        method: "POST",
        path: "/api/v1/sessions/session-e2e/recording/discard",
        handler: () => {
          discarded = true;
          discardCalls += 1;
          return { session: readyFixture.session };
        }
      },
      {
        method: "POST",
        path: "/api/v1/sessions/session-e2e/pairings",
        handler: () => ({
          pairingId: "pair-e2e",
          pairingToken: "token-e2e",
          pairingCode: "123456",
          pairingUrl: "https://charting.halunasu.com/mobile/join?pairingId=pair-e2e&token=token-e2e",
          expiresAt: "2026-04-19T09:00:00.000Z"
        })
      },
      ...encounterRoutes(stoppedFixture)
    ]);

    await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "診療記録" }).waitFor({ state: "visible" });
    assert.equal(await page.getByText("破棄される録音の書き起こしです。").count(), 1);

    await page.getByRole("button", { name: /録音を破棄して録り直す|録り直す/ }).last().click();
    await page.getByRole("dialog", { name: /この録音を破棄して録り直しますか/ }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "破棄して録り直す", exact: true }).click();

    await page.waitForFunction(() => !document.querySelector("[aria-labelledby='confirm-discard-title']"));
    await page.getByRole("button", { name: "この端末で録音", exact: true }).waitFor({ state: "visible" });

    assert.equal(discardCalls, 1);
    assert.ok(calls.some((call) => call.method === "POST" && call.path === "/api/v1/sessions/session-e2e/recording/discard"));
    assert.equal(await page.getByText("破棄される録音の書き起こしです。").count(), 0);
  });
});

test("finalizing encounter refreshes SOAP output without a WebSocket completion event", { timeout: 30_000 }, async () => {
  const finalizingFixture = createLongEncounterFixture({ status: "finalizing" });
  finalizingFixture.latestSoap = null;
  finalizingFixture.session.updatedAt = "2026-04-20T09:46:22.845Z";
  const readyFixture = createLongEncounterFixture({ status: "soap_ready" });
  readyFixture.session.updatedAt = "2026-04-20T09:46:33.584Z";
  readyFixture.latestSoap.updatedAt = "2026-04-20T09:46:33.584Z";
  let sessionReads = 0;
  const readTimes = [];

  await withPage(async (page) => {
    await installGatewayMocks(page, [
      {
        method: "GET",
        path: "/api/v1/sessions/session-e2e",
        handler: () => {
          sessionReads += 1;
          readTimes.push(Date.now());
          return sessionReads === 1 ? finalizingFixture : readyFixture;
        }
      },
      ...encounterRoutes(finalizingFixture)
    ]);

    await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });
    await page.getByText("処理中").first().waitFor({ state: "visible" });
    await page.getByText("診療記録本文 1").waitFor({ state: "visible" });

    assert.ok(sessionReads >= 2, "finalizing session should be refreshed after initial load");
    assert.ok(
      readTimes[1] - readTimes[0] >= 800,
      `finalizing poll should wait about one second before refreshing (${readTimes[1] - readTimes[0]}ms)`
    );
    assert.equal(await page.getByRole("button", { name: "診療記録全文をコピー" }).isEnabled(), true);
  });
});

test("recording encounter animates listening progress only during audio activity", { timeout: 30_000 }, async () => {
  const fixture = createLongEncounterFixture({ status: "recording" });
  fixture.latestSoap = null;
  fixture.turns = [];

  await withPage(async (page) => {
    await installGatewayMocks(page, encounterRoutes(fixture));
    await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });

    await page.getByText("話し始めると書き起こしが表示されます。").waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__mockWebSockets?.length > 0);
    await page.evaluate(() => {
      for (const ws of window.__mockWebSockets) {
        const event = new MessageEvent("message", {
          data: JSON.stringify({
            type: "audio.activity",
            sessionId: "session-e2e",
            audioSourceType: "linked_mobile",
            receivedAt: new Date().toISOString()
          })
        });
        ws.dispatchEvent(event);
        ws.onmessage?.(event);
      }
    });

    await page.locator(".listening-dots").waitFor({ state: "visible" });
    await page.locator(".listening-dots").waitFor({ state: "hidden", timeout: 5000 });

    await page.evaluate(() => {
      for (const ws of window.__mockWebSockets) {
        const audioEvent = new MessageEvent("message", {
          data: JSON.stringify({
            type: "audio.activity",
            sessionId: "session-e2e",
            audioSourceType: "linked_mobile",
            receivedAt: new Date().toISOString()
          })
        });
        ws.dispatchEvent(audioEvent);
        ws.onmessage?.(audioEvent);
        const event = new MessageEvent("message", {
          data: JSON.stringify({
            type: "transcript.final",
            sessionId: "session-e2e",
            turnId: "turn-first",
            turnIndex: 1,
            speaker: "patient",
            text: "咳が出ています。",
            startMs: 0,
            endMs: 2000,
            confidence: 0.94
          })
        });
        ws.dispatchEvent(event);
        ws.onmessage?.(event);
      }
    });

    await page.getByText("咳が出ています。").waitFor({ state: "visible" });
    assert.equal(await page.locator(".transcript-turn-time").count(), 0);
    assert.equal(await page.locator(".listening-dots").count(), 0);

    await page.evaluate(() => {
      for (const ws of window.__mockWebSockets) {
        const event = new MessageEvent("message", {
          data: JSON.stringify({
            type: "audio.activity",
            sessionId: "session-e2e",
            audioSourceType: "linked_mobile",
            receivedAt: new Date().toISOString()
          })
        });
        ws.dispatchEvent(event);
        ws.onmessage?.(event);
      }
    });

    const pendingTurn = page.locator("[aria-label='発話 2 の書き起こし準備中']");
    await pendingTurn.waitFor({ state: "visible" });
    await pendingTurn.locator(".listening-dots").waitFor({ state: "visible" });
    await pendingTurn.waitFor({ state: "hidden", timeout: 5000 });

    assert.equal(await page.getByText("最初の書き起こしを受信しました").count(), 0);
  });
});

test("recording encounter keeps the newest live transcript turn in view", { timeout: 30_000 }, async () => {
  const fixture = createLongEncounterFixture({ status: "recording" });
  fixture.latestSoap = null;

  await withPage(async (page) => {
    await installGatewayMocks(page, encounterRoutes(fixture));
    await page.goto(appUrl("/sessions/session-e2e"), { waitUntil: "domcontentloaded" });

    const transcriptScroll = page.locator(".transcript-scroll");
    await transcriptScroll.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const element = document.querySelector(".transcript-scroll");
      return element && element.scrollHeight > element.clientHeight;
    });
    await transcriptScroll.evaluate((element) => {
      element.scrollTop = 0;
    });

    await page.waitForFunction(() => window.__mockWebSockets?.length > 0);
    await page.evaluate(() => {
      for (const ws of window.__mockWebSockets) {
        const event = new MessageEvent("message", {
          data: JSON.stringify({
            type: "transcript.final",
            sessionId: "session-e2e",
            turnId: "turn-newest",
            turnIndex: 37,
            speaker: "doctor",
            text: "新しい発話が画面内に表示される確認です。",
            startMs: 432000,
            endMs: 436000,
            confidence: 0.94
          })
        });
        ws.dispatchEvent(event);
        ws.onmessage?.(event);
      }
    });

    await page.getByText("新しい発話が画面内に表示される確認です。").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const element = document.querySelector(".transcript-scroll");
      if (!element) {
        return false;
      }
      return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
    });
  });
});
