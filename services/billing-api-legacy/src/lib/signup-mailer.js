import { jsonError } from "./http.js";

function previewEnabled(config) {
  return !config?.isProduction;
}

function resendEnabled(config) {
  return config?.emailDeliveryProvider === "resend" && !!config?.resendApiKey && !!config?.emailFromAddress;
}

function buildVerificationMail({ signup, verificationUrl, expiresAt, from, replyTo }) {
  const subject = `【ハルナス】メールアドレス確認のお願い`;
  const text = [
    `${signup.adminName || signup.adminDisplayName || "ご担当者"} 様`,
    ``,
    `ハルナスの無料トライアルにお申し込みいただきありがとうございます。`,
    `以下のリンクを開いてメールアドレス確認を完了してください。`,
    ``,
    verificationUrl,
    ``,
    `有効期限: ${expiresAt || "24時間以内"}`,
    ``,
    `心当たりがない場合はこのメールを破棄してください。`
  ].join("\n");
  const html = [
    `<p>${escapeHtml(signup.adminName || signup.adminDisplayName || "ご担当者")} 様</p>`,
    `<p>ハルナスの無料トライアルにお申し込みいただきありがとうございます。<br />以下のリンクを開いてメールアドレス確認を完了してください。</p>`,
    `<p><a href="${escapeHtmlAttr(verificationUrl)}">${escapeHtml(verificationUrl)}</a></p>`,
    `<p>有効期限: ${escapeHtml(expiresAt || "24時間以内")}</p>`,
    `<p>心当たりがない場合はこのメールを破棄してください。</p>`
  ].join("");

  return {
    from,
    replyTo,
    to: signup.adminEmail,
    subject,
    text,
    html
  };
}

function buildPasswordSetupMail({ signup, loginUrl, passwordSetupUrl, manualUrl, from, replyTo }) {
  const subject = `【ハルナス】初回ログイン設定のご案内`;
  const textLines = [
    `${signup.adminName || signup.adminDisplayName || "ご担当者"} 様`,
    ``,
    `ハルナスの利用準備が完了しました。`,
    `以下の情報で初回設定を進めてください。`,
    ``,
    `病院コード: ${signup.organizationCode}`,
    `個人ID: ${signup.adminLoginId}`,
    `ログインURL: ${loginUrl}`,
    `ログイン用パスワード設定: ${passwordSetupUrl}`,
    ``
  ];

  if (manualUrl) {
    textLines.push(`利用マニュアル: ${manualUrl}`, ``);
  }

  textLines.push(`初回設定後は、ログインURLからご利用ください。`);

  const text = textLines.join("\n");
  const htmlParts = [
    `<p>${escapeHtml(signup.adminName || signup.adminDisplayName || "ご担当者")} 様</p>`,
    `<p>ハルナスの利用準備が完了しました。<br />以下の情報で初回設定を進めてください。</p>`,
    `<ul>`,
    `<li>病院コード: ${escapeHtml(signup.organizationCode || "")}</li>`,
    `<li>個人ID: ${escapeHtml(signup.adminLoginId || "")}</li>`,
    `</ul>`,
    `<p>ログインURL: <a href="${escapeHtmlAttr(loginUrl)}">${escapeHtml(loginUrl)}</a></p>`,
    `<p>ログイン用パスワード設定: <a href="${escapeHtmlAttr(passwordSetupUrl)}">${escapeHtml(passwordSetupUrl)}</a></p>`
  ];

  if (manualUrl) {
    htmlParts.push(`<p>利用マニュアル: <a href="${escapeHtmlAttr(manualUrl)}">${escapeHtml(manualUrl)}</a></p>`);
  }

  htmlParts.push(`<p>初回設定後は、ログインURLからご利用ください。</p>`);

  const html = htmlParts.join("");

  return {
    from,
    replyTo,
    to: signup.adminEmail,
    subject,
    text,
    html
  };
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

async function sendViaResend(config, mail) {
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

  const response = await fetch(config.resendApiBaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  if (!response.ok) {
    const error = jsonError("確認メールの送信に失敗しました。時間を置いてもう一度お試しください。", 502);
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
    providerMessageId: responseJson?.id || null
  };
}

export function createSignupMailer({ config }) {
  const from = config?.emailFromAddress || "";
  const replyTo = config?.emailReplyToAddress || "";
  const manualUrl = config?.publicManualUrl || "";

  return {
    async sendVerificationMail({ signup, verificationUrl, expiresAt }) {
      if (resendEnabled(config)) {
        return sendViaResend(
          config,
          buildVerificationMail({ signup, verificationUrl, expiresAt, from, replyTo })
        );
      }

      if (previewEnabled(config)) {
        console.log("[billing] contact signup verification mail preview", {
          signupId: signup.signupId,
          email: signup.adminEmail,
          verificationUrl,
          expiresAt
        });
      } else {
        console.warn("[billing] verification mail delivery is not configured", {
          signupId: signup.signupId,
          email: signup.adminEmail,
          provider: config?.emailDeliveryProvider || null
        });
      }

      return {
        mode: previewEnabled(config) ? "console_preview" : "disabled",
        delivered: false
      };
    },

    async sendPasswordSetupMail({ signup, loginUrl, passwordSetupUrl }) {
      if (resendEnabled(config)) {
        return sendViaResend(
          config,
          buildPasswordSetupMail({ signup, loginUrl, passwordSetupUrl, manualUrl, from, replyTo })
        );
      }

      if (previewEnabled(config)) {
        console.log("[billing] password setup mail preview", {
          signupId: signup.signupId,
          email: signup.adminEmail,
          organizationCode: signup.organizationCode,
          adminLoginId: signup.adminLoginId,
          loginUrl,
          passwordSetupUrl,
          manualUrl: manualUrl || null
        });
      } else {
        console.warn("[billing] password setup mail delivery is not configured", {
          signupId: signup.signupId,
          email: signup.adminEmail,
          organizationCode: signup.organizationCode,
          adminLoginId: signup.adminLoginId,
          provider: config?.emailDeliveryProvider || null
        });
      }

      return {
        mode: previewEnabled(config) ? "console_preview" : "disabled",
        delivered: false
      };
    }
  };
}
