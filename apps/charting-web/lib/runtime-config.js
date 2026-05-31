"use client";

function runtimeConfigValue(key) {
  if (
    typeof window !== "undefined" &&
    window.__MEDICAL_CONFIG__ &&
    Object.prototype.hasOwnProperty.call(window.__MEDICAL_CONFIG__, key)
  ) {
    return window.__MEDICAL_CONFIG__[key];
  }

  return undefined;
}

export function getGatewayBaseUrl() {
  const runtimeValue = runtimeConfigValue("gatewayBaseUrl");
  if (typeof runtimeValue === "string") {
    return runtimeValue;
  }

  return process.env.NEXT_PUBLIC_GATEWAY_BASE_URL ?? "http://localhost:8081";
}

export function getGatewayAuthBaseUrl() {
  const runtimeValue = runtimeConfigValue("gatewayAuthBaseUrl");
  if (typeof runtimeValue === "string") {
    return runtimeValue;
  }

  return process.env.NEXT_PUBLIC_GATEWAY_AUTH_BASE_URL ?? getGatewayBaseUrl();
}

export function getGatewayWsUrl() {
  const runtimeValue = runtimeConfigValue("gatewayWsUrl");
  if (typeof runtimeValue === "string" && runtimeValue) {
    return runtimeValue;
  }

  if (process.env.NEXT_PUBLIC_GATEWAY_WS_URL) {
    return process.env.NEXT_PUBLIC_GATEWAY_WS_URL;
  }

  return `${getGatewayBaseUrl().replace(/^http/, "ws")}/ws`;
}

export function getBillingBaseUrl() {
  const runtimeValue = runtimeConfigValue("billingBaseUrl");
  if (typeof runtimeValue === "string") {
    return runtimeValue;
  }

  return process.env.NEXT_PUBLIC_BILLING_BASE_URL ?? "http://localhost:8083";
}
