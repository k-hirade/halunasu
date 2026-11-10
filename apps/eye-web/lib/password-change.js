// 本人のパスワード変更の入力確認（画面側）。最終的な判定は platform-api が行う。
// 方針は platform-api と同じ（12文字以上。初回設定・利用者作成と共通）。

export const PASSWORD_MIN_LENGTH = 12;

// 問題のある欄と文言を返す。問題がなければ null
export function validatePasswordChange({ currentPassword = "", newPassword = "", confirmPassword = "" } = {}) {
  if (!currentPassword) return { field: "currentPassword", message: "現在のパスワードを入力してください。" };
  if (!newPassword.trim()) return { field: "newPassword", message: "新しいパスワードを入力してください。" };
  if (newPassword.length < PASSWORD_MIN_LENGTH) return { field: "newPassword", message: `新しいパスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください。` };
  if (newPassword === currentPassword) return { field: "newPassword", message: "新しいパスワードには、現在と違うものを入力してください。" };
  if (confirmPassword !== newPassword) return { field: "confirmPassword", message: "確認のパスワードが一致しません。" };
  return null;
}

// サーバーの返した失敗を、カーソルを置く欄に対応させる
export function passwordChangeErrorField(error) {
  if (error?.code === "invalid_current_password") return "currentPassword";
  if (error?.code === "password_unchanged") return "newPassword";
  return ["newPassword", "currentPassword"].includes(error?.field) ? error.field : "";
}
