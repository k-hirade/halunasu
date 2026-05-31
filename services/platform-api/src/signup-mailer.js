function loadSignupMailerConfig(env = process.env) {
  const appEnv = String(env.HALUNASU_ENV || env.APP_ENV || env.NODE_ENV || "local").toLowerCase();
  const provider = String(env.EMAIL_DELIVERY_PROVIDER || (env.RESEND_API_KEY ? "resend" : "")).toLowerCase();

  return {
    appEnv,
    deliveryRequired: ["stg", "prod", "production"].includes(appEnv),
    provider,
    from: String(env.EMAIL_FROM_ADDRESS || "").trim(),
    replyTo: String(env.EMAIL_REPLY_TO_ADDRESS || "").trim(),
    resendApiKey: env.RESEND_API_KEY || "",
    resendApiBaseUrl: env.RESEND_API_BASE_URL || "https://api.resend.com/emails"
  };
}

export function createSignupMailer(options = {}) {
  const config = {
    ...loadSignupMailerConfig(options.env || process.env),
    ...(options.config || {})
  };
  const fetchImpl = options.fetchImpl || fetch;

  return {
    async sendVerificationMail({ signupApplication, verificationUrl, expiresAt }) {
      const mail = buildVerificationMail({
        signupApplication,
        verificationUrl,
        expiresAt,
        from: config.from,
        replyTo: config.replyTo
      });

      return sendMail({ config, fetchImpl, mail });
    },

    async sendPasswordSetupMail({ signupApplication, organization, adminMember, loginUrl, passwordSetupUrl }) {
      const mail = buildPasswordSetupMail({
        signupApplication,
        organization,
        adminMember,
        loginUrl,
        passwordSetupUrl,
        from: config.from,
        replyTo: config.replyTo
      });

      return sendMail({ config, fetchImpl, mail });
    },

    async sendTrialReminderMail({ organization, entitlement, recipient, billingUrl, daysRemaining }) {
      const mail = buildTrialReminderMail({
        organization,
        entitlement,
        recipient,
        billingUrl,
        daysRemaining,
        from: config.from,
        replyTo: config.replyTo
      });

      return sendMail({ config, fetchImpl, mail });
    }
  };
}

export function buildSignupVerificationUrl(input = {}, token) {
  return buildSignupUrl(input, { token });
}

export function buildPasswordSetupUrl(input = {}, token) {
  return buildSignupUrl(input, { setup: token });
}

export function defaultLpBaseUrl(env) {
  return String(env || "").toLowerCase() === "stg"
    ? "https://stg.halunasu.com"
    : "https://halunasu.com";
}

function buildSignupUrl(input, params) {
  const baseUrl = String(
    input.publicLpBaseUrl
    || process.env.PLATFORM_PUBLIC_LP_BASE_URL
    || process.env.PUBLIC_LP_BASE_URL
    || defaultLpBaseUrl(input.env || process.env.HALUNASU_ENV)
  ).replace(/\/$/u, "");
  const url = new URL("signup", `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

async function sendMail({ config, fetchImpl, mail }) {
  if (!resendEnabled(config)) {
    const result = {
      mode: config.provider || "disabled",
      delivered: false,
      configured: false
    };

    if (config.deliveryRequired) {
      const error = new Error("確認メールの送信設定が未完了です。時間を置いてもう一度お試しください。");
      error.name = "EmailDeliveryError";
      error.statusCode = 502;
      error.code = "email_delivery_not_configured";
      throw error;
    }

    return result;
  }

  const payload = {
    from: mail.from,
    to: [mail.to],
    subject: mail.subject,
    text: mail.text,
    html: mail.html
  };

  if (mail.replyTo) {
    payload.reply_to = mail.replyTo;
  }

  const response = await fetchImpl(config.resendApiBaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();

  if (!response.ok) {
    const error = new Error("確認メールの送信に失敗しました。時間を置いてもう一度お試しください。");
    error.name = "EmailDeliveryError";
    error.statusCode = 502;
    error.code = "email_delivery_failed";
    error.provider = "resend";
    error.responseStatus = response.status;
    error.responseBody = responseText;
    throw error;
  }

  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }

  return {
    mode: "resend",
    delivered: true,
    configured: true,
    providerMessageId: responseJson?.id || null
  };
}

function resendEnabled(config) {
  return config.provider === "resend" && Boolean(config.resendApiKey && config.from);
}

function buildVerificationMail({ signupApplication, verificationUrl, expiresAt, from, replyTo }) {
  const recipientName = signupApplication.applicantName || "ご担当者";
  const subject = "【ハルナス】メールアドレス確認のお願い";
  const text = [
    `${recipientName} 様`,
    "",
    "ハルナスへのお問い合わせありがとうございます。",
    "以下のリンクを開いてメールアドレス確認を完了してください。",
    "",
    verificationUrl,
    "",
    `有効期限: ${expiresAt || "24時間以内"}`,
    "",
    "心当たりがない場合はこのメールを破棄してください。"
  ].join("\n");
  const html = [
    `<p>${escapeHtml(recipientName)} 様</p>`,
    "<p>ハルナスへのお問い合わせありがとうございます。<br />以下のリンクを開いてメールアドレス確認を完了してください。</p>",
    `<p><a href="${escapeHtmlAttr(verificationUrl)}">${escapeHtml(verificationUrl)}</a></p>`,
    `<p>有効期限: ${escapeHtml(expiresAt || "24時間以内")}</p>`,
    "<p>心当たりがない場合はこのメールを破棄してください。</p>"
  ].join("");

  return {
    from,
    replyTo,
    to: signupApplication.applicantEmail,
    subject,
    text,
    html,
    verificationUrl
  };
}

function buildPasswordSetupMail({ signupApplication, organization, adminMember, loginUrl, passwordSetupUrl, from, replyTo }) {
  const recipientName = signupApplication.applicantName || adminMember?.displayName || "ご担当者";
  const subject = "【ハルナス】初回ログイン設定のご案内";
  const organizationCode = organization?.organizationCode || signupApplication.organizationCode || "";
  const loginId = adminMember?.loginId || signupApplication.applicantEmail || "";
  const text = [
    `${recipientName} 様`,
    "",
    "ハルナスの利用準備が完了しました。",
    "以下の情報で初回設定を進めてください。",
    "",
    `医療機関コード: ${organizationCode}`,
    `ログインID: ${loginId}`,
    `ログインURL: ${loginUrl}`,
    `初回パスワード設定: ${passwordSetupUrl}`,
    "",
    "初回設定後は、ログインURLからご利用ください。"
  ].join("\n");
  const html = [
    `<p>${escapeHtml(recipientName)} 様</p>`,
    "<p>ハルナスの利用準備が完了しました。<br />以下の情報で初回設定を進めてください。</p>",
    "<ul>",
    `<li>医療機関コード: ${escapeHtml(organizationCode)}</li>`,
    `<li>ログインID: ${escapeHtml(loginId)}</li>`,
    "</ul>",
    `<p>ログインURL: <a href="${escapeHtmlAttr(loginUrl)}">${escapeHtml(loginUrl)}</a></p>`,
    `<p>初回パスワード設定: <a href="${escapeHtmlAttr(passwordSetupUrl)}">${escapeHtml(passwordSetupUrl)}</a></p>`,
    "<p>初回設定後は、ログインURLからご利用ください。</p>"
  ].join("");

  return {
    from,
    replyTo,
    to: signupApplication.applicantEmail,
    subject,
    text,
    html,
    passwordSetupUrl
  };
}

function buildTrialReminderMail({ organization, entitlement, recipient, billingUrl, daysRemaining, from, replyTo }) {
  const recipientName = recipient.displayName || recipient.loginId || "ご担当者";
  const productLabel = productDisplayName(entitlement.productId);
  const remainingLabel = daysRemaining <= 0 ? "本日" : `あと${daysRemaining}日`;
  const subject = `【ハルナス】無料利用期間終了前のご案内（${productLabel}）`;
  const organizationCode = organization?.organizationCode || "";
  const text = [
    `${recipientName} 様`,
    "",
    `ハルナス ${productLabel} の無料利用期間は${remainingLabel}で終了します。`,
    "継続して利用する場合は、以下の画面からお支払い手続きを完了してください。",
    "",
    `医療機関コード: ${organizationCode}`,
    `契約・支払い画面: ${billingUrl}`,
    "",
    "すでにお支払い済みの場合、このご案内は停止されます。"
  ].join("\n");
  const html = [
    `<p>${escapeHtml(recipientName)} 様</p>`,
    `<p>ハルナス ${escapeHtml(productLabel)} の無料利用期間は${escapeHtml(remainingLabel)}で終了します。</p>`,
    "<p>継続して利用する場合は、以下の画面からお支払い手続きを完了してください。</p>",
    "<ul>",
    `<li>医療機関コード: ${escapeHtml(organizationCode)}</li>`,
    "</ul>",
    `<p>契約・支払い画面: <a href="${escapeHtmlAttr(billingUrl)}">${escapeHtml(billingUrl)}</a></p>`,
    "<p>すでにお支払い済みの場合、このご案内は停止されます。</p>"
  ].join("");

  return {
    from,
    replyTo,
    to: recipient.email || recipient.loginId,
    subject,
    text,
    html,
    billingUrl
  };
}

function productDisplayName(productId) {
  switch (productId) {
    case "charting":
      return "カルテ作成";
    case "fee":
      return "診療報酬算定";
    case "referral":
      return "紹介状作成";
    default:
      return "アプリ";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value);
}
