export function feeRuntimeConfigFromEnv() {
  return {
    platformBaseUrl:
      process.env.NEXT_PUBLIC_PLATFORM_BASE_URL ??
      "/api/platform",
    feeBaseUrl:
      process.env.NEXT_PUBLIC_FEE_BASE_URL ??
      "/api/fee",
    coreAdminBaseUrl:
      process.env.CORE_ADMIN_BASE_URL ??
      process.env.NEXT_PUBLIC_CORE_ADMIN_BASE_URL ??
      "https://admin.halunasu.com"
  };
}
