import { maskEmailAddress } from "./contact-signup.js";
import { jsonError } from "./http.js";

function resolveEnvLabel(config) {
  if (config?.slackSignupEnvLabel) {
    return String(config.slackSignupEnvLabel).trim().toUpperCase();
  }

  if (config?.appEnv === "production") {
    return "PROD";
  }

  if (config?.appEnv === "stg") {
    return "STG";
  }

  return String(config?.appEnv || "UNKNOWN").trim().toUpperCase();
}

function buildProvisionedMessage({ signup, organization, config }) {
  const envLabel = resolveEnvLabel(config);
  const trialEndsAt = organization?.billing?.trialEndsAt || signup?.expiresAt || "-";
  const seatQuantity = signup?.seatEstimate || organization?.billing?.seatQuantity || 1;

  return [
    `[${envLabel}] 新しい病院アカウントを作成しました`,
    `・医療機関名: ${signup.organizationName || organization?.displayName || "-"}`,
    `・病院コード: ${organization?.organizationCode || signup.organizationCode || "-"}`,
    `・個人ID: ${signup.adminLoginId || "admin"}`,
    `・メールアドレス: ${maskEmailAddress(signup.adminEmail) || "-"}`,
    `・想定利用人数: ${seatQuantity}`,
    `・trial終了日: ${trialEndsAt}`,
    `・signupId: ${signup.signupId}`
  ].join("\n");
}

async function postWebhook(config, payload) {
  const response = await fetch(config.slackSignupWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });

  const responseText = await response.text();

  if (!response.ok || String(responseText || "").trim().toLowerCase() !== "ok") {
    const error = jsonError("Slack 通知の送信に失敗しました。", 502);
    error.code = "slack_signup_notification_failed";
    error.responseStatus = response.status;
    error.responseBody = responseText;
    throw error;
  }
}

export function createSlackSignupNotifier({ config }) {
  return {
    isEnabled() {
      return Boolean(config?.slackSignupWebhookUrl);
    },

    async sendProvisionedSignup({ signup, organization, member }) {
      if (!this.isEnabled()) {
        return {
          delivered: false,
          mode: "disabled"
        };
      }

      await postWebhook(config, {
        text: buildProvisionedMessage({
          signup,
          organization,
          member,
          config
        })
      });

      return {
        delivered: true,
        mode: "webhook"
      };
    }
  };
}
