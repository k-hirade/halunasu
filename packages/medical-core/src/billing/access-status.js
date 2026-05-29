const DEFAULT_ACCESS_STATE = Object.freeze({
  status: "active",
  reason: null,
  restrictedAt: null,
  updatedAt: null
});

function unwrapAccessSource(source = null) {
  if (!source || typeof source !== "object") {
    return null;
  }

  if (source.access && typeof source.access === "object") {
    return source.access;
  }

  return source;
}

function normalizeRoles(roles = []) {
  return Array.isArray(roles) ? roles.filter(Boolean) : [];
}

export function getOrganizationAccessState(source = null) {
  const access = unwrapAccessSource(source);

  return {
    status: access?.status || DEFAULT_ACCESS_STATE.status,
    reason: access?.reason || DEFAULT_ACCESS_STATE.reason,
    restrictedAt: access?.restrictedAt || DEFAULT_ACCESS_STATE.restrictedAt,
    updatedAt: access?.updatedAt || DEFAULT_ACCESS_STATE.updatedAt
  };
}

export function getOrganizationAccessStatus(source = null) {
  return getOrganizationAccessState(source).status;
}

export function hasPlatformBillingBypass(roles = []) {
  return normalizeRoles(roles).includes("platform_admin");
}

export function hasOrganizationBillingAdmin(roles = []) {
  const normalized = normalizeRoles(roles);
  return normalized.includes("org_admin") || normalized.includes("platform_admin");
}

export function organizationAccessAllowsAuthenticatedLogin(source = null, { roles = [] } = {}) {
  const status = getOrganizationAccessStatus(source);

  if (hasPlatformBillingBypass(roles)) {
    return true;
  }

  switch (status) {
    case "active":
    case "billing_action_required":
      return true;
    case "suspended":
    case "canceled":
      return hasOrganizationBillingAdmin(roles);
    default:
      return false;
  }
}

export function organizationAccessAllowsReadOnlyUse(source = null, { roles = [] } = {}) {
  return organizationAccessAllowsAuthenticatedLogin(source, { roles });
}

export function organizationAccessAllowsClinicalUse(source = null, { roles = [] } = {}) {
  if (hasPlatformBillingBypass(roles)) {
    return true;
  }

  return getOrganizationAccessStatus(source) === "active";
}

export function organizationAccessDeniedMessage(source = null, {
  roles = [],
  mode = "clinical"
} = {}) {
  const status = getOrganizationAccessStatus(source);

  if (mode === "login" && organizationAccessAllowsAuthenticatedLogin(source, { roles })) {
    return null;
  }

  if (mode === "read" && organizationAccessAllowsReadOnlyUse(source, { roles })) {
    return null;
  }

  if (mode === "clinical" && organizationAccessAllowsClinicalUse(source, { roles })) {
    return null;
  }

  switch (status) {
    case "pending_setup":
      return "初回パスワード設定が完了するまで利用できません。";
    case "billing_action_required":
      return mode === "clinical"
        ? "お支払い情報の更新が必要なため、この操作は現在停止しています。"
        : "お支払い情報の更新が必要です。契約管理者に確認してください。";
    case "suspended":
      return mode === "login" || mode === "read"
        ? "契約が利用停止中です。契約管理者に確認してください。"
        : "契約が利用停止中のため、この操作は行えません。契約管理者がお支払い対応後に再開してください。";
    case "canceled":
      return mode === "login" || mode === "read"
        ? "契約が停止中です。契約管理者に確認してください。"
        : "契約が停止中のため、この操作は行えません。契約管理者が再開手続きを行ってください。";
    default:
      return "この操作は現在利用できません。";
  }
}
