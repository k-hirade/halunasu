"use client";

import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";
import { usePlatformAuth } from "./platform-auth";

export function SiteNav() {
  const { logout, session } = usePlatformAuth();

  return (
    <nav className="site-nav-wrap">
      <div className="site-nav">
        <a className="site-brand" href="/" aria-label={`${BRAND_NAME} ${PRODUCT_NAME}`}>
          <img alt="" className="site-brand-mark" height="36" src="/brand/harunas-mark.png" width="36" />
          <span className="site-brand-wordmark">{BRAND_NAME}</span>
          <span className="site-nav-product">{PRODUCT_NAME}</span>
        </a>
        <div className="site-nav-actions">
          <span className="site-nav-user">{session?.loginId || ""}</span>
          <button className="nav-command" onClick={logout} type="button">ログアウト</button>
        </div>
      </div>
    </nav>
  );
}
