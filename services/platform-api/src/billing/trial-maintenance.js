const STOP_REMINDER_STATUSES = new Set(["enabled", "cancel_scheduled", "canceled", "disabled"]);
const REMINDER_STATUSES = new Set(["trialing"]);

export async function runBillingTrialMaintenance(options = {}) {
  const store = requiredOption(options.store, "store");
  const signupMailer = requiredOption(options.signupMailer, "signupMailer");
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowIso = now.toISOString();
  const billingBaseUrl = String(
    options.billingBaseUrl
    || process.env.PLATFORM_PUBLIC_APP_BASE_URL
    || process.env.PUBLIC_APP_BASE_URL
    || "https://charting.halunasu.com"
  ).replace(/\/$/u, "");
  const billingUrl = `${billingBaseUrl}/billing`;
  const dryRun = options.dryRun === true;

  const summary = {
    now: nowIso,
    dryRun,
    organizationsChecked: 0,
    entitlementsChecked: 0,
    remindersSent: 0,
    reminderRecipientsSkipped: 0,
    trialsExpired: 0,
    cancellationsFinalized: 0,
    skipped: []
  };

  const organizations = await store.listOrganizations();
  for (const organization of organizations) {
    if (!organization || organization.status === "disabled" || organization.status === "canceled") {
      continue;
    }
    summary.organizationsChecked += 1;

    const entitlements = await safeListProductEntitlements(store, organization.orgId);
    const members = await safeListMembers(store, organization.orgId);
    const recipients = trialReminderRecipients(members);

    for (const entitlement of entitlements) {
      summary.entitlementsChecked += 1;
      if (!entitlement?.productId) {
        continue;
      }
      if (entitlement.status === "cancel_scheduled" && cancellationPeriodEnded(entitlement, now)) {
        if (!dryRun) {
          await store.updateProductEntitlement(organization.orgId, entitlement.productId, {
            status: "canceled",
            cancelAtPeriodEnd: false,
            canceledAt: nowIso,
            endsAt: nowIso
          });
          await store.createAuditEvent(organization.orgId, {
            eventType: "billing.canceled",
            targetType: "product_entitlement",
            targetId: entitlement.productId,
            safePayload: {
              productId: entitlement.productId,
              currentPeriodEnd: entitlement.currentPeriodEnd || null
            }
          });
        }
        summary.cancellationsFinalized += 1;
        continue;
      }
      if (STOP_REMINDER_STATUSES.has(entitlement.status)) {
        continue;
      }
      if (!REMINDER_STATUSES.has(entitlement.status)) {
        continue;
      }

      const trialEndsAt = parseDate(entitlement.trialEndsAt || entitlement.endsAt);
      const reminderStartsAt = parseDate(entitlement.reminderStartsAt);
      if (!trialEndsAt) {
        summary.skipped.push({
          orgId: organization.orgId,
          productId: entitlement.productId,
          reason: "trialEndsAt_missing"
        });
        continue;
      }

      if (trialEndsAt.getTime() <= now.getTime()) {
        if (!dryRun) {
          await store.updateProductEntitlement(organization.orgId, entitlement.productId, {
            status: "payment_required",
            plan: "trial_expired",
            endedAt: nowIso,
            lastReminderSentAt: entitlement.lastReminderSentAt || null,
            reminderCount: Number(entitlement.reminderCount || 0)
          });
          await store.createAuditEvent(organization.orgId, {
            eventType: "billing.trial_expired",
            targetType: "product_entitlement",
            targetId: entitlement.productId,
            safePayload: {
              productId: entitlement.productId,
              trialEndsAt: trialEndsAt.toISOString()
            }
          });
        }
        summary.trialsExpired += 1;
        continue;
      }

      if (!reminderStartsAt || reminderStartsAt.getTime() > now.getTime()) {
        continue;
      }
      if (sentToday(entitlement.lastReminderSentAt, now)) {
        continue;
      }

      const daysRemaining = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
      let sentCount = 0;
      for (const recipient of recipients) {
        if (!recipient.email && !looksLikeEmail(recipient.loginId)) {
          summary.reminderRecipientsSkipped += 1;
          continue;
        }
        if (!dryRun) {
          await signupMailer.sendTrialReminderMail({
            organization,
            entitlement,
            recipient: {
              ...recipient,
              email: recipient.email || recipient.loginId
            },
            billingUrl,
            daysRemaining
          });
        }
        sentCount += 1;
      }

      if (sentCount > 0) {
        if (!dryRun) {
          await store.updateProductEntitlement(organization.orgId, entitlement.productId, {
            lastReminderSentAt: nowIso,
            reminderCount: Number(entitlement.reminderCount || 0) + 1
          });
          await store.createAuditEvent(organization.orgId, {
            eventType: "billing.trial_reminder_sent",
            targetType: "product_entitlement",
            targetId: entitlement.productId,
            safePayload: {
              productId: entitlement.productId,
              recipientCount: sentCount,
              trialEndsAt: trialEndsAt.toISOString()
            }
          });
        }
        summary.remindersSent += sentCount;
      } else {
        summary.skipped.push({
          orgId: organization.orgId,
          productId: entitlement.productId,
          reason: "no_email_recipient"
        });
      }
    }
  }

  return summary;
}

function requiredOption(value, label) {
  if (!value) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

async function safeListProductEntitlements(store, orgId) {
  return typeof store.listProductEntitlements === "function"
    ? await store.listProductEntitlements(orgId)
    : [];
}

async function safeListMembers(store, orgId) {
  return typeof store.listMembers === "function"
    ? await store.listMembers(orgId)
    : [];
}

function trialReminderRecipients(members = []) {
  const seen = new Set();
  return members
    .filter((member) => member?.status !== "disabled")
    .filter((member) => {
      const globalRoles = new Set(member.globalRoles || []);
      return globalRoles.has("org_admin") || globalRoles.has("org_owner") || globalRoles.has("billing_admin");
    })
    .filter((member) => {
      const key = member.email || member.loginId || member.memberId;
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sentToday(value, now) {
  const sentAt = parseDate(value);
  return Boolean(sentAt && sentAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10));
}

function looksLikeEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function cancellationPeriodEnded(entitlement, now) {
  const currentPeriodEnd = parseDate(entitlement.currentPeriodEnd || entitlement.endsAt);
  return Boolean(currentPeriodEnd && currentPeriodEnd.getTime() <= now.getTime());
}
