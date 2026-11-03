"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { PatientSearch } from "./patient-search";
import { usePlatformAuth } from "./platform-auth";

const LINKS = [
  { href: "/reception", label: "受付" },
  { href: "/", label: "カルテ" },
  { href: "/billing", label: "会計連携" },
  { href: "/settings", label: "設定" }
];

function currentLink(pathname) {
  if (pathname === "/") return LINKS[1];
  if (pathname.startsWith("/patients") || pathname.startsWith("/encounters") || pathname.startsWith("/documents")) return LINKS[1];
  return LINKS.find((link) => link.href !== "/" && pathname.startsWith(link.href)) || null;
}

export function SiteNav() {
  const { logout, session } = usePlatformAuth();
  const pathname = usePathname() || "/";
  const [dark, setDark] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const current = currentLink(pathname);

  // 暗室表示はページ描画前に <head> のスクリプトが適用済み。ここでは状態を読むだけにする。
  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  function toggleDark() {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // 保存できない環境では今回の表示だけ切り替える
    }
  }

  return (
    <nav className={`site-nav-wrap no-print${menuOpen ? " is-menu-open" : ""}`}>
      <div className="site-nav">
        <Link className="site-brand" href="/" aria-label={`${BRAND_NAME} ${PRODUCT_NAME}`}>
          <img alt="" className="site-brand-mark" height="32" src="/brand/harunas-mark.png" width="32" />
          <span className="site-brand-wordmark">{BRAND_NAME}</span>
          <span className="site-nav-product">{PRODUCT_NAME}</span>
        </Link>
        <span className="nav-current">{current?.label || ""}</span>
        <button aria-controls="eye-nav-menu" aria-expanded={menuOpen} className="nav-menu-button" onClick={() => setMenuOpen(!menuOpen)} type="button">
          {menuOpen ? "閉じる" : "メニュー"}
        </button>
        <div className="site-nav-menu" id="eye-nav-menu">
          <div className="eye-nav-links">
            {LINKS.map((link) => (
              <Link aria-current={current === link ? "page" : undefined} className="eye-nav-link" href={link.href} key={link.href}>{link.label}</Link>
            ))}
          </div>
          <PatientSearch onNavigate={() => setMenuOpen(false)} />
          <div className="site-nav-actions">
            <button aria-pressed={dark} className="nav-command" onClick={toggleDark} type="button">{dark ? "通常表示" : "暗室表示"}</button>
            <span className="site-nav-user">{session?.loginId || ""}</span>
            <button className="nav-command" onClick={logout} type="button">ログアウト</button>
          </div>
        </div>
      </div>
    </nav>
  );
}
