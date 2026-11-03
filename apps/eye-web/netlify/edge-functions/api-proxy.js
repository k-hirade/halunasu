import { matchProxyRoute, proxyToTarget } from "../../lib/edge-proxy.mjs";

// API の中継をエッジで行う。中継先が設定されていなければ、従来どおり Next のルートハンドラに任せる。
export default async function apiProxy(request, context) {
  const route = matchProxyRoute(new URL(request.url).pathname);
  const targetBaseUrl = route ? Deno.env.get(route.targetEnv) : "";
  if (!route || !targetBaseUrl) return context.next();
  return proxyToTarget(request, { targetBaseUrl, prefix: route.prefix, clientIp: context.ip || "" });
}
