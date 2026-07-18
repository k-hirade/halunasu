// 共通: API/ネットワークエラーを利用者向け日本語メッセージへ正規化する。
// 4アプリ(fee/charting/referral/core-admin)で重複していた実装を一本化した正(canonical)。
// 純粋関数のため、クライアント/サーバーどちらからも import 可能。

const DEFAULT_ERROR_MESSAGE = "処理に失敗しました。時間を置いてもう一度お試しください。";

export function toUserFacingErrorMessage(error, fallbackMessage = DEFAULT_ERROR_MESSAGE) {
  const rawMessage = typeof error === "string" ? error : error?.message;
  const code = typeof error === "object" && error ? String(error.code || error.error || "") : "";
  const status = typeof error === "object" && error ? Number(error.status || error.statusCode || 0) : 0;
  const text = String(rawMessage || "").trim();
  const lower = text.toLowerCase();
  const normalizedCode = code.toLowerCase();

  if (normalizedCode === "mfa_enrollment_required" || lower.includes("mfa enrollment is required")) {
    return "2段階認証の登録を完了してください。";
  }
  if (normalizedCode === "mfa_required" || lower.includes("mfa code is required")) {
    return "2段階認証コードを入力してください。";
  }
  if (lower.includes("invalid mfa")) {
    return "2段階認証コードが正しくありません。";
  }
  if (lower.includes("invalid credentials")) {
    return "病院コード、個人ID、またはログイン用パスワードが正しくありません。";
  }
  if (lower.includes("csrf")) {
    return "画面を再読み込みして、もう一度お試しください。";
  }
  if (lower.includes("invalid session") || lower.includes("session expired") || lower.includes("session revoked") || lower === "unauthorized") {
    return "ログイン状態を確認できません。もう一度ログインしてください。";
  }
  if (
    lower.includes("role is required")
    || lower.includes("access is required")
    || lower.includes("product access is required")
    || lower === "forbidden"
    || status === 403
  ) {
    return "この操作を行う権限がありません。";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower === "load failed") {
    return "通信に失敗しました。接続を確認して、もう一度お試しください。";
  }
  if (lower.includes("customer portal")) {
    return "決済管理画面を開けませんでした。時間を置いてもう一度お試しください。";
  }
  if (lower.includes("not found") || status === 404) {
    return "対象のデータが見つかりませんでした。画面を再読み込みしてからもう一度お試しください。";
  }
  if (lower.includes("rate limit") || status === 429) {
    return "短時間に操作が続いています。少し待ってからもう一度お試しください。";
  }
  if (lower.includes("internal server error") || /^http 5\d\d$/iu.test(text) || status >= 500) {
    return "処理中に問題が発生しました。時間を置いてもう一度お試しください。";
  }
  if (/^http \d{3}$/iu.test(text)) {
    return fallbackMessage;
  }
  if (!text) {
    return fallbackMessage;
  }

  return looksUserFacingJapanese(text) ? text : fallbackMessage;
}

function looksUserFacingJapanese(text) {
  return /[ぁ-んァ-ヶ一-龠]/u.test(text);
}
