function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DEFAULT_PRODUCT_ID = "charting";
const DEFAULT_REMINDER_DAYS_BEFORE_TRIAL_END = 3;
const PAYMENT_REQUIRED_STATUSES = new Set([
  "payment_required",
  "pending_checkout",
  "past_due",
  "grace_period",
  "unpaid"
]);

function findProductEntitlement(productEntitlements, productId = DEFAULT_PRODUCT_ID) {
  if (!productEntitlements) {
    return null;
  }

  if (Array.isArray(productEntitlements)) {
    return productEntitlements.find((entitlement) => entitlement?.productId === productId) || null;
  }

  return productEntitlements[productId] || null;
}

function resolveBillingDisplayState({ billing, productEntitlements, productId, entitlement }) {
  const productEntitlement = entitlement || findProductEntitlement(productEntitlements, productId);
  if (!productEntitlement) {
    return {
      status: billing?.status || "",
      trialEndsAt: billing?.trialEndsAt || null,
      reminderStartsAt: null,
      hasStripeSubscription: Boolean(billing?.stripeSubscriptionId)
    };
  }

  return {
    status: productEntitlement.status || billing?.status || "",
    trialEndsAt: productEntitlement.trialEndsAt || productEntitlement.endsAt || billing?.trialEndsAt || null,
    reminderStartsAt: productEntitlement.reminderStartsAt || null,
    hasStripeSubscription: Boolean(productEntitlement.stripeSubscriptionId || billing?.stripeSubscriptionId)
  };
}

export function getBillingDisplayState({
  billing,
  productEntitlements,
  productId = DEFAULT_PRODUCT_ID,
  entitlement = null
} = {}) {
  return resolveBillingDisplayState({
    billing,
    productEntitlements,
    productId,
    entitlement
  });
}

function getTrialTiming(trialEndsAt, now = new Date()) {
  const end = parseDate(trialEndsAt);
  if (!end) {
    return null;
  }

  const remainingMs = end.getTime() - now.getTime();
  return {
    daysRemaining: remainingMs <= 0 ? 0 : Math.ceil(remainingMs / (24 * 60 * 60 * 1000)),
    isExpired: remainingMs <= 0
  };
}

function hasTrialReminderWindowStarted({ reminderStartsAt, daysRemaining }, now = new Date(), reminderDaysBeforeTrialEnd = DEFAULT_REMINDER_DAYS_BEFORE_TRIAL_END) {
  const reminderStart = parseDate(reminderStartsAt);
  if (reminderStart) {
    return reminderStart.getTime() <= now.getTime();
  }

  return daysRemaining <= reminderDaysBeforeTrialEnd;
}

export function formatBillingStatus(status) {
  switch (status) {
    case "trialing":
      return "無料期間";
    case "active":
      return "利用中";
    case "past_due":
      return "支払い失敗";
    case "grace_period":
      return "猶予期間";
    case "unpaid":
      return "未払い";
    case "canceled":
      return "解約済み";
    case "pending_checkout":
      return "決済待ち";
    case "payment_required":
      return "支払い対応待ち";
    default:
      return status || "未設定";
  }
}

export function formatAccessStatus(status) {
  switch (status) {
    case "pending_setup":
      return "初回設定待ち";
    case "active":
      return "利用可能";
    case "billing_action_required":
      return "支払い対応待ち";
    case "suspended":
      return "停止中";
    case "canceled":
      return "解約済み";
    default:
      return status || "未設定";
  }
}

export function formatBillingDateTime(value) {
  const date = parseDate(value);

  if (!date) {
    return "-";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function getTrialDaysRemaining(trialEndsAt, now = new Date()) {
  const timing = getTrialTiming(trialEndsAt, now);
  if (!timing) {
    return null;
  }

  return timing.daysRemaining;
}

export function shouldStartBillingCheckout(billing) {
  if (!billing) {
    return false;
  }

  if (billing.stripeSubscriptionId) {
    return false;
  }

  return ["trialing", "pending_checkout", "past_due", "grace_period", "unpaid"].includes(billing.status);
}

export function shouldOpenBillingPortal(billing) {
  if (!billing?.stripeCustomerId) {
    return false;
  }

  return !shouldStartBillingCheckout(billing);
}

export function getBillingActionLabel({ billing, access } = {}) {
  if (shouldStartBillingCheckout(billing)) {
    return "決済する";
  }

  if (access?.status === "billing_action_required" || ["past_due", "grace_period", "unpaid"].includes(billing?.status)) {
    return "支払い情報を更新";
  }

  return "契約・支払いを管理";
}

export function buildBillingBannerCopy({
  billing,
  access,
  productEntitlements,
  productId = DEFAULT_PRODUCT_ID,
  entitlement = null,
  onlyShowTrialInReminderWindow = false,
  reminderDaysBeforeTrialEnd = DEFAULT_REMINDER_DAYS_BEFORE_TRIAL_END,
  now = new Date()
} = {}) {
  const billingState = resolveBillingDisplayState({
    billing,
    productEntitlements,
    productId,
    entitlement
  });

  if (!billing && !billingState.status && access?.status !== "billing_action_required") {
    return null;
  }

  const trialTiming = getTrialTiming(billingState.trialEndsAt, now);
  const trialDays = trialTiming?.daysRemaining ?? null;

  if (
    access?.status === "billing_action_required" ||
    PAYMENT_REQUIRED_STATUSES.has(billingState.status) ||
    (billingState.status === "trialing" && trialTiming?.isExpired)
  ) {
    return {
      tone: "warning",
      title: "無料利用期間が終了しました",
      body: billingState.hasStripeSubscription
        ? "支払い情報の更新または請求の確認が必要です。"
        : "決済を完了すると利用を再開できます。"
    };
  }

  if (billingState.status === "trialing") {
    if (trialDays == null) {
      if (onlyShowTrialInReminderWindow) {
        return null;
      }

      return {
        tone: "success",
        title: "無料利用期間中です",
        body: "継続利用には決済が必要です。アカウント画面から手続きを進めてください。"
      };
    }

    if (
      onlyShowTrialInReminderWindow &&
      !hasTrialReminderWindowStarted({
        reminderStartsAt: billingState.reminderStartsAt,
        daysRemaining: trialDays
      }, now, reminderDaysBeforeTrialEnd)
    ) {
      return null;
    }

    return {
      tone: "success",
      title: trialDays > 0 ? `無料利用期間はあと${trialDays}日です` : "無料利用期間は本日までです",
      body: "継続利用には決済が必要です。アカウント画面から手続きを進めてください。"
    };
  }

  return null;
}
