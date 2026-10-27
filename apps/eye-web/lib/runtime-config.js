export function eyeRuntimeConfigFromEnv() {
  return {
    halunasuEnv:
      process.env.NEXT_PUBLIC_HALUNASU_ENV
      ?? process.env.HALUNASU_ENV
      ?? "local",
    platformBaseUrl:
      process.env.NEXT_PUBLIC_PLATFORM_BASE_URL
      ?? "/api/platform",
    eyeBaseUrl:
      process.env.NEXT_PUBLIC_EYE_BASE_URL
      ?? "/api/eye"
  };
}
