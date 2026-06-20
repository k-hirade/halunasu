import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// 共通UIの再ドリフト(再コピー)を防ぐガード(ステップ6)。
// 共有化済みの実装をアプリ側で再定義していないことを検査する。
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

const PLATFORM_AUTH_APPS = ["fee-web", "referral-web", "core-admin"];
const PROXY_APPS = ["fee-web", "charting-web", "referral-web", "core-admin"];

test("platform-auth is re-exported from @halunasu/web-ui (not re-defined per app)", () => {
  for (const app of PLATFORM_AUTH_APPS) {
    const source = read(`apps/${app}/components/platform-auth.js`);
    assert.match(
      source,
      /@halunasu\/web-ui\/platform-auth/,
      `${app}: platform-auth must re-export from @halunasu/web-ui/platform-auth`
    );
    assert.doesNotMatch(
      source,
      /function PlatformAuthProvider/,
      `${app}: platform-auth must not re-define PlatformAuthProvider (use the shared one)`
    );
  }
});

test("proxy-utils is sourced from @halunasu/web-ui (not re-defined per app)", () => {
  for (const app of PROXY_APPS) {
    const source = read(`apps/${app}/app/api/proxy-utils.js`);
    assert.match(
      source,
      /@halunasu\/web-ui\/proxy-utils/,
      `${app}: proxy-utils must import from @halunasu/web-ui/proxy-utils`
    );
    assert.doesNotMatch(
      source,
      /const hopByHopHeaders/,
      `${app}: proxy-utils must not re-define the canonical implementation`
    );
  }
});

test("no app re-defines toUserFacingErrorMessage (must import the shared helper)", () => {
  const files = [
    "apps/fee-web/components/platform-auth.js",
    "apps/fee-web/components/fee-workspace.js",
    "apps/fee-web/components/fee-admin-console.js",
    "apps/core-admin/components/platform-auth.js",
    "apps/core-admin/components/core-admin-console.js",
    "apps/referral-web/components/platform-auth.js",
    "apps/charting-web/lib/user-facing-error.js"
  ];
  for (const rel of files) {
    if (!existsSync(join(repoRoot, rel))) {
      continue;
    }
    assert.doesNotMatch(
      read(rel),
      /function toUserFacingErrorMessage/,
      `${rel}: must import toUserFacingErrorMessage from @halunasu/web-ui, not re-define it`
    );
  }
});
