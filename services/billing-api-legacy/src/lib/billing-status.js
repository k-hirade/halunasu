export function mapStripeSubscriptionStatus(status, { cancellationDetails = null } = {}) {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "unpaid";
    case "canceled":
      return "canceled";
    case "incomplete":
    case "incomplete_expired":
      return "pending_checkout";
    case "paused":
      return cancellationDetails ? "canceled" : "grace_period";
    default:
      return "pending_checkout";
  }
}
