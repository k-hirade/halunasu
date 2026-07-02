import { NextResponse } from "next/server";

// nonce ベースの Content-Security-Policy を動的に付与する。
// 本番では script-src から 'unsafe-inline' を排除し、リクエストごとの nonce + strict-dynamic に切り替える
// (XSSの注入面を大幅に縮小)。開発(next dev)は HMR が eval/inline を要求するため緩和した CSP を使う。
// nonce は x-nonce リクエストヘッダで layout に渡し、インラインの設定注入スクリプトに付与する。
//
// 注意: 動的 CSP を使うため、静的な netlify.toml 側の CSP ヘッダは除去済み(二重CSPの競合を防ぐ)。
// 本番反映前に Netlify プレビューで実機スモーク(スクリプト実行・アプリ表示)を必ず確認すること。

const isProduction = process.env.NODE_ENV === "production";

export function middleware(request) {
  const nonce = btoa(crypto.randomUUID());

  const scriptSrc = isProduction
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.run.app",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests"
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js は CSP リクエストヘッダから nonce を読み取り、自身のスクリプトへ自動付与する。
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    // 静的アセット/画像/最適化/faviconを除く全ページ。
    {
      source: "/((?!_next/static|_next/image|favicon.ico|brand/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" }
      ]
    }
  ]
};
