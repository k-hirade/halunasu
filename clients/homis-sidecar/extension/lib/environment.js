(function registerSidecarEnvironment(global) {
  "use strict";

  global.HalunasuSidecarConfig = Object.freeze({
    environment: "stg",
    platformBaseUrl: "https://platform-api-stg-lp2t3inhza-an.a.run.app",
    feeBaseUrl: "https://fee-api-stg-wmfrwcpzkq-an.a.run.app",
    approvalBaseUrl: "https://fee.stg.halunasu.com/settings/sidecar-approvals"
  });
})(globalThis);
