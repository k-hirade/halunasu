import {
  clearOperatorCsrfCookie,
  clearOperatorSessionCookie,
  extractOperatorCookieToken,
  extractBearerToken,
  OPERATOR_CSRF_COOKIE_NAME,
  verifyOperatorSessionToken,
  organizationAccessAllowsAuthenticatedLogin,
  organizationAccessDeniedMessage
} from "@medical/core";
import { canManageOrganizationRoles, canManagePlatformRoles } from "@medical/contracts";

const CSRF_FAILURE_MESSAGE = "セキュリティ確認に失敗しました。画面を再読み込みしてからもう一度お試しください。";

function parseCookieHeader(cookieHeader = "") {
  const cookies = new Map();

  for (const part of String(cookieHeader || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }

    try {
      cookies.set(rawName, decodeURIComponent(rawValue.join("=") || ""));
    } catch {
      cookies.set(rawName, rawValue.join("=") || "");
    }
  }

  return cookies;
}

function readCookie(req, name) {
  return parseCookieHeader(req.get("cookie") || "").get(name) || null;
}

function getOperatorRoles(operator) {
  return Array.isArray(operator?.member?.roles) ? operator.member.roles : [];
}

function operatorCanManageBilling(operator) {
  const roles = getOperatorRoles(operator);
  return canManageOrganizationRoles(roles) || canManagePlatformRoles(roles);
}

function resolveOperatorPayload(req, config) {
  const cookieToken = extractOperatorCookieToken(req);
  const bearerToken = config.allowOperatorBearerAuth ? extractBearerToken(req) : null;
  const token = cookieToken || bearerToken || null;
  return verifyOperatorSessionToken(token, config.appSessionSigningSecret);
}

async function hydrateOperator(req, { store, config }) {
  const payload = resolveOperatorPayload(req, config);

  if (!payload?.orgId || !payload?.memberId) {
    return null;
  }

  const context = await store.getMemberAuthContext?.({
    orgId: payload.orgId,
    memberId: payload.memberId
  });

  if (!context || context.organization.status !== "active" || context.member.status !== "active" || context.identity.status !== "active") {
    return null;
  }

  if (Number(payload.tokenVersion ?? -1) !== Number(context.identity.tokenVersion || 0)) {
    return null;
  }

  if (
    (Boolean(context.identity.mfaRequired) || Boolean(context.member.mfaRequired)) &&
    context.identity.mfaEnrolledAt &&
    !(Array.isArray(payload.amr) && payload.amr.includes("otp"))
  ) {
    return null;
  }

  return {
    orgId: context.organization.orgId,
    clinicId: context.organization.clinicId || context.organization.orgId,
    organizationCode: context.organization.organizationCode || payload.organizationCode || null,
    organization: context.organization,
    member: context.member,
    identity: context.identity,
    expiresAt: payload.exp ? new Date(payload.exp).toISOString() : null
  };
}

function clearOperatorSession(res, config) {
  clearOperatorSessionCookie(res, { isProduction: config.isProduction });
  clearOperatorCsrfCookie(res, { isProduction: config.isProduction });
}

export function requireOperatorAuth({ store, config }) {
  return async function requireOperatorAuthMiddleware(req, res, next) {
    try {
      const operator = await hydrateOperator(req, { store, config });

      if (!operator) {
        clearOperatorSession(res, config);
        res.status(401).json({
          error: "ログインの有効期限が切れました。もう一度ログインしてください。"
        });
        return;
      }

      if (!organizationAccessAllowsAuthenticatedLogin(operator.organization, {
        roles: getOperatorRoles(operator)
      })) {
        clearOperatorSession(res, config);
        res.status(403).json({
          error: organizationAccessDeniedMessage(operator.organization, {
            roles: getOperatorRoles(operator),
            mode: "login"
          }) || "このアカウントではログインできません。"
        });
        return;
      }

      req.operator = operator;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireOperatorCsrf({ config }) {
  return function requireOperatorCsrfMiddleware(req, res, next) {
    const method = String(req.method || "GET").toUpperCase();

    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      next();
      return;
    }

    const cookieToken = extractOperatorCookieToken(req);

    if (!cookieToken) {
      next();
      return;
    }

    const cookieCsrfToken = readCookie(req, OPERATOR_CSRF_COOKIE_NAME);
    const headerCsrfToken = req.get("x-csrf-token") || "";

    if (!cookieCsrfToken || !headerCsrfToken || cookieCsrfToken !== headerCsrfToken) {
      clearOperatorSession(res, config);
      res.status(403).json({
        error: CSRF_FAILURE_MESSAGE
      });
      return;
    }

    next();
  };
}

export function requireBillingManagement(req, res, next) {
  if (!operatorCanManageBilling(req.operator)) {
    res.status(403).json({
      error: "契約情報を管理する権限がありません。"
    });
    return;
  }

  next();
}
