import assert from "node:assert/strict";
import { chromium } from "playwright";

export const gatewayBaseUrl = "http://127.0.0.1:8081";

export const operatorSession = {
  authenticated: true,
  session: {
    orgId: "org_stg",
    organization: {
      orgId: "org_stg",
      organizationCode: "stg",
      displayName: "stg",
      status: "active",
      timezone: "Asia/Tokyo",
      memberCount: 6
    },
    member: {
      memberId: "member-keishi",
      loginId: "keishi",
      displayName: "平出 啓史",
      roles: ["org_admin", "doctor"],
      status: "active",
      defaultRecordingSource: "linked_mobile"
    }
  }
};

export const organizations = [
  {
    orgId: "org_stg",
    organizationCode: "stg",
    displayName: "stg",
    status: "active",
    timezone: "Asia/Tokyo",
    memberCount: 6
  }
];

export const roleDefinitions = [
  { roleId: "org_admin", label: "病院管理者", sortOrder: 30 },
  { roleId: "clinical_admin", label: "診療管理者", sortOrder: 50 },
  { roleId: "doctor", label: "医師", sortOrder: 60 }
];

export const members = [
  {
    memberId: "member-keishi",
    loginId: "keishi",
    displayName: "平出 啓史",
    roles: ["org_admin", "doctor"],
    status: "active",
    defaultPromptProfileId: "system-default",
    defaultRecordingSource: "linked_mobile"
  },
  {
    memberId: "member-goshi",
    loginId: "goshi",
    displayName: "五志 太郎",
    roles: ["org_admin", "doctor"],
    status: "active",
    defaultPromptProfileId: "prompt-short",
    defaultRecordingSource: "local_browser"
  }
];

export const soapFormats = [
  createPromptFormat("prompt-new-1", "新しいプロンプト", "member-keishi"),
  createPromptFormat("prompt-new-2", "新しいプロンプト(2)", "member-goshi"),
  createPromptFormat("prompt-short", "短時間外来SOAP（簡潔）", "member-goshi", {
    status: "active",
    approved: true
  })
];

const soapFormatSummaries = soapFormats.map(({ outputTemplate: _outputTemplate, customization: _customization, sections: _sections, ...format }) => format);

function createPromptFormat(formatId, displayName, ownerMemberId, overrides = {}) {
  return {
    formatId,
    profileId: formatId,
    displayName,
    scope: "member",
    ownerMemberId,
    facilityId: null,
    departmentId: null,
    templateKey: "outpatient_soap_note",
    outputTemplate: "#\nS\n【主訴】\n【現病歴】\n【背景】\n\nO\n\nA\n\nP",
    customization: {
      tone: "簡潔で臨床現場で編集しやすい日本語",
      detailLevel: "standard",
      globalInstruction: "",
      additionalInstructions: [],
      outputPreferences: {
        headingStyle: "soap_letters",
        copyFormat: "emr_plain_text"
      }
    },
    latestVersion: {
      versionId: `${formatId}-v1`,
      validationStatus: "passed"
    },
    status: "draft",
    approved: false,
    ...overrides
  };
}

export function createLongEncounterFixture({ status = "soap_ready" } = {}) {
  const turns = Array.from({ length: 36 }, (_, index) => ({
    turnId: `turn-${index + 1}`,
    turnIndex: index + 1,
    speaker: index % 2 === 0 ? "patient" : "doctor",
    text: `${index % 2 === 0 ? "患者" : "医師"}発話 ${index + 1}: 発熱、咳、睡眠、内服状況について確認する長めの文章です。狭い画面でも折り返しとスクロールが壊れないことを確認します。`,
    startMs: index * 12000,
    endMs: index * 12000 + 8000,
    confidence: 0.94
  }));
  const finalTranscript = turns.map((turn) => turn.text).join("\n");
  const outputText = [
    "【主訴】",
    "発熱と咳。",
    "",
    "【現病歴】",
    ...Array.from({ length: 32 }, (_, index) => `診療記録本文 ${index + 1}: 症状の経過、バイタル、患者説明を確認。長文でも右側の診療記録全文が縦スクロールで確認できること。`),
    "",
    "S",
    "発熱、咳、倦怠感。",
    "",
    "O",
    "呼吸苦なし。水分摂取は可能。",
    "",
    "A",
    "急性上気道炎を疑う。",
    "",
    "P",
    "対症療法、悪化時再診。"
  ].join("\n");

  return {
    session: {
      sessionId: "session-e2e",
      orgId: "org_stg",
      memberId: "member-keishi",
      status,
      mobileConnectionState: "disconnected",
      audioConnectionState: "disconnected",
      audioSourceType: "local_browser",
      patientDisplayName: "山田 花子",
      visitReason: "発熱と咳が続くため相談",
      promptProfileId: "prompt-short",
      updatedAt: "2026-04-19T08:00:00.000Z"
    },
    turns,
    latestSoap: {
      soapId: "soap-e2e",
      sessionId: "session-e2e",
      versionId: "soap-e2e-v1",
      version: 1,
      status: status === "approved" ? "approved" : "ready",
      outputText,
      structuredJson: {
        outputText,
        finalTranscript,
        rawFinalTranscript: finalTranscript
      },
      updatedAt: "2026-04-19T08:10:00.000Z"
    },
    promptProfile: {
      profileId: "prompt-short",
      formatId: "prompt-short",
      displayName: "短時間外来SOAP（簡潔）",
      scope: "member"
    }
  };
}

export async function withPage(callback, options = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream"
    ]
  });
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1280, height: 900 },
    deviceScaleFactor: 1
  });
  await context.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = MockWebSocket.CONNECTING;
        window.__mockWebSockets = window.__mockWebSockets || [];
        window.__mockWebSockets.push(this);
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          this.onopen?.(new Event("open"));
        }, 0);
      }

      send(data) {
        this.lastSent = data;
      }

      close(code = 1000, reason = "") {
        this.readyState = MockWebSocket.CLOSED;
        const event = typeof CloseEvent === "function"
          ? new CloseEvent("close", { code, reason, wasClean: true })
          : new Event("close");
        this.dispatchEvent(event);
        this.onclose?.(event);
      }
    }
    window.WebSocket = MockWebSocket;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__lastClipboardText = String(text);
        }
      }
    });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(options.timeout || 12_000);

  try {
    return await callback(page, context);
  } finally {
    await browser.close();
  }
}

export async function installGatewayMocks(page, routes = []) {
  const calls = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    const path = url.pathname;
    calls.push({ method, path });

    const matched = routes.find((entry) => routeMatches(entry, method, path));
    if (matched) {
      const result = await matched.handler({ request, url, method, path });
      return fulfillJson(route, result?.body ?? result ?? {}, result?.status ?? 200);
    }

    if (method === "GET" && path === "/api/v1/operator/me") {
      return fulfillJson(route, operatorSession);
    }

    if (method === "POST" && path === "/api/v1/operator/logout") {
      return fulfillJson(route, { ok: true });
    }

    return fulfillJson(route, { error: `Unhandled E2E API mock: ${method} ${path}` }, 500);
  });

  return calls;
}

export function adminRoutes() {
  return [
    {
      method: "GET",
      path: "/api/v1/admin/bootstrap",
      handler: ({ url }) => ({
        session: operatorSession.session,
        organizations,
        selectedOrgId: url.searchParams.get("orgId") || operatorSession.session.orgId,
        canManagePlatform: false,
        roles: roleDefinitions,
        section: url.searchParams.get("section") || "all",
        formats: soapFormatSummaries,
        members,
        events: []
      })
    },
    { method: "GET", path: "/api/v1/admin/organizations", handler: () => ({ organizations }) },
    { method: "GET", path: "/api/v1/admin/role-definitions", handler: () => ({ roles: roleDefinitions }) },
    { method: "GET", path: "/api/v1/admin/members", handler: () => ({ members }) },
    { method: "GET", path: "/api/v1/admin/trusted-recorders", handler: () => ({ recorders: [] }) },
    { method: "GET", path: "/api/v1/admin/soap-formats", handler: ({ url }) => ({ formats: url.searchParams.get("summary") ? soapFormatSummaries : soapFormats }) },
    {
      method: "GET",
      path: /^\/api\/v1\/admin\/soap-formats\/[^/]+$/,
      handler: ({ path }) => ({
        format: soapFormats.find((format) => format.formatId === path.split("/").at(-1)) || soapFormats[0]
      })
    },
    { method: "GET", path: "/api/v1/admin/audit-events", handler: () => ({ events: [] }) },
    {
      method: "PATCH",
      path: /^\/api\/v1\/admin\/members\/[^/]+\/roles$/,
      handler: async ({ request, path }) => {
        const memberId = path.split("/").at(-2);
        const body = await request.postDataJSON();
        return {
          member: {
            ...members.find((member) => member.memberId === memberId),
            roles: body.roles,
            mfaRequired: body.roles?.includes("org_admin") || false
          }
        };
      }
    },
    {
      method: "POST",
      path: /^\/api\/v1\/admin\/members\/[^/]+\/password$/,
      handler: ({ path }) => {
        const memberId = path.split("/").at(-2);
        return {
          member: members.find((member) => member.memberId === memberId)
        };
      }
    },
    {
      method: "PATCH",
      path: /^\/api\/v1\/admin\/members\/[^/]+\/status$/,
      handler: async ({ request, path }) => {
        const memberId = path.split("/").at(-2);
        const body = await request.postDataJSON();
        return {
          member: {
            ...members.find((member) => member.memberId === memberId),
            status: body.status
          }
        };
      }
    },
    { method: "POST", path: /^\/api\/v1\/admin\/members\/[^/]+\/revoke-sessions$/, handler: () => ({ ok: true, revoked: { tokenVersion: 2 } }) },
    { method: "POST", path: /^\/api\/v1\/admin\/members\/[^/]+\/mfa-reset$/, handler: ({ path }) => ({ member: members.find((member) => member.memberId === path.split("/").at(-2)) }) },
    {
      method: "POST",
      path: "/api/v1/admin/soap-format-assignments",
      handler: async ({ request }) => {
        const body = await request.postDataJSON();
        return {
          member: {
            ...members.find((member) => member.memberId === body.memberId),
            defaultPromptProfileId: body.formatId || "system-default"
          }
        };
      }
    },
    {
      method: "POST",
      path: "/api/v1/admin/soap-formats",
      handler: async ({ request }) => {
        const body = await request.postDataJSON();
        return {
          format: createPromptFormat("prompt-created", body.displayName, body.ownerMemberId || "member-keishi", {
            ...body,
            latestVersion: { versionId: "prompt-created-v1", validationStatus: "passed" }
          })
        };
      }
    }
  ];
}

export function encounterRoutes(fixture = createLongEncounterFixture()) {
  const promptOptions = {
    options: soapFormats.map((format) => ({
      profileId: format.profileId,
      formatId: format.formatId,
      displayName: format.displayName,
      scope: format.scope,
      status: format.status,
      approved: format.approved
    })),
    selectedPromptProfileId: fixture.promptProfile.profileId,
    promptProfile: fixture.promptProfile
  };
  const core = fixture.core || { patients: [], facilities: [], departments: [] };

  return [
    {
      method: "GET",
      path: "/api/v1/sessions/session-e2e/bootstrap",
      handler: () => ({
        sessionState: fixture,
        core,
        promptOptions
      })
    },
    { method: "GET", path: "/api/v1/core/bootstrap", handler: () => core },
    { method: "GET", path: "/api/v1/sessions/session-e2e", handler: () => fixture },
    {
      method: "GET",
      path: "/api/v1/sessions/session-e2e/prompt-options",
      handler: () => promptOptions
    },
    { method: "POST", path: "/api/v1/sessions/session-e2e/review-note", handler: () => fixture },
    { method: "POST", path: "/api/v1/sessions/session-e2e/approve-note", handler: () => fixture },
    { method: "POST", path: "/api/v1/sessions/session-e2e/prompt-profile", handler: () => fixture },
    { method: "POST", path: "/api/v1/sessions/session-e2e/regenerate-soap", handler: () => fixture }
  ];
}

export function appUrl(path = "/") {
  return `${process.env.WEB_E2E_BASE_URL || "http://127.0.0.1:3100"}${path}`;
}

export async function assertNoPageHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyWidth: document.body.scrollWidth
  }));
  const overflow = Math.max(metrics.documentWidth, metrics.bodyWidth) - metrics.viewportWidth;
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px (${JSON.stringify(metrics)})`);
}

export async function assertElementCanScroll(page, selector, label) {
  const result = await page.locator(selector).first().evaluate((element) => {
    const before = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    const after = element.scrollTop;
    return {
      before,
      after,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight
    };
  });
  assert.ok(result.scrollHeight > result.clientHeight, `${label}: content should overflow vertically`);
  assert.ok(result.after > result.before, `${label}: element did not scroll`);
}

function routeMatches(entry, method, path) {
  if (entry.method && entry.method !== method) {
    return false;
  }

  if (entry.path instanceof RegExp) {
    return entry.path.test(path);
  }

  return entry.path === path;
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}
