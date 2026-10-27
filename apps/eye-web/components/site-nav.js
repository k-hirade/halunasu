"use client";

import { usePathname } from "next/navigation";
import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";
import { usePlatformAuth } from "./platform-auth";

const LINKS = [
  { href: "/reception", label: "受付" },
  { href: "/", label: "カルテ" },
  { href: "/settings", label: "設定" }
];

export function SiteNav() {
  const { logout, session } = usePlatformAuth();
  const pathname = usePathname();

  return (
    <nav className="site-nav-wrap no-print">
      <div className="site-nav">
        <a className="site-brand" href="/" aria-label={`${BRAND_NAME} ${PRODUCT_NAME}`}>
          <img alt="" className="site-brand-mark" height="32" src="/brand/harunas-mark.png" width="32" />
          <span className="site-brand-wordmark">{BRAND_NAME}</span>
          <span className="site-nav-product">{PRODUCT_NAME}</span>
        </a>
        <div className="eye-nav-links">
          {LINKS.map((link) => (
            <a aria-current={pathname === link.href ? "page" : undefined} className="eye-nav-link" href={link.href} key={link.href}>{link.label}</a>
          ))}
        </div>
        <div className="site-nav-actions">
          <span className="site-nav-user">{session?.loginId || ""}</span>
          <button className="nav-command" onClick={logout} type="button">ログアウト</button>
        </div>
      </div>
    </nav>
  );
}
