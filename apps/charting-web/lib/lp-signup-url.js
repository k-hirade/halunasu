export function lpSignupUrl(params = {}) {
  const baseUrl = String(
    process.env.NEXT_PUBLIC_LP_BASE_URL
    || process.env.LP_BASE_URL
    || defaultLpBaseUrl()
  ).replace(/\/$/u, "");
  const url = new URL("signup", `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function defaultLpBaseUrl() {
  return String(process.env.HALUNASU_ENV || "").toLowerCase() === "stg"
    ? "https://stg.halunasu.com"
    : "https://halunasu.com";
}
