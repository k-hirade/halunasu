"use client";

import { useEffect } from "react";
import { BRAND_NAME, PRODUCT_NAME } from "../lib/brand";
import { useAdminNav } from "./admin-nav-context";

const ADMIN_SECTIONS = [
  {
    id: "members",
    group: "病院データ",
    label: "職員",
    description: "ログイン情報、全体権限、アプリごとの権限を管理します。",
    href: "/admin?section=members"
  },
  {
    id: "facilities",
    group: "病院データ",
    label: "施設",
    description: "医療機関コードや厚生局情報を管理します。",
    href: "/admin?section=facilities"
  },
  {
    id: "departments",
    group: "病院データ",
    label: "診療科",
    description: "施設ごとの診療科を管理します。",
    href: "/admin?section=departments"
  },
  {
    id: "patients",
    group: "病院データ",
    label: "患者",
    description: "各アプリで使う患者情報を管理します。",
    href: "/admin?section=patients"
  },
  {
    id: "entitlements",
    group: "運用",
    label: "アプリ利用設定",
    description: "契約中アプリと利用状態を管理します。",
    href: "/admin?section=entitlements"
  },
  {
    id: "data-requests",
    group: "運用",
    label: "個人情報の依頼",
    description: "個人情報に関する依頼を管理します。",
    href: "/admin?section=data-requests"
  },
  {
    id: "audit",
    group: "運用",
    label: "操作ログ",
    description: "ログインやデータ変更の履歴を確認します。",
    href: "/admin?section=audit"
  },
  {
    id: "account",
    group: "運用",
    label: "アカウント",
    description: "ログイン中の職員情報と権限を確認します。",
    href: "/admin?section=account"
  }
];

export function SiteNav() {
  const {
    activeTab,
    closeAdminNav,
    isAvailable: isAdminNavAvailable,
    isOpen: isAdminNavOpen,
    sections,
    toggleAdminNav
  } = useAdminNav();
  const navSections = isAdminNavAvailable && sections.length ? sections : ADMIN_SECTIONS;
  const sectionGroups = ["病院データ", "運用"]
    .map((group) => ({
      group,
      sections: navSections.filter((section) => section.group === group)
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

  function isSectionActive(section) {
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
            <a href="/admin" className="site-brand" aria-label={`${BRAND_NAME} ${PRODUCT_NAME}`}>
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
              {sectionGroups.map(({ group, sections: groupSections }) => (
                <div className="admin-sidebar-group" key={group}>
                  <span>{group}</span>
                  <div className="global-menu-submenu" aria-label={`${group}メニュー`}>
                    {groupSections.map((section) => (
                      <a
                        aria-current={isSectionActive(section) ? "page" : undefined}
                        className={`admin-sidebar-link ${isSectionActive(section) ? "is-active" : ""}`}
                        href={section.href || `/admin?section=${section.id}`}
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

