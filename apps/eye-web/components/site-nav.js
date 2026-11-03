"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { BRAND_NAME, ORGANIZATION_STORAGE_KEY, PRODUCT_NAME } from "../lib/brand";
import { countWaiting, WAITING_COUNT_EVENT } from "../lib/consult-flow";
import { todayIso } from "../lib/format";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { useEyeApi } from "./eye-api";
import { PatientRegisterDialog } from "./patient-register-dialog";
import { PatientSearch } from "./patient-search";
import { usePlatformAuth } from "./platform-auth";

const LINKS = [
  { href: "/reception", label: "受付" },
  { href: "/", label: "診察", badge: true },
  { href: "/billing", label: "会計連携" },
  { href: "/settings", label: "設定" }
];
// 診察待ちの人数をほかの画面で取り直す間隔。診察画面（/）では画面側の 15 秒ごとの更新をそのまま使う。
const BADGE_REFRESH_MS = 60000;
const ROLE_LABELS = { admin: "管理者", doctor: "医師", orthoptist: "視能訓練士", nurse: "看護師", medical_clerk: "医療事務", viewer: "閲覧" };

// 患者・カルテ・文書の画面ではどれも点灯させない（現在地は見出しと患者帯が示す）
function currentLink(pathname) {
  if (pathname === "/") return LINKS[1];
  return LINKS.find((link) => link.href !== "/" && pathname.startsWith(link.href)) || null;
}

export function SiteNav() {
  const { logout, session } = usePlatformAuth();
  const api = useEyeApi();
  const router = useRouter();
  const pathname = usePathname() || "/";
  const [dark, setDark] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [context, setContext] = useState(null);
  const [waiting, setWaiting] = useState(null);
  const [registering, setRegistering] = useState(null);
  const userMenuRef = useRef(null);
  const current = currentLink(pathname);

  // 暗室表示はページ描画前に <head> のスクリプトが適用済み。ここでは状態を読むだけにする。
  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);
  useEffect(() => {
    setMenuOpen(false);
    userMenuRef.current?.removeAttribute("open");
  }, [pathname]);
  useEffect(() => {
    api("/v1/eye/context").then((payload) => setContext(payload.context)).catch(() => setContext(null));
  }, [api]);

  // ログインできた病院コードを端末に覚える（次回のログイン画面で入力を省く）
  const organizationCode = context?.organizationCode || session?.organizationCode || "";
  useEffect(() => {
    if (!organizationCode) return;
    try {
      window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, organizationCode);
    } catch {
      // 保存できない環境では毎回入力する
    }
  }, [organizationCode]);

  // 診察画面が読み込んだ人数を受け取る
  useEffect(() => {
    const onCount = (event) => setWaiting(Number.isFinite(event.detail) ? event.detail : null);
    window.addEventListener(WAITING_COUNT_EVENT, onCount);
    return () => window.removeEventListener(WAITING_COUNT_EVENT, onCount);
  }, []);

  // 診察画面以外では、画面を移ったときと 60 秒ごと（タブが見えている間だけ）に取り直す
  useEffect(() => {
    if (pathname === "/") return undefined;
    let cancelled = false;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      api(`/v1/eye/appointments?date=${todayIso()}`)
        .then((payload) => { if (!cancelled) setWaiting(countWaiting(payload)); })
        .catch(() => {});
    };
    refresh();
    const handle = setInterval(refresh, BADGE_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => { cancelled = true; clearInterval(handle); document.removeEventListener("visibilitychange", refresh); };
  }, [api, pathname]);

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

  const userName = context?.displayName || session?.loginId || "";
  const roleText = (context?.eyeRoles || []).map((role) => ROLE_LABELS[role] || role).join("・");
  // 表示名に役割がすでに含まれている（「院長（管理者・医師）」など）ときは重ねて出さない
  const roles = roleText && !userName.includes(roleText) ? roleText : "";
  const openRegister = context?.canRegisterPatients ? (initial) => { setMenuOpen(false); setRegistering(initial || {}); } : undefined;

  return (
    <nav aria-label="メイン" className={`site-nav-wrap no-print${menuOpen ? " is-menu-open" : ""}`}>
      <div className="site-nav">
        <Link className="site-brand" href="/" aria-label={`${BRAND_NAME} ${PRODUCT_NAME}`}>
          <img alt="" className="site-brand-mark" height="32" src="/brand/harunas-mark.png" width="32" />
          <span className="site-brand-wordmark">{BRAND_NAME}</span>
          <span className="site-nav-product">{PRODUCT_NAME}</span>
        </Link>
        <div className="site-nav-menu" id="eye-nav-menu">
          <div className="eye-nav-links">
            {LINKS.map((link) => (
              <Link aria-current={current === link ? "page" : undefined} className="eye-nav-link" href={link.href} key={link.href}>
                {link.label}
                {link.badge && waiting ? <span className="nav-badge" aria-label={`診察待ち ${waiting}人`}>{waiting}</span> : null}
              </Link>
            ))}
          </div>
          <div className="nav-menu-user">
            <p className="nav-menu-user-name">{userName}{roles ? <span className="muted">（{roles}）</span> : null}</p>
            <button aria-pressed={dark} className="nav-command" onClick={toggleDark} type="button">{dark ? "暗室表示をやめる" : "暗室表示にする"}</button>
            <button className="nav-command" onClick={logout} type="button">ログアウト</button>
          </div>
        </div>
        <PatientSearch onNavigate={() => setMenuOpen(false)} onRegister={openRegister} />
        <details className="nav-user-menu" ref={userMenuRef}>
          <summary aria-label={`利用者メニュー（${userName}）`} className="nav-user-button">
            <span className="nav-user-name">{userName}</span>
            <span aria-hidden="true" className="nav-user-caret">▾</span>
          </summary>
          <div className="nav-user-list">
            <p className="nav-user-who">
              <strong>{userName}</strong>
              {roles ? <span>{roles}</span> : null}
              {session?.loginId ? <span className="muted">ログインID: {session.loginId}</span> : null}
            </p>
            <button aria-pressed={dark} className="nav-user-item" onClick={toggleDark} type="button">
              暗室表示<span className="nav-user-state">{dark ? "オン" : "オフ"}</span>
            </button>
            <button className="nav-user-item" onClick={logout} type="button">ログアウト</button>
          </div>
        </details>
        <button aria-controls="eye-nav-menu" aria-expanded={menuOpen} className="nav-menu-button" onClick={() => setMenuOpen(!menuOpen)} type="button">
          {menuOpen ? "閉じる" : "メニュー"}
          {!menuOpen && waiting ? <span className="nav-badge" aria-hidden="true">{waiting}</span> : null}
        </button>
      </div>
      {registering && typeof document !== "undefined" ? createPortal(
        <PatientRegisterDialog
          initial={registering}
          onCancel={() => setRegistering(null)}
          onCreated={(patient) => { setRegistering(null); router.push(`/patients/${patient.patientId}`); }}
          onPickExisting={(patient) => { setRegistering(null); router.push(`/patients/${patient.patientId}`); }}
        />,
        document.body
      ) : null}
    </nav>
  );
}
