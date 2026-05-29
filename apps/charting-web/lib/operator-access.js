"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MEMBER_ROLE_DEFINITIONS,
  canAssignRole,
  canManageMembersRoles,
  canManageOrganizationRoles,
  canManageOrganizationSoapFormatsRoles,
  canManageOwnSoapFormatsRoles,
  canManagePlatformRoles,
  canOpenAdminConsoleRoles,
  canOpenSettingsConsoleRoles,
  memberRolesHavePermission,
  roleLabel
} from "@medical/contracts";
import { getGatewayBaseUrl } from "./runtime-config";

const STORAGE_KEY = "medical.operatorAccessToken.v2";
export const COOKIE_OPERATOR_ACCESS_TOKEN = "__cookie_operator_session__";
export const OPERATOR_ACCESS_CHANGED_EVENT = "medical:operator-access-changed";
const OPERATOR_CSRF_COOKIE_NAME = "soaplane_operator_csrf";
const CSRF_FAILURE_MESSAGE = "セキュリティ確認に失敗しました。画面を再読み込みしてからもう一度お試しください。";
let operatorCsrfToken = null;
let operatorCsrfRefreshPromise = null;

export { MEMBER_ROLE_DEFINITIONS };

export function getOperatorRoles(operatorSession) {
  return Array.isArray(operatorSession?.member?.roles) ? operatorSession.member.roles : [];
}

export function formatMemberRole(role) {
  return roleLabel(role);
}

export function operatorHasPermission(operatorSession, permission) {
  if (!operatorSession) {
    return false;
  }

  return memberRolesHavePermission(getOperatorRoles(operatorSession), permission);
}

export function getOrganizationAccessStatus(operatorSession) {
  return operatorSession?.organization?.access?.status || "active";
}

export function getOperatorAccessRestrictionMessage(operatorSession) {
  const status = getOrganizationAccessStatus(operatorSession);

  switch (status) {
    case "pending_setup":
      return "初回パスワード設定が完了するまで利用できません。";
    case "billing_action_required":
      return "継続利用のための決済またはお支払い情報の更新が必要なため、新規セッション作成と録音は停止しています。";
    case "suspended":
      return "契約が利用停止中のため、新規セッション作成と録音は停止しています。";
    case "canceled":
      return "契約が停止中のため、新規セッション作成と録音は停止しています。";
    default:
      return "";
  }
}

export function canCreateClinicalSession(operatorSession) {
  const roles = getOperatorRoles(operatorSession);

  if (!memberRolesHavePermission(roles, "sessions:create")) {
    return false;
  }

  return getOrganizationAccessStatus(operatorSession) === "active" || roles.includes("platform_admin");
}

export function canOpenAdminConsole(operatorSession) {
  if (!operatorSession) {
    return false;
  }

  return canOpenAdminConsoleRoles(getOperatorRoles(operatorSession));
}

export function canOpenSettingsConsole(operatorSession) {
  if (!operatorSession) {
    return false;
  }

  return canOpenSettingsConsoleRoles(getOperatorRoles(operatorSession));
}

export function canManagePlatform(operatorSession) {
  if (!operatorSession) {
    return false;
  }

  return canManagePlatformRoles(getOperatorRoles(operatorSession));
}

export function canManageOrganization(operatorSession) {
  if (!operatorSession) {
    return false;
  }

  return canManageOrganizationRoles(getOperatorRoles(operatorSession));
}

export function canManageMembers(operatorSession) {
  if (!operatorSession) {
    return false;
  }

  return canManageMembersRoles(getOperatorRoles(operatorSession));
}

export function canManageOrganizationSoapFormats(operatorSession) {
  if (!operatorSession) {
    return false;
  }

  return canManageOrganizationSoapFormatsRoles(getOperatorRoles(operatorSession));
}

export function canManageOwnSoapFormats(operatorSession) {
  if (!operatorSession) {
    return false;
  }

  return canManageOwnSoapFormatsRoles(getOperatorRoles(operatorSession));
}

export function getAssignableRoleDefinitions(operatorSession) {
  const roles = getOperatorRoles(operatorSession);
  return MEMBER_ROLE_DEFINITIONS
    .filter((definition) => canAssignRole(roles, definition.roleId))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function notifyOperatorAccessChanged() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(OPERATOR_ACCESS_CHANGED_EVENT));
}

function isCookieSessionAccessToken(token) {
  return !token || token === COOKIE_OPERATOR_ACCESS_TOKEN;
}

function hasBearerAccessToken(token) {
  return Boolean(token) && !isCookieSessionAccessToken(token);
}

export function getStoredOperatorAccessToken() {
  clearOperatorAccessToken();
  return null;
}

export function storeOperatorAccessToken(_token) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}

export function clearOperatorAccessToken() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
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

function setOperatorCsrfToken(token) {
  operatorCsrfToken = typeof token === "string" && token ? token : null;
}

function getOperatorCsrfToken() {
  return operatorCsrfToken || readCookie(OPERATOR_CSRF_COOKIE_NAME);
}

export async function refreshOperatorCsrfToken() {
  if (operatorCsrfRefreshPromise) {
    return operatorCsrfRefreshPromise;
  }

  operatorCsrfRefreshPromise = fetch(`${getGatewayBaseUrl()}/api/v1/operator/csrf`, {
    cache: "no-store",
    credentials: "include"
  })
    .then(async (response) => {
      if (!response.ok) {
        setOperatorCsrfToken(null);
        return null;
      }

      const payload = await response.json().catch(() => ({}));
      setOperatorCsrfToken(payload.csrfToken);
      return getOperatorCsrfToken();
    })
    .catch(() => {
      setOperatorCsrfToken(null);
      return null;
    })
    .finally(() => {
      operatorCsrfRefreshPromise = null;
    });

  return operatorCsrfRefreshPromise;
}

async function ensureOperatorCsrfToken() {
  if (operatorCsrfRefreshPromise) {
    const refreshed = await operatorCsrfRefreshPromise;
    if (refreshed) {
      return refreshed;
    }
  }

  const currentToken = getOperatorCsrfToken();

  if (currentToken) {
    return currentToken;
  }

  return refreshOperatorCsrfToken();
}

function requestNeedsCsrf(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

async function responseIsCsrfFailure(response) {
  if (response.status !== 403) {
    return false;
  }

  const payload = await response.clone().json().catch(() => null);
  return payload?.error === CSRF_FAILURE_MESSAGE;
}

export function buildOperatorAuthHeaders(_accessToken, baseHeaders = {}) {
  const headers = {
    ...baseHeaders,
    "Content-Type": "application/json"
  };
  const accessToken = typeof _accessToken === "string" ? _accessToken.trim() : "";
  const csrfToken = getOperatorCsrfToken();

  if (hasBearerAccessToken(accessToken)) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  return headers;
}

export async function fetchWithOperatorAuth(url, options = {}, accessToken = null) {
  const method = options.method || "GET";
  const needsCsrf = requestNeedsCsrf(method) && !hasBearerAccessToken(accessToken);

  if (needsCsrf) {
    await ensureOperatorCsrfToken();
  }

  const requestOptions = {
    ...options,
    credentials: "include",
    headers: buildOperatorAuthHeaders(accessToken, options.headers || {})
  };
  const response = await fetch(url, requestOptions);

  if (!needsCsrf || !(await responseIsCsrfFailure(response))) {
    return response;
  }

  await refreshOperatorCsrfToken();

  return fetch(url, {
    ...requestOptions,
    headers: buildOperatorAuthHeaders(accessToken, options.headers || {})
  });
}

export async function loginOperator({ organizationCode, loginId, password }) {
  const response = await fetch(`${getGatewayBaseUrl()}/api/v1/operator/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      organizationCode,
      loginId,
      password
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "ログインに失敗しました。" }));
    throw new Error(payload.error || "ログインに失敗しました。");
  }

  const result = await response.json();
  setOperatorCsrfToken(result.csrfToken);
  return result;
}

async function completeOperatorMfa(path, { challengeId, code }) {
  const response = await fetch(`${getGatewayBaseUrl()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ challengeId, code })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "確認に失敗しました。" }));
    throw new Error(payload.error || "確認に失敗しました。");
  }

  const result = await response.json();
  setOperatorCsrfToken(result.csrfToken);
  return result;
}

export function verifyOperatorMfa(input) {
  return completeOperatorMfa("/api/v1/operator/mfa/verify", input);
}

export function confirmOperatorMfaEnrollment(input) {
  return completeOperatorMfa("/api/v1/operator/mfa/enroll/confirm", input);
}

export async function getCurrentOperatorSession(accessToken = null) {
  const response = await fetch(`${getGatewayBaseUrl()}/api/v1/operator/me`, {
    cache: "no-store",
    credentials: "include",
    headers: buildOperatorAuthHeaders(accessToken)
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();

  if (!hasBearerAccessToken(accessToken)) {
    await refreshOperatorCsrfToken();
  }

  return payload;
}

export async function logoutOperator() {
  await fetch(`${getGatewayBaseUrl()}/api/v1/operator/logout`, {
    method: "POST",
    credentials: "include",
    headers: buildOperatorAuthHeaders(COOKIE_OPERATOR_ACCESS_TOKEN)
  }).catch(() => {});
  setOperatorCsrfToken(null);
}

export function useOperatorAccess() {
  const [isHydrated, setIsHydrated] = useState(false);
  const [accessToken, setAccessTokenState] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function hydrateAccess() {
      const cookieSession = await getCurrentOperatorSession().catch(() => null);

      if (cancelled) {
        return;
      }

      if (cookieSession?.authenticated) {
        clearOperatorAccessToken();
        setAccessTokenState(cookieSession.accessToken || COOKIE_OPERATOR_ACCESS_TOKEN);
        setIsHydrated(true);
        return;
      }

      clearOperatorAccessToken();
      setAccessTokenState(null);
      setIsHydrated(true);
    }

    hydrateAccess();

    return () => {
      cancelled = true;
    };
  }, []);

  const setAccessToken = useCallback((token) => {
    clearOperatorAccessToken();
    setAccessTokenState(token);
    notifyOperatorAccessChanged();
  }, []);

  const clearAccess = useCallback(() => {
    void logoutOperator();
    clearOperatorAccessToken();
    setAccessTokenState(null);
    notifyOperatorAccessChanged();
  }, []);

  return {
    accessToken,
    isHydrated,
    setAccessToken,
    clearAccess
  };
}
