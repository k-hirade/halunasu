"use client";

import { getBillingBaseUrl } from "./runtime-config";

let platformCsrfToken = null;
const PLATFORM_CSRF_COOKIE_NAMES = ["halunasu_csrf", "halunasu_stg_csrf"];

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error || "通信に失敗しました。");
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

function readCookie(name) {
  if (typeof document === "undefined") {
    return null;
  }

  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

function setPlatformCsrfToken(token) {
  platformCsrfToken = typeof token === "string" && token ? token : null;
}

function getPlatformCsrfToken() {
  return platformCsrfToken || PLATFORM_CSRF_COOKIE_NAMES.map(readCookie).find(Boolean) || null;
}

async function fetchPlatformBillingApi(path, options = {}) {
  const method = options.method || "GET";
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const csrfToken = getPlatformCsrfToken();

  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  return fetch(`${getBillingBaseUrl()}/api/v1${path}`, {
    ...options,
    method,
    credentials: "include",
    headers
  });
}

export async function loginPlatformBillingSession({ organizationCode, loginId, password, mfaCode = "" }) {
  const response = await fetchPlatformBillingApi("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      organizationCode,
      loginId,
      password,
      ...(mfaCode ? { mfaCode } : {})
    })
  });
  const payload = await parseResponse(response);
  setPlatformCsrfToken(payload.csrfToken);
  return payload;
}

export async function createContactSignup(input) {
  const response = await fetch(`${getBillingBaseUrl()}/api/v1/contact-signups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  return parseResponse(response);
}

export async function getContactSignupStatus(signupId) {
  const response = await fetch(`${getBillingBaseUrl()}/api/v1/contact-signups/${encodeURIComponent(signupId)}/status`, {
    cache: "no-store"
  });
  return parseResponse(response);
}

export async function inspectContactSignupVerification(token) {
  const response = await fetch(`${getBillingBaseUrl()}/api/v1/contact-signups/verify?token=${encodeURIComponent(token)}`, {
    cache: "no-store"
  });
  return parseResponse(response);
}

export async function verifyContactSignup(token) {
  const response = await fetch(`${getBillingBaseUrl()}/api/v1/contact-signups/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token })
  });
  return parseResponse(response);
}

export async function resendContactSignupMail(signupId) {
  const response = await fetch(`${getBillingBaseUrl()}/api/v1/contact-signups/${encodeURIComponent(signupId)}/resend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  return parseResponse(response);
}

export async function getPasswordSetupState(tokenId) {
  const response = await fetch(`${getBillingBaseUrl()}/api/v1/password-setup/${encodeURIComponent(tokenId)}`, {
    cache: "no-store"
  });
  return parseResponse(response);
}

export async function submitPasswordSetup(tokenId, password) {
  const response = await fetch(`${getBillingBaseUrl()}/api/v1/password-setup/${encodeURIComponent(tokenId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password })
  });
  return parseResponse(response);
}

export async function getCurrentBillingStatus(accessToken = null) {
  const response = await fetchPlatformBillingApi("/billing/status", {
    cache: "no-store"
  });
  return parseResponse(response);
}

export async function createBillingPortalSession(accessToken = null) {
  const response = await fetchPlatformBillingApi("/billing/portal-session", {
    method: "POST",
    body: JSON.stringify({})
  });
  return parseResponse(response);
}

export async function createBillingCheckoutSession(accessToken = null) {
  const response = await fetchPlatformBillingApi("/billing/checkout-session", {
    method: "POST",
    body: JSON.stringify({})
  });
  return parseResponse(response);
}
