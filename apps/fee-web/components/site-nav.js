"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";
import { useAdminNav } from "./admin-nav-context";
import { isStgFeeEnvironment } from "../lib/baseline-diff";

const BASELINE_DIFF_MENU_SECTION = {
  id: "baseline-diff",
  group: "設定",
  label: "再算定差分診断",
  description: "既存レセと当社再算定を突合し差分を出します（STG限定）。",
  href: "/admin?section=baseline-diff"
};

const RECEPT_CHECKER_MENU_SECTION = {
  id: "recept-checker",
  group: "設定",
  label: "レセプトチェッカー",
  description: "UKEをアップロードして請求前点検を行います（STG限定）。",
  href: "/admin?section=recept-checker"
};

const SETTINGS_MENU_SECTIONS = [
  {
    id: "members",
    group: "管理",
    label: "権限管理",
    description: "診療報酬算定を使う職員と権限を確認します。",
    href: "/admin?section=members"
  },
  {
    id: "settings",
    group: "設定",
    label: "算定設定",
    description: "算定時の初期値とレビュー表示方針を管理します。",
    href: "/admin?section=settings"
  },
  {
    id: "receipt-settings",
    group: "設定",
    label: "レセプト設定",
    description: "レセ電出力、出力前チェック、詳記の既定値を管理します。",
    href: "/admin?section=receipt-settings"
  },
  {
    id: "audit",
    group: "管理",
    label: "操作ログ",
    description: "算定、レビュー、設定変更の履歴を確認します。",
    href: "/admin?section=audit"
  },
  {
    id: "account",
    group: "管理",
    label: "アカウント",
    description: "ログイン中の職員情報と利用権限を確認します。",
    href: "/admin?section=account"
  }
];

function hrefForAdminSection(section) {
  if (section.href) {
    return section.href;
  }

  return {
    home: "/admin",
    members: "/admin?section=members",
    settings: "/admin?section=settings",
    "receipt-settings": "/admin?section=receipt-settings",
    "baseline-diff": "/admin?section=baseline-diff",
    "recept-checker": "/admin?section=recept-checker",
    audit: "/admin?section=audit",
    account: "/admin?section=account"
  }[section.id] || "/admin";
}

export function SiteNav() {
  const pathname = usePathname();
  const {
    activeTab,
    closeAdminNav,
    isAvailable: isAdminNavAvailable,
    isOpen: isAdminNavOpen,
    sections: adminSections,
    toggleAdminNav
  } = useAdminNav();

  const [isStg, setIsStg] = useState(false);
  useEffect(() => {
    setIsStg(isStgFeeEnvironment());
  }, []);

  const isAdminRoute = pathname?.startsWith("/admin");
  const isMonthlyRoute = pathname?.startsWith("/monthly");
  const isSessionsRoute = !isAdminRoute && !isMonthlyRoute;
  // /admin ではコンテキスト(STGフィルタ済み)を使用。それ以外ではフォールバックにSTG限定項目を足す。
  const fallbackSections = isStg
    ? [...SETTINGS_MENU_SECTIONS, BASELINE_DIFF_MENU_SECTION, RECEPT_CHECKER_MENU_SECTION]
    : SETTINGS_MENU_SECTIONS;
  const settingsSections = (isAdminNavAvailable && adminSections.length ? adminSections : fallbackSections)
    .map((section) => ({
      ...section,
      href: hrefForAdminSection(section)
    }));
  const settingsSectionGroups = ["設定", "管理"]
    .map((group) => ({
      group,
      sections: settingsSections.filter((section) => section.group === group)
    }))
    .filter((entry) => entry.sections.length);

  useEffect(() => {
    if (!isAdminNavOpen) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        closeAdminNav();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeAdminNav, isAdminNavOpen]);

  function isSettingsSectionActive(section) {
    if (!isAdminRoute) {
      return false;
    }
    if (section.id === "home") {
      return activeTab === "home" || !activeTab;
    }
    return activeTab === section.id;
  }

  return (
    <>
      <nav className="site-nav-wrap">
        <div className="site-nav">
          <div className="site-nav-left">
            <button
              aria-controls="global-navigation-drawer"
              aria-expanded={isAdminNavOpen}
              aria-label={isAdminNavOpen ? "メニューを閉じる" : "メニューを開く"}
              className="site-menu-button"
              onClick={toggleAdminNav}
              type="button"
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 7h16" />
                <path d="M4 12h16" />
                <path d="M4 17h16" />
              </svg>
            </button>
            <a href="/sessions" className="site-brand" aria-label={`${BRAND_NAME} ${PRODUCT_NAME}`}>
              <img
                alt={BRAND_NAME}
                className="site-brand-mark"
                height="36"
                src="/brand/harunas-mark.png"
                width="36"
              />
              <span className="site-brand-wordmark">{BRAND_NAME}</span>
            </a>
            <span className="site-nav-product">{PRODUCT_NAME}</span>
          </div>
        </div>
      </nav>

      {isAdminNavOpen ? (
        <>
          <button
            aria-label="メニューを閉じる"
            className="admin-nav-backdrop"
            onClick={closeAdminNav}
            type="button"
          />
          <aside className="admin-nav-drawer" id="global-navigation-drawer" aria-label="メニュー">
            <div className="admin-nav-drawer-head">
              <span>メニュー</span>
              <strong>移動先を選択</strong>
            </div>
            <nav className="admin-sidebar-nav" aria-label="メニュー">
              <div className="admin-sidebar-group">
                <span>メイン</span>
                <a
                  aria-current={isSessionsRoute ? "page" : undefined}
                  className={`admin-sidebar-link ${isSessionsRoute ? "is-active" : ""}`}
                  href="/sessions"
                  onClick={closeAdminNav}
                >
                  <strong>算定</strong>
                  <small>算定記録の作成、一覧、レビューを行います。</small>
                </a>
                <a
                  aria-current={isMonthlyRoute ? "page" : undefined}
                  className={`admin-sidebar-link ${isMonthlyRoute ? "is-active" : ""}`}
                  href="/monthly"
                  onClick={closeAdminNav}
                >
                  <strong>月次レセ点検</strong>
                  <small>請求月ごとの要確認、病名不足、出力可否を確認します。</small>
                </a>
              </div>
              {settingsSectionGroups.map(({ group, sections }) => (
                <div className="admin-sidebar-group" key={group}>
                  <span>{group}</span>
                  <div className="global-menu-submenu" aria-label={`${group}メニュー`}>
                    {sections.map((section) => (
                      <a
                        aria-current={isSettingsSectionActive(section) ? "page" : undefined}
                        className={`admin-sidebar-link ${isSettingsSectionActive(section) ? "is-active" : ""}`}
                        href={section.href}
                        key={section.id}
                        onClick={closeAdminNav}
                      >
                        <strong>{section.label}</strong>
                        <small>{section.description}</small>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </aside>
        </>
      ) : null}
    </>
  );
}
