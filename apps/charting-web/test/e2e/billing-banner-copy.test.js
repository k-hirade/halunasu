import assert from "node:assert/strict";
import test from "node:test";
import { buildBillingBannerCopy } from "../../lib/billing-display.js";

const now = new Date("2026-06-01T00:00:00.000Z");

test("session billing banner stays hidden before the trial reminder window", () => {
  const banner = buildBillingBannerCopy({
    billing: { status: "trialing" },
    productEntitlements: {
      charting: {
        productId: "charting",
        status: "trialing",
        trialEndsAt: "2026-06-08T00:00:00.000Z",
        reminderStartsAt: "2026-06-05T00:00:00.000Z"
      }
    },
    onlyShowTrialInReminderWindow: true,
    now
  });

  assert.equal(banner, null);
});

test("session billing banner shows a green trial reminder from three days before expiry", () => {
  const banner = buildBillingBannerCopy({
    billing: { status: "trialing" },
    productEntitlements: {
      charting: {
        productId: "charting",
        status: "trialing",
        trialEndsAt: "2026-06-04T00:00:00.000Z",
        reminderStartsAt: "2026-06-01T00:00:00.000Z"
      }
    },
    onlyShowTrialInReminderWindow: true,
    now
  });

  assert.deepEqual(banner, {
    tone: "success",
    title: "無料利用期間はあと3日です",
    body: "継続利用には決済が必要です。アカウント画面から手続きを進めてください。"
  });
});

test("session billing banner turns yellow after the charting trial expires", () => {
  const banner = buildBillingBannerCopy({
    billing: { status: "trialing" },
    productEntitlements: {
      charting: {
        productId: "charting",
        status: "payment_required",
        trialEndsAt: "2026-05-31T00:00:00.000Z"
      }
    },
    onlyShowTrialInReminderWindow: true,
    now
  });

  assert.deepEqual(banner, {
    tone: "warning",
    title: "無料利用期間が終了しました",
    body: "決済を完了すると利用を再開できます。"
  });
});

test("session billing banner turns yellow when the trial end time has already passed", () => {
  const banner = buildBillingBannerCopy({
    billing: { status: "trialing" },
    productEntitlements: {
      charting: {
        productId: "charting",
        status: "trialing",
        trialEndsAt: "2026-05-31T23:59:59.000Z"
      }
    },
    onlyShowTrialInReminderWindow: true,
    now
  });

  assert.equal(banner?.tone, "warning");
  assert.equal(banner?.title, "無料利用期間が終了しました");
});
