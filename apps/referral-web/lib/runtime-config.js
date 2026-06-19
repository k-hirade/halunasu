export function referralRuntimeConfigFromEnv() {
  return {
    halunasuEnv:
      process.env.NEXT_PUBLIC_HALUNASU_ENV ??
      process.env.HALUNASU_ENV ??
      "local",
    platformBaseUrl:
      process.env.NEXT_PUBLIC_PLATFORM_BASE_URL ??
      "/api/platform",
    referralBaseUrl:
      process.env.NEXT_PUBLIC_REFERRAL_BASE_URL ??
      "/api/referral",
    coreAdminBaseUrl:
      process.env.CORE_ADMIN_BASE_URL ??
      process.env.NEXT_PUBLIC_CORE_ADMIN_BASE_URL ??
      "https://admin.halunasu.com"
  };
}
