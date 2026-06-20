// 共通実装を @halunasu/web-ui に一本化(ステップ1)。
// charting の /api/v1 系ルートは prefix 未指定で呼ぶため、既定を "/api/v1" に上書きする。
import { proxyApiRequest as sharedProxyApiRequest, splitSetCookieHeader } from "@halunasu/web-ui/proxy-utils";

export function proxyApiRequest(request, segments, targetBaseUrl, prefix = "/api/v1") {
  return sharedProxyApiRequest(request, segments, targetBaseUrl, prefix);
}

export { splitSetCookieHeader };
