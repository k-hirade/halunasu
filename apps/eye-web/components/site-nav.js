"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";
import { usePlatformAuth } from "./platform-auth";

const LINKS = [
  { href: "/reception", label: "受付" },
  { href: "/", label: "カルテ" },
  { href: "/billing", label: "会計連携" },
  { href: "/settings", label: "設定" }
];

export function SiteNav() {
  const { logout, session } = usePlatformAuth();
  const pathname = usePathname();
  const [dark, setDark] = useState(false);

  // 暗室表示（散瞳後の診察や暗い検査室向け）。端末ごとに覚える。
  useEffect(() => {
    let saved = false;
    try {
      saved = window.localStorage.getItem("halunasu-eye-dark") === "1";
    } catch {
      saved = false;
    }
    setDark(saved);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      window.localStorage.setItem("halunasu-eye-dark", dark ? "1" : "0");
    } catch {
      // 保存できない環境では今回の表示だけ切り替える
    }
  }, [dark]);

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
          <button aria-pressed={dark} className="nav-command" onClick={() => setDark(!dark)} type="button">{dark ? "通常表示" : "暗室表示"}</button>
          <span className="site-nav-user">{session?.loginId || ""}</span>
          <button className="nav-command" onClick={logout} type="button">ログアウト</button>
        </div>
      </div>
    </nav>
  );
}
