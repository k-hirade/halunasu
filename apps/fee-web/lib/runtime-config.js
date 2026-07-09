export function feeRuntimeConfigFromEnv() {
  return {
    halunasuEnv:
      process.env.NEXT_PUBLIC_HALUNASU_ENV ??
      process.env.HALUNASU_ENV ??
      "local",
    platformBaseUrl:
      process.env.NEXT_PUBLIC_PLATFORM_BASE_URL ??
      "/api/platform",
    feeBaseUrl:
      process.env.NEXT_PUBLIC_FEE_BASE_URL ??
      "/api/fee",
    coreAdminBaseUrl:
      process.env.CORE_ADMIN_BASE_URL ??
      process.env.NEXT_PUBLIC_CORE_ADMIN_BASE_URL ??
      "https://admin.halunasu.com",
    demoUploadOrgCodes:
      process.env.NEXT_PUBLIC_FEE_DEMO_UPLOAD_ORG_CODES ??
      process.env.FEE_DEMO_UPLOAD_ORG_CODES ??
      "nishiyama-demo,nishiyama-demo-stg"
  };
}
