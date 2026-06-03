export function coreAdminRuntimeConfigFromEnv() {
  return {
    platformBaseUrl:
      process.env.NEXT_PUBLIC_PLATFORM_BASE_URL ??
      "/api/platform"
  };
}
