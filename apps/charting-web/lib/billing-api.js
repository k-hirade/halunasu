"use client";

import { getBillingBaseUrl } from "./runtime-config";
import { fetchWithOperatorAuth } from "./operator-access";

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error || "通信に失敗しました。");
    error.statusCode = response.status;
    throw error;
  }

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
  const response = await fetchWithOperatorAuth(`${getBillingBaseUrl()}/api/v1/billing/status`, {
    cache: "no-store"
  }, accessToken);
  return parseResponse(response);
}

export async function createBillingPortalSession(accessToken = null) {
  const response = await fetchWithOperatorAuth(`${getBillingBaseUrl()}/api/v1/billing/portal-session`, {
    method: "POST",
    body: JSON.stringify({})
  }, accessToken);
  return parseResponse(response);
}

export async function createBillingCheckoutSession(accessToken = null) {
  const response = await fetchWithOperatorAuth(`${getBillingBaseUrl()}/api/v1/billing/checkout-session`, {
    method: "POST",
    body: JSON.stringify({})
  }, accessToken);
  return parseResponse(response);
}
