const BILLING_PLANS = Object.freeze([
  Object.freeze({
    planCode: "medical_ai_monthly",
    displayName: "ハルナス",
    description: "ハルナス 月額プラン",
    currency: "jpy",
    taxExclusiveUnitAmount: 30000,
    unitAmount: 33000,
    interval: "month",
    intervalCount: 1,
    seatQuantity: 1
  })
]);

export function getBillingPlan(planCode) {
  return BILLING_PLANS.find((plan) => plan.planCode === planCode) || null;
}
