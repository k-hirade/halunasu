"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { BRAND_NAME, ORGANIZATION_STORAGE_KEY, PRODUCT_NAME } from "../lib/brand";
import { countWaiting, WAITING_COUNT_EVENT } from "../lib/consult-flow";
import { todayIso } from "../lib/format";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { useEyeApi } from "./eye-api";
import { FACILITY_CHANGED_EVENT, OPEN_PATIENT_SEARCH_EVENT, SHORTCUT_HELP_EVENT } from "./patient-search";
import { PatientSearchModal } from "./patient-search-modal";
import { usePlatformAuth } from "./platform-auth";

// 診察待ちの人数をほかの画面で取り直す間隔。診察画面（/）では画面側の 15 秒ごとの更新をそのまま使う。
const BADGE_REFRESH_MS = 60000;
const ROLE_LABELS = { admin: "管理者", doctor: "医師", orthoptist: "視能訓練士", nurse: "看護師", medical_clerk: "医療事務", viewer: "閲覧" };

// ヘッダー左の画面名（デジカルの「受付 ○○クリニック」の「受付」にあたる）
export function screenName(pathname) {
  if (pathname === "/") return "診察";
  if (pathname.startsWith("/reception/schedule")) return "予約状況";
  if (pathname.startsWith("/reception")) return "受付";
  if (pathname.startsWith("/billing")) return "会計連携";
  if (pathname.startsWith("/settings")) return "施設管理";
  if (pathname.startsWith("/documents")) return "文書";
  if (/^\/encounters\/[^/]+\/exam/u.test(pathname)) return "検査入力";
  if (/^\/encounters\/[^/]+\/optical/u.test(pathname)) return "眼鏡・CL処方";
  if (/^\/encounters\/[^/]+\/print/u.test(pathname)) return "カルテ印刷";
  if (pathname.startsWith("/patients/") && pathname.endsWith("/images")) return "画像";
  if (pathname.startsWith("/patients") || pathname.startsWith("/encounters")) return "カルテ";
  return "";
}

// 右のアイコン（線画は自前）。href の項目は画面の移動、それ以外はヘッダーの操作。
const DESTINATIONS = [
  { id: "reception", href: "/reception", label: "受付画面", match: (path) => path.startsWith("/reception") },
  { id: "list", href: "/", label: "患者リスト", title: "患者リスト（診察）", match: (path) => path === "/", badge: true },
  { id: "billing", href: "/billing", label: "会計連携", match: (path) => path.startsWith("/billing") }
];

function Icon({ name }) {
  const common = { "aria-hidden": "true", fill: "none", height: 18, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 1.8, viewBox: "0 0 24 24", width: 18 };
  if (name === "reception") {
    // 受付簿（板にはさんだ紙）
    return <svg {...common}><rect height="16" rx="2" width="14" x="5" y="5" /><path d="M9 3.5h6v3H9z" /><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" /></svg>;
  }
  if (name === "list") {
    // 人の並び
    return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><path d="M15.5 6.2a2.8 2.8 0 0 1 0 5.6M17.5 14.4c1.6.6 2.7 2.1 3 4.6" /></svg>;
  }
  if (name === "billing") {
    // 伝票と矢印（レセコンへ渡す）
    return <svg {...common}><path d="M6 3.5h9l3 3V20.5H6z" /><path d="M9 9.5h6M9 13h4" /><path d="M13 17.5h6M17 15.5l2 2-2 2" /></svg>;
  }
  if (name === "search") {
    return <svg {...common}><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></svg>;
  }
  if (name === "help") {
    return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.4" /><path d="M12 16.8v.2" /></svg>;
  }
  if (name === "menu") {
    return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
  }
  if (name === "close") {
    return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
  }
  return null;
}

export function SiteNav() {
  const { logout, session } = usePlatformAuth();
  const api = useEyeApi();
  const pathname = usePathname() || "/";
  const [dark, setDark] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [context, setContext] = useState(null);
  const [clinicName, setClinicName] = useState("");
  const [waiting, setWaiting] = useState(null);
  const [search, setSearch] = useState(null);
  const [help, setHelp] = useState(false);
  const userMenuRef = useRef(null);
  const screen = screenName(pathname);

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
  // 医療機関名（施設管理で入れた名前 → 基本の施設情報）。読めなくても画面は止めない。施設管理で保存したら取り直す
  useEffect(() => {
    let cancelled = false;
    const load = () => api("/v1/eye/bootstrap")
      .then((payload) => {
        const facility = payload.facilities?.[0];
        if (!cancelled) setClinicName(payload.facilitySettings?.name || facility?.displayName || facility?.legalName || "");
      })
      .catch(() => {});
    load();
    window.addEventListener(FACILITY_CHANGED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(FACILITY_CHANGED_EVENT, load); };
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

  const openSearch = useCallback((query = "") => {
    setMenuOpen(false);
    userMenuRef.current?.removeAttribute("open");
    setSearch({ query });
  }, []);

  // 「/」で患者検索を開く（入力中・ダイアログ表示中は効かせない）。カルテの F などからは合図で開く
  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (typing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing || event.key === "?") return;
      // 日本語入力モードでは「/」が「・」になる環境があるので、キーの位置（Slash）も見る
      if (event.key !== "/" && event.code !== "Slash") return;
      if (document.querySelector(".dialog-backdrop")) return;
      event.preventDefault();
      openSearch();
    }
    function onOpen(event) {
      openSearch(event.detail?.query || "");
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_PATIENT_SEARCH_EVENT, onOpen);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener(OPEN_PATIENT_SEARCH_EVENT, onOpen); };
  }, [openSearch]);

  function openHelp() {
    setMenuOpen(false);
    // カルテの画面は自分の一覧を出す（preventDefault で知らせる）。受け手が無ければ共通の一覧
    const event = new CustomEvent(SHORTCUT_HELP_EVENT, { cancelable: true });
    if (window.dispatchEvent(event)) setHelp(true);
  }

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
  const settingsOnPage = pathname.startsWith("/settings");
  // 施設管理は管理者だけ。管理者でない医師はセットの管理だけ開ける（中身は設定画面が権限で絞る）
  const settingsItem = context?.canManageSettings
    ? { href: "/settings", label: "施設管理" }
    : context?.canManageSets ? { href: "/settings#sets", label: "セット管理" } : null;
  const badgeLabel = waiting ? `診察待 ${waiting}人` : "";

  function destinationLink(item, variant) {
    const current = item.match(pathname);
    const name = item.badge && badgeLabel ? `${item.title || item.label}（${badgeLabel}）` : item.title || item.label;
    return (
      <Link
        aria-current={current ? "page" : undefined}
        aria-label={name}
        className={`eh-tool eh-tool-${item.id}${variant === "menu" ? " eh-menu-item" : ""}`}
        href={item.href}
        key={item.id}
        title={variant === "menu" ? undefined : name}
      >
        <Icon name={item.id} />
        <span className="eh-tool-label">{item.label}</span>
        {item.badge && waiting ? <span aria-hidden="true" className="eh-badge" data-badge="waiting">{waiting}</span> : null}
      </Link>
    );
  }

  return (
    <header className={`eh no-print${menuOpen ? " is-menu-open" : ""}`}>
      <div className="eh-bar">
        <div className="eh-left">
          <Link aria-label={`${BRAND_NAME} ${PRODUCT_NAME}（患者リストへ）`} className="eh-brand" href="/">
            <img alt="" className="eh-brand-mark" height="24" src="/brand/harunas-mark.png" width="24" />
            <span className="eh-brand-word">{BRAND_NAME}</span>
          </Link>
          {screen ? <span className="eh-screen">{screen}</span> : null}
          {clinicName ? <span className="eh-clinic" title={clinicName}>{clinicName}</span> : null}
        </div>
        <nav aria-label="メイン" className="eh-right">
          <div className="eh-tools">
            {DESTINATIONS.map((item) => destinationLink(item, "bar"))}
          </div>
          <button aria-haspopup="dialog" aria-label="患者検索（/）" className="eh-tool eh-tool-search" onClick={() => openSearch()} title="患者検索（/）" type="button">
            <Icon name="search" />
            <span className="eh-tool-label">検索</span>
          </button>
          <button aria-haspopup="dialog" aria-label="ショートカット・ヘルプ" className="eh-tool eh-tool-help" onClick={openHelp} title="ショートカット・ヘルプ" type="button">
            <Icon name="help" />
            <span className="eh-tool-label">ヘルプ</span>
          </button>
          <details className="eh-user" ref={userMenuRef}>
            <summary aria-label={`利用者メニュー（${userName}）`} className="eh-user-button">
              <span className="eh-user-name">{userName}</span>
              <span aria-hidden="true" className="eh-user-caret">▾</span>
            </summary>
            <div className="eh-user-list">
              <p className="eh-user-who">
                <strong>{userName}</strong>
                {roles ? <span>{roles}</span> : null}
                {session?.loginId ? <span className="muted">ログインID: {session.loginId}</span> : null}
              </p>
              {settingsItem ? (
                <Link aria-current={settingsOnPage ? "page" : undefined} className="eh-user-item" href={settingsItem.href} onClick={() => userMenuRef.current?.removeAttribute("open")}>
                  {settingsItem.label}
                </Link>
              ) : null}
              <button aria-pressed={dark} className="eh-user-item" onClick={toggleDark} type="button">
                暗室表示<span className="eh-user-state">{dark ? "オン" : "オフ"}</span>
              </button>
              <button className="eh-user-item" onClick={logout} type="button">ログアウト</button>
            </div>
          </details>
          <button aria-controls="eh-menu" aria-expanded={menuOpen} aria-label={menuOpen ? "メニューを閉じる" : `メニュー${badgeLabel ? `（${badgeLabel}）` : ""}`} className="eh-tool eh-menu-button" onClick={() => setMenuOpen(!menuOpen)} type="button">
            <Icon name={menuOpen ? "close" : "menu"} />
            {!menuOpen && waiting ? <span aria-hidden="true" className="eh-badge" data-badge="waiting">{waiting}</span> : null}
          </button>
        </nav>
      </div>
      {/* 767px 以下: 右のアイコンと利用者メニューの中身を 1 列に並べる */}
      {menuOpen ? (
        <div className="eh-menu" id="eh-menu">
          <nav aria-label="メイン（メニュー）" className="eh-menu-list">
            {DESTINATIONS.map((item) => destinationLink(item, "menu"))}
            <button className="eh-tool eh-menu-item" onClick={() => openSearch()} type="button"><Icon name="search" /><span className="eh-tool-label">患者検索</span></button>
            <button className="eh-tool eh-menu-item" onClick={openHelp} type="button"><Icon name="help" /><span className="eh-tool-label">ショートカット・ヘルプ</span></button>
          </nav>
          <div className="eh-menu-user">
            <p className="eh-menu-user-name">{userName}{roles ? <span className="muted">（{roles}）</span> : null}{clinicName ? <span className="muted eh-menu-clinic">{clinicName}</span> : null}</p>
            {settingsItem ? <Link aria-current={settingsOnPage ? "page" : undefined} className="eh-command" href={settingsItem.href}>{settingsItem.label}</Link> : null}
            <button aria-pressed={dark} className="eh-command" onClick={toggleDark} type="button">{dark ? "暗室表示をやめる" : "暗室表示にする"}</button>
            <button className="eh-command" onClick={logout} type="button">ログアウト</button>
          </div>
        </div>
      ) : null}
      {search ? <PatientSearchModal initialQuery={search.query} onClose={() => setSearch(null)} /> : null}
      {help && typeof document !== "undefined" ? createPortal(<GlobalHelpDialog onClose={() => setHelp(false)} />, document.body) : null}
    </header>
  );
}

// カルテ以外の画面のキー一覧（カルテの画面は自分の一覧を出す）
function GlobalHelpDialog({ onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const keys = [["/", "患者検索を開く"], ["↑ ↓", "検索結果の行を選ぶ"], ["Enter", "選んだ患者のカルテを開く"], ["Esc", "検索・ダイアログを閉じる"], ["?", "カルテの画面のショートカット一覧"]];
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
      <div aria-labelledby="eh-help-heading" aria-modal="true" className="dialog eh-help" role="dialog">
        <h2 id="eh-help-heading">ショートカット</h2>
        <dl className="shortcut-list">{keys.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
        <p className="muted small">文字のキーは、入力欄にカーソルが無いときに効きます。カルテの画面では ? でその画面の一覧が出ます。</p>
        <div className="dialog-actions">
          <button autoFocus className="btn btn-primary" onClick={onClose} type="button">閉じる</button>
        </div>
      </div>
    </div>
  );
}
