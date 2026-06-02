"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAdminNav } from "./admin-nav-context";
import { BRAND_NAME } from "../lib/brand";
import {
  OPERATOR_ACCESS_CHANGED_EVENT,
  canManageMembers,
  canManageOrganizationSoapFormats,
  canManageOwnSoapFormats,
  canOpenAdminConsole,
  canOpenSettingsConsole,
  getCurrentOperatorSession,
  getStoredOperatorAccessToken
} from "../lib/operator-access";

const SETTINGS_MENU_SECTIONS = [
  {
    id: "members",
    group: "管理",
    label: "権限管理",
    description: "職員アカウント、権限、パスワード、プロンプト割当を設定します。",
    href: "/admin?section=members",
    canShow: (session) => canManageMembers(session)
  },
  {
    id: "formats",
    group: "設定",
    label: "プロンプト設定",
    description: "SOAPプロンプトを作成、確認、公開します。",
    href: "/admin?section=prompts",
    canShow: (session) => canManageOrganizationSoapFormats(session) || canManageOwnSoapFormats(session)
  },
  {
    id: "audio-test",
    group: "設定",
    label: "音声テスト",
    description: "このパソコンのマイク入力、音量、聞こえ方を確認します。",
    href: "/admin?section=audio-test"
  },
  {
    id: "audit",
    group: "管理",
    label: "操作ログ",
    description: "病院内の設定変更と操作履歴を確認します。",
    href: "/admin?section=audit",
    canShow: (session) => canOpenAdminConsole(session)
  },
  {
    id: "account",
    group: "管理",
    label: "アカウント",
    description: "ログイン中の職員情報とログイン状態を管理します。",
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
    formats: "/admin?section=prompts",
    "audio-test": "/admin?section=audio-test",
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
  const [hasAccess, setHasAccess] = useState(false);
  const [operatorSession, setOperatorSession] = useState(null);
  const [hasCheckedAccess, setHasCheckedAccess] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (pathname?.startsWith("/mobile")) {
      setOperatorSession(null);
      setHasAccess(false);
      setHasCheckedAccess(true);
      return () => {
        cancelled = true;
      };
    }

    async function refreshOperator() {
      const current = await getCurrentOperatorSession().catch(() => null);

      if (cancelled) {
        return;
      }

      if (current?.authenticated) {
        setOperatorSession(current.session || null);
        setHasAccess(true);
        setHasCheckedAccess(true);
        return;
      }

      const storedToken = getStoredOperatorAccessToken();

      if (storedToken) {
        const storedSession = await getCurrentOperatorSession(storedToken).catch(() => null);

        if (cancelled) {
          return;
        }

        if (storedSession?.authenticated) {
          setOperatorSession(storedSession.session || null);
          setHasAccess(true);
          setHasCheckedAccess(true);
          return;
        }
      }

      setOperatorSession(null);
      setHasAccess(false);
      setHasCheckedAccess(true);
    }

    refreshOperator();

    function handleAccessChanged() {
      refreshOperator();
    }

    function handleFocus() {
      refreshOperator();
    }

    window.addEventListener(OPERATOR_ACCESS_CHANGED_EVENT, handleAccessChanged);
    window.addEventListener("storage", handleAccessChanged);
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.removeEventListener(OPERATOR_ACCESS_CHANGED_EVENT, handleAccessChanged);
      window.removeEventListener("storage", handleAccessChanged);
      window.removeEventListener("focus", handleFocus);
    };
  }, [pathname]);

  const canUseSettings = hasAccess && canOpenSettingsConsole(operatorSession);
  const isSettingsRoute = pathname?.startsWith("/admin");
  const isSettingsAreaRoute = isSettingsRoute;
  const isMobileRoute = pathname?.startsWith("/mobile");
  const showGlobalMenuControl = hasAccess && !isMobileRoute;
  const fallbackSettingsSections = canUseSettings
    ? SETTINGS_MENU_SECTIONS.filter((section) => !section.canShow || section.canShow(operatorSession))
    : [];
  const settingsSections = (isAdminNavAvailable && adminSections.length ? adminSections : fallbackSettingsSections)
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
  const isClinicalRoute = !isSettingsAreaRoute && !isMobileRoute;

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

  useEffect(() => {
    if (!showGlobalMenuControl && isAdminNavOpen) {
      closeAdminNav();
    }
  }, [closeAdminNav, isAdminNavOpen, showGlobalMenuControl]);

  function isSettingsSectionActive(section) {
    if (!isSettingsRoute) {
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
            {showGlobalMenuControl ? (
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
            ) : null}
            <a href="/" className="site-brand" aria-label={`${BRAND_NAME} カルテ作成`}>
              <img
                alt={BRAND_NAME}
                className="site-brand-mark"
                height="36"
                src="/brand/harunas-mark.png"
                width="36"
              />
              <span className="site-brand-wordmark">{BRAND_NAME}</span>
            </a>
            <span className="site-nav-product">カルテ作成</span>
          </div>
          <div className="site-nav-right">
            {hasAccess || !hasCheckedAccess ? (
              null
            ) : (
              <a className="site-auth-button" href="/">ログイン</a>
            )}
          </div>
        </div>
      </nav>

      {showGlobalMenuControl && isAdminNavOpen ? (
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
                  aria-current={isClinicalRoute ? "page" : undefined}
                  className={`admin-sidebar-link ${isClinicalRoute ? "is-active" : ""}`}
                  href="/"
                  onClick={closeAdminNav}
                >
                  <strong>診療一覧</strong>
                  <small>診療記録の作成と確認を行います。</small>
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
