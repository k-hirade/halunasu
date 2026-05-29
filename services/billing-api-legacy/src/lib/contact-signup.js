function maskLocalPart(localPart = "") {
  if (localPart.length <= 2) {
    return `${localPart.slice(0, 1)}*`;
  }

  return `${localPart.slice(0, 1)}${"*".repeat(Math.max(1, localPart.length - 2))}${localPart.slice(-1)}`;
}

export function buildLoginUrl(config) {
  return `${config.publicAppBaseUrl}/`;
}

export function buildPasswordSetupUrl(config, tokenId) {
  return `${config.publicAppBaseUrl}/setup-password/${encodeURIComponent(tokenId)}`;
}

export function maskEmailAddress(email) {
  const normalized = String(email || "").trim();

  if (!normalized) {
    return null;
  }

  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0) {
    return `${normalized.slice(0, 1)}***`;
  }

  const localPart = normalized.slice(0, atIndex);
  const domainPart = normalized.slice(atIndex + 1);

  return `${maskLocalPart(localPart)}@${domainPart}`;
}

export function toPublicContactSignupSummary(signup) {
  return {
    signupId: signup.signupId,
    status: signup.status,
    organizationName: signup.organizationName || signup.displayName || null,
    adminEmailMasked: maskEmailAddress(signup.adminEmail),
    createdAt: signup.createdAt,
    updatedAt: signup.updatedAt
  };
}

export function toVerifiedContactSignupSummary(signup) {
  return {
    ...toPublicContactSignupSummary(signup),
    organizationCode: signup.organizationCode || null,
    adminLoginId: signup.adminLoginId || null
  };
}

export async function ensurePasswordSetupToken({ store, signup, organization, member }) {
  if (signup.passwordSetupTokenId) {
    const existing = await store.getPasswordSetupToken?.(signup.passwordSetupTokenId);

    if (existing) {
      return {
        tokenId: existing.tokenId
      };
    }
  }

  return store.createPasswordSetupToken?.({
    orgId: organization.orgId,
    memberId: member.memberId,
    organizationDisplayName: organization.displayName,
    memberDisplayName: member.displayName,
    email: signup.adminEmail
  });
}
