const BILLING_PLANS = Object.freeze([
  Object.freeze({
    planCode: "medical_ai_monthly",
    displayName: "ハルナス",
    description: "ハルナス 月額プラン",
    currency: "jpy",
    taxExclusiveUnitAmount: 20000,
    unitAmount: 22000,
    interval: "month",
    intervalCount: 1,
    seatQuantity: 1
  })
]);

export function getBillingPlan(planCode) {
  return BILLING_PLANS.find((plan) => plan.planCode === planCode) || null;
}
