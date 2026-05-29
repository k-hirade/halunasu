function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
  const end = parseDate(trialEndsAt);
  if (!end) {
    return null;
  }

  const remainingMs = end.getTime() - now.getTime();

  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
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

export function buildBillingBannerCopy({ billing, access } = {}) {
  if (!billing) {
    return null;
  }

  const trialDays = getTrialDaysRemaining(billing.trialEndsAt);

  if (billing.status === "trialing") {
    if (trialDays == null) {
      return {
        tone: "success",
        title: "無料利用期間中です",
        body: "継続利用には決済が必要です。アカウント画面から手続きを進めてください。"
      };
    }

    return {
      tone: "success",
      title: trialDays > 0 ? `無料利用期間はあと${trialDays}日です` : "無料利用期間は本日までです",
      body: "継続利用には決済が必要です。アカウント画面から手続きを進めてください。"
    };
  }

  if (access?.status === "billing_action_required") {
    return {
      tone: "warning",
      title: "継続利用のための支払い対応が必要です",
      body: shouldStartBillingCheckout(billing)
        ? "無料利用期間が終了しました。決済を完了すると利用を継続できます。"
        : "支払い情報の更新または請求の確認が必要です。"
    };
  }

  return null;
}
