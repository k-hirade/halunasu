"use client";

export function getGatewayBaseUrl() {
  if (typeof window !== "undefined" && window.__MEDICAL_CONFIG__?.gatewayBaseUrl) {
    return window.__MEDICAL_CONFIG__.gatewayBaseUrl;
  }

  return process.env.NEXT_PUBLIC_GATEWAY_BASE_URL ?? "http://localhost:8081";
}

export function getGatewayWsUrl() {
  if (typeof window !== "undefined" && window.__MEDICAL_CONFIG__?.gatewayWsUrl) {
    return window.__MEDICAL_CONFIG__.gatewayWsUrl;
  }

  if (process.env.NEXT_PUBLIC_GATEWAY_WS_URL) {
    return process.env.NEXT_PUBLIC_GATEWAY_WS_URL;
  }

  return `${getGatewayBaseUrl().replace(/^http/, "ws")}/ws`;
}

export function getBillingBaseUrl() {
  if (typeof window !== "undefined" && window.__MEDICAL_CONFIG__?.billingBaseUrl) {
    return window.__MEDICAL_CONFIG__.billingBaseUrl;
  }

  return process.env.NEXT_PUBLIC_BILLING_BASE_URL ?? "http://localhost:8083";
}
