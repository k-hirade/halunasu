"use client";

import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";
import { usePlatformAuth } from "./platform-auth";

export function SiteNav() {
  const { logout, session } = usePlatformAuth();

  return (
    <nav className="site-nav-wrap">
      <div className="site-nav">
        <div className="site-nav-left">
          <a href="/referrals" className="site-brand" aria-label={`${BRAND_NAME} ${PRODUCT_NAME}`}>
            <img alt={BRAND_NAME} className="site-brand-mark" height="36" src="/brand/harunas-mark.png" width="36" />
            <span className="site-brand-wordmark">{BRAND_NAME}</span>
          </a>
          <span className="site-nav-product">{PRODUCT_NAME}</span>
        </div>
        <div className="site-nav-actions">
          <span className="site-nav-user">{session?.loginId || ""}</span>
          <a className="site-nav-link" href="/referrals">紹介状</a>
          <a className="site-nav-link" href="/admin">管理</a>
          <button className="site-nav-link" onClick={logout} type="button">ログアウト</button>
        </div>
      </div>
    </nav>
  );
}
