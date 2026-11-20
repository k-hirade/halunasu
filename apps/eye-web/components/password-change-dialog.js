"use client";

import { useEffect, useRef, useState } from "react";
import { PasswordToggleIcon } from "@halunasu/web-ui/login-views";
import { toUserFacingErrorMessage } from "@halunasu/web-ui/user-facing-error";
import { PASSWORD_MIN_LENGTH, passwordChangeErrorField, validatePasswordChange } from "../lib/password-change";
import { Modal } from "./modal";
import { usePlatformAuth } from "./platform-auth";

const FIELDS = [
  { name: "currentPassword", label: "現在のパスワード", autoComplete: "current-password" },
  { name: "newPassword", label: "新しいパスワード", autoComplete: "new-password", hint: true },
  { name: "confirmPassword", label: "新しいパスワード（確認）", autoComplete: "new-password" }
];

// 本人のパスワード変更（ヘッダーの利用者メニューから開く）。
// 変えたあともこの端末はログインしたまま（サーバーがセッションを発行し直す）。ほかの端末はログインし直しになる。
export function PasswordChangeDialog({ onClose }) {
  const { changePassword } = usePlatformAuth();
  const [values, setValues] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [visible, setVisible] = useState({});
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const inputRefs = useRef({});
  const doneRef = useRef(null);

  // 開いたら最初の欄へ・閉じたら元の場所へ・Esc と背景で閉じる（送信中は閉じない）は Modal が受け持つ
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  function update(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
    if (error?.field === name) setError(null);
  }

  function watchCapsLock(event) {
    if (typeof event.getModifierState === "function") setCapsLock(event.getModifierState("CapsLock"));
  }

  function fail(next) {
    setError({ ...next, at: Date.now() });
  }

  // 問題のある欄へカーソルを移す（送信中は欄が無効なので、終わってから）
  useEffect(() => {
    if (error?.field && !busy) inputRefs.current[error.field]?.focus();
  }, [busy, error]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const problem = validatePasswordChange(values);
    if (problem) {
      fail(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      setValues({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setDone(true);
    } catch (caught) {
      fail({ field: passwordChangeErrorField(caught), message: toUserFacingErrorMessage(caught, "パスワードを変更できませんでした。時間を置いてもう一度お試しください。") });
    } finally {
      setBusy(false);
    }
  }

  // 日本語入力の変換確定の Enter では送らない
  function onFormKeyDown(event) {
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
  }

  return (
    <Modal busy={busy} className="dialog pw-dialog" dirty={!done && Object.values(values).some(Boolean)} initialFocus="input" labelledBy="pw-heading" onClose={onClose}>
      <h2 id="pw-heading">パスワード変更</h2>
      {done ? (
        <>
          <p className="alert alert-ok pw-done" role="status">
            パスワードを変更しました。この端末はログインしたままです。ほかの端末やブラウザでは、新しいパスワードでログインし直してください。
          </p>
          <div className="dialog-actions">
            <button className="btn btn-primary" onClick={onClose} ref={doneRef} type="button">閉じる</button>
          </div>
        </>
      ) : (
        <form noValidate onKeyDown={onFormKeyDown} onSubmit={submit}>
          {FIELDS.map((field) => {
            const id = `pw-${field.name}`;
            const shown = Boolean(visible[field.name]);
            const describedBy = [field.hint ? "pw-policy" : "", capsLock ? "pw-caps" : "", error?.field === field.name ? "pw-error" : ""].filter(Boolean).join(" ");
            return (
              <div className="field pw-field" key={field.name}>
                <label className="pw-label" htmlFor={id}>{field.label}</label>
                <div className="pw-input">
                  <input
                    aria-describedby={describedBy || undefined}
                    aria-invalid={error?.field === field.name ? "true" : undefined}
                    autoCapitalize="off"
                    autoComplete={field.autoComplete}
                    className="input"
                    disabled={busy}
                    id={id}
                    name={field.name}
                    onBlur={() => setCapsLock(false)}
                    onChange={(event) => update(field.name, event.target.value)}
                    onKeyDown={watchCapsLock}
                    onKeyUp={watchCapsLock}
                    ref={(node) => { inputRefs.current[field.name] = node; }}
                    spellCheck={false}
                    type={shown ? "text" : "password"}
                    value={values[field.name]}
                  />
                  <button
                    aria-label={shown ? `${field.label}を隠す` : `${field.label}を表示`}
                    aria-pressed={shown}
                    className="pw-toggle"
                    disabled={busy}
                    onClick={() => setVisible((current) => ({ ...current, [field.name]: !current[field.name] }))}
                    type="button"
                  >
                    <PasswordToggleIcon visible={shown} />
                  </button>
                </div>
                {field.hint ? <small className="muted pw-hint" id="pw-policy">{PASSWORD_MIN_LENGTH}文字以上。英字・数字・記号を組み合わせると安全です。現在と同じものは使えません。</small> : null}
              </div>
            );
          })}
          {capsLock ? <p className="pw-caps" id="pw-caps">Caps Lock がオンです</p> : null}
          {error ? <p className="alert alert-danger pw-error" id="pw-error" role="alert">{error.message}</p> : null}
          <p className="muted small pw-note">変更すると、ほかの端末やブラウザでのログインは終了します。この端末はログインしたままです。</p>
          <div className="dialog-actions">
            <button className="btn" disabled={busy} onClick={onClose} type="button">キャンセル</button>
            <button className="btn btn-primary" disabled={busy} type="submit">{busy ? "変更中…" : "変更する"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
