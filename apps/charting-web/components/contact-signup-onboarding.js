"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { createContactSignup } from "../lib/billing-api";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";

const CONTACT_SIGNUP_DRAFT_STORAGE_KEY = "medical.contactSignupDraft.v1";
const EMPTY_FORM = {
  organizationName: "",
  adminName: "",
  adminEmail: "",
  seatEstimate: "",
  notes: "",
  consentAccepted: false
};

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function validateContactSignupForm(form) {
  const errors = {};

  if (!String(form.organizationName || "").trim()) {
    errors.organizationName = "医療機関名を入力してください。";
  } else if (String(form.organizationName).trim().length > 120) {
    errors.organizationName = "医療機関名は120文字以内で入力してください。";
  }

  if (!String(form.adminName || "").trim()) {
    errors.adminName = "担当者名を入力してください。";
  } else if (String(form.adminName).trim().length > 120) {
    errors.adminName = "担当者名は120文字以内で入力してください。";
  }

  if (!String(form.adminEmail || "").trim()) {
    errors.adminEmail = "メールアドレスを入力してください。";
  } else if (!validateEmail(form.adminEmail)) {
    errors.adminEmail = "メールアドレスの形式を確認してください。";
  }

  if (String(form.seatEstimate || "").trim()) {
    const numeric = Number(form.seatEstimate);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      errors.seatEstimate = "想定利用人数は1以上で入力してください。";
    } else if (numeric > 10000) {
      errors.seatEstimate = "想定利用人数が大きすぎます。";
    }
  }

  if (String(form.notes || "").length > 2000) {
    errors.notes = "備考は2000文字以内で入力してください。";
  }

  if (!form.consentAccepted) {
    errors.consentAccepted = "利用規約とプライバシーポリシーへの同意が必要です。";
  }

  return errors;
}

function buildValidationSummary(errors) {
  return Array.from(new Set([
    errors.organizationName,
    errors.adminName,
    errors.adminEmail,
    errors.seatEstimate,
    errors.notes,
    errors.consentAccepted
  ].filter(Boolean)));
}

export function ContactSignupOnboarding() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [touchedFields, setTouchedFields] = useState({});
  const [showValidationSummary, setShowValidationSummary] = useState(false);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(CONTACT_SIGNUP_DRAFT_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") {
        return;
      }
      setForm((current) => ({
        ...current,
        ...saved
      }));
    } catch {
      // ignore local draft read failure
    }
  }, []);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(CONTACT_SIGNUP_DRAFT_STORAGE_KEY, JSON.stringify(form));
    } catch {
      // ignore local draft write failure
    }
  }, [form]);

  function updateFieldError(nextForm, fieldName, nextTouchedFields = touchedFields) {
    const nextErrors = validateContactSignupForm(nextForm);
    setFieldErrors((current) => ({
      ...current,
      [fieldName]: nextTouchedFields[fieldName] || showValidationSummary ? nextErrors[fieldName] || "" : current[fieldName] || ""
    }));
    return nextErrors;
  }

  function handleBlur(fieldName) {
    setTouchedFields((current) => {
      const nextTouchedFields = { ...current, [fieldName]: true };
      const nextErrors = validateContactSignupForm(form);
      setFieldErrors((existing) => ({
        ...existing,
        [fieldName]: nextErrors[fieldName] || ""
      }));
      return nextTouchedFields;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    const validationErrors = validateContactSignupForm(form);
    const validationSummary = buildValidationSummary(validationErrors);

    if (validationSummary.length > 0) {
      setFieldErrors(validationErrors);
      setTouchedFields({
        organizationName: true,
        adminName: true,
        adminEmail: true,
        seatEstimate: true,
        notes: true,
        consentAccepted: true
      });
      setShowValidationSummary(true);
      return;
    }

    setShowValidationSummary(false);
    setIsSubmitting(true);

    try {
      const payload = await createContactSignup({
        organizationName: form.organizationName,
        adminName: form.adminName,
        adminEmail: form.adminEmail,
        seatEstimate: form.seatEstimate ? Number(form.seatEstimate) : undefined,
        notes: form.notes || undefined,
        consentAccepted: true
      });
      const query = new URLSearchParams({
        signup_id: payload.signup.signupId
      });

      if (payload.verificationPreviewUrl) {
        query.set("preview_url", payload.verificationPreviewUrl);
      }

      router.push(`/contact-signup/submitted?${query.toString()}`);
    } catch (submitError) {
      setError(toUserFacingErrorMessage(submitError, "無料トライアル申し込みの送信に失敗しました。"));
      setIsSubmitting(false);
    }
  }

  const validationSummary = showValidationSummary ? buildValidationSummary(fieldErrors) : [];

  return (
    <main className="signup-shell signup-shell--compact">
      <section className="signup-panel signup-panel--single">
        <div className="signup-heading">
          <h1>無料トライアル申し込み</h1>
          <p className="signup-lead">
            医療機関情報と担当者連絡先を入力してください。確認メールから初回設定へ進み、利用を開始できます。
          </p>
        </div>
        {validationSummary.length > 0 ? (
          <div className="signup-validation-summary" role="alert" aria-live="polite">
            <strong>入力内容を確認してください。</strong>
            <ul>
              {validationSummary.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <form className="signup-form" onSubmit={handleSubmit} noValidate>
          <label>
            <span>医療機関名</span>
            <input
              aria-invalid={fieldErrors.organizationName ? "true" : "false"}
              value={form.organizationName}
              onChange={(event) => {
                const nextForm = { ...form, organizationName: event.target.value };
                setForm((current) => ({ ...current, organizationName: event.target.value }));
                updateFieldError(nextForm, "organizationName");
              }}
              onBlur={() => handleBlur("organizationName")}
              placeholder="例: さくら内科クリニック"
            />
            {fieldErrors.organizationName ? <small className="field-error">{fieldErrors.organizationName}</small> : null}
          </label>
          <label>
            <span>担当者名</span>
            <input
              aria-invalid={fieldErrors.adminName ? "true" : "false"}
              value={form.adminName}
              onChange={(event) => {
                const nextForm = { ...form, adminName: event.target.value };
                setForm((current) => ({ ...current, adminName: event.target.value }));
                updateFieldError(nextForm, "adminName");
              }}
              onBlur={() => handleBlur("adminName")}
              placeholder="例: 山田 太郎"
            />
            {fieldErrors.adminName ? <small className="field-error">{fieldErrors.adminName}</small> : null}
          </label>
          <label>
            <span>メールアドレス</span>
            <input
              aria-invalid={fieldErrors.adminEmail ? "true" : "false"}
              type="email"
              value={form.adminEmail}
              onChange={(event) => {
                const nextForm = { ...form, adminEmail: event.target.value };
                setForm((current) => ({ ...current, adminEmail: event.target.value }));
                updateFieldError(nextForm, "adminEmail");
              }}
              onBlur={() => handleBlur("adminEmail")}
              placeholder="admin@example.com"
            />
            {fieldErrors.adminEmail ? <small className="field-error">{fieldErrors.adminEmail}</small> : null}
          </label>
          <label>
            <span>想定利用人数</span>
            <input
              aria-invalid={fieldErrors.seatEstimate ? "true" : "false"}
              inputMode="numeric"
              value={form.seatEstimate}
              onChange={(event) => {
                const nextValue = event.target.value.replace(/[^0-9]/g, "");
                const nextForm = { ...form, seatEstimate: nextValue };
                setForm((current) => ({ ...current, seatEstimate: nextValue }));
                updateFieldError(nextForm, "seatEstimate");
              }}
              onBlur={() => handleBlur("seatEstimate")}
              placeholder="5"
            />
            {fieldErrors.seatEstimate ? <small className="field-error">{fieldErrors.seatEstimate}</small> : null}
          </label>
          <label>
            <span>備考</span>
            <textarea
              aria-invalid={fieldErrors.notes ? "true" : "false"}
              rows={5}
              value={form.notes}
              onChange={(event) => {
                const nextForm = { ...form, notes: event.target.value };
                setForm((current) => ({ ...current, notes: event.target.value }));
                updateFieldError(nextForm, "notes");
              }}
              onBlur={() => handleBlur("notes")}
              placeholder="運用開始時期や相談事項があれば記入してください。"
            />
            {fieldErrors.notes ? <small className="field-error">{fieldErrors.notes}</small> : null}
          </label>

          {error ? <p className="signup-error">{error}</p> : null}

          <p className="signup-inline-note signup-inline-note--form">
            送信後、担当者メールアドレス宛に確認メールをお送りします。
          </p>

          <label className="signup-consent" aria-invalid={fieldErrors.consentAccepted ? "true" : "false"}>
            <span className="signup-consent-control">
              <input
                type="checkbox"
                checked={form.consentAccepted}
                onChange={(event) => {
                  const nextForm = { ...form, consentAccepted: event.target.checked };
                  const nextTouchedFields = { ...touchedFields, consentAccepted: true };
                  setTouchedFields(nextTouchedFields);
                  setForm((current) => ({ ...current, consentAccepted: event.target.checked }));
                  updateFieldError(nextForm, "consentAccepted", nextTouchedFields);
                }}
                onBlur={() => handleBlur("consentAccepted")}
              />
              <span>
                <a href="https://halunasu.com/terms.html" target="_blank" rel="noreferrer">利用規約</a>
                {" "}と{" "}
                <a href="https://halunasu.com/privacy.html" target="_blank" rel="noreferrer">プライバシーポリシー</a>
                {" "}に同意して送信する
              </span>
            </span>
            {fieldErrors.consentAccepted ? <small className="field-error">{fieldErrors.consentAccepted}</small> : null}
          </label>

          <button className={`signup-submit ${isSubmitting ? "btn--loading" : ""}`} type="submit" disabled={isSubmitting}>
            {isSubmitting ? <span className="btn-spinner" aria-hidden="true" /> : null}
            <span>{isSubmitting ? "確認メールを準備中..." : "無料トライアルを申し込む"}</span>
          </button>
        </form>
      </section>
    </main>
  );
}
