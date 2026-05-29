export async function enforceTrialExpirationHandler({ store, now }) {
  const organizations = (await store.listOrganizations?.()) || [];
  const expired = [];

  for (const organization of organizations) {
    const billingStatus = organization.billing?.status || null;
    const trialEndsAt = organization.billing?.trialEndsAt || null;
    const stripeSubscriptionId = organization.billing?.stripeSubscriptionId || null;

    if (billingStatus !== "trialing" || !trialEndsAt || stripeSubscriptionId) {
      continue;
    }

    if (Date.parse(trialEndsAt) > Date.parse(now)) {
      continue;
    }

    const orgId = organization.orgId || organization.clinicId;
    const updatedBilling = await store.updateOrganizationBilling?.({
      orgId,
      patch: {
        status: "pending_checkout",
        currentPeriodEnd: null,
        gracePeriodEndsAt: null,
        cancelAtPeriodEnd: false,
        lastStripeEventId: organization.billing?.lastStripeEventId || null
      },
      auditType: "billing.trial.expired"
    });
    const updatedOrganization = await store.updateOrganizationAccess?.({
      orgId,
      patch: {
        status: "billing_action_required",
        reason: "billing.trial_expired",
        restrictedAt: organization.access?.restrictedAt || now
      },
      auditType: "billing.access.trial_expired"
    }) || updatedBilling;

    expired.push({
      orgId,
      trialEndsAt,
      billingStatusBefore: billingStatus,
      billingStatusAfter: updatedOrganization?.billing?.status || null,
      accessStatus: updatedOrganization?.access?.status || null
    });
  }

  return {
    checkedCount: organizations.length,
    expiredCount: expired.length,
    expired
  };
}
