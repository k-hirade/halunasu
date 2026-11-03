// /api/eye/* と /api/platform/* を Cloud Run へそのまま中継する。
// Netlify のエッジ（利用者の近く）で動かし、米国リージョンのサーバー関数を経由しないようにする。
// 中身は Next のルートハンドラ（@halunasu/web-ui/proxy-utils）と同じ透過中継で、Node のテストからも呼べる。

export const PROXY_ROUTES = Object.freeze([
  { prefix: "/api/eye/", targetEnv: "EYE_PROXY_TARGET" },
  { prefix: "/api/platform/", targetEnv: "PLATFORM_PROXY_TARGET" }
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade"
]);

export function matchProxyRoute(pathname) {
  return PROXY_ROUTES.find((route) => pathname.startsWith(route.prefix)) || null;
}

export async function proxyToTarget(request, { targetBaseUrl, prefix, clientIp = "", fetchImpl = fetch }) {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`/${sourceUrl.pathname.slice(prefix.length)}${sourceUrl.search}`, targetBaseUrl);

  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("x-forwarded-host", sourceUrl.host);
  headers.set("x-forwarded-proto", sourceUrl.protocol.replace(":", ""));
  // ログイン試行の回数制限は先頭の IP で数える。利用者が送ってきた値は信用せず、エッジが見た接続元で上書きする。
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const init = { method: request.method, headers, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method)) init.body = await request.arrayBuffer();

  let upstream;
  try {
    upstream = await fetchImpl(targetUrl, init);
  } catch {
    return Response.json({ error: "API に接続できませんでした。しばらくしてからもう一度お試しください。" }, { status: 502, headers: { "cache-control": "no-store" } });
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "set-cookie") continue;
    responseHeaders.set(name, value);
  }
  for (const cookie of setCookiesOf(upstream.headers)) responseHeaders.append("set-cookie", cookie);
  responseHeaders.set("x-halunasu-proxy", "edge");

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

// Set-Cookie は複数あり得るので、結合された 1 行ではなく 1 件ずつ取り出す。
function setCookiesOf(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}
