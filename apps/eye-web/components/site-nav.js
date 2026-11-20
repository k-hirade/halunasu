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
import { isModalOpen, Modal } from "./modal";
import { FACILITY_CHANGED_EVENT, OPEN_PATIENT_SEARCH_EVENT, SHORTCUT_HELP_EVENT } from "./patient-search";
import { PasswordChangeDialog } from "./password-change-dialog";
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

// 右のアイコン（線画は自前）。デジカルのヘッダーと同じく、右上にアイコンだけを並べ、名前はツールチップと読み上げで出す。
// href の項目は画面の移動、それ以外はヘッダーの操作。行き先は眼科カルテに本当にある画面だけ。
const DESTINATIONS = [
  { id: "reception", href: "/reception", label: "受付画面", match: (path) => path.startsWith("/reception") && !path.startsWith("/reception/schedule") },
  { id: "list", href: "/", label: "患者リスト", title: "患者リスト（診察）", match: (path) => path === "/", badge: true },
  { id: "schedule", href: "/reception/schedule", label: "予約状況", match: (path) => path.startsWith("/reception/schedule") },
  { id: "billing", href: "/billing", label: "会計連携", match: (path) => path.startsWith("/billing") }
];
// 管理者だけの行き先（施設管理の中の画面）
const ADMIN_DESTINATIONS = [
  { id: "audit", href: "/settings#audit", label: "操作記録", match: () => false },
  { id: "report", href: "/settings#report", label: "経営データ集計", match: () => false }
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
  if (name === "schedule") {
    // 予定表（升目と時計の針）
    return <svg {...common}><rect height="15" rx="2" width="17" x="3.5" y="5" /><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" /><path d="M12 12.5v3l2 1.2" /></svg>;
  }
  if (name === "settings") {
    // 歯車（8 枚の歯の輪郭と軸の穴。放射線だけだと太陽に見えるので輪郭で描く）
    return <svg {...common}><path d="M18.3 10L20.4 10.3V13.7L18.3 14L17.8 15.1L19.2 16.8L16.8 19.2L15.1 17.8L14 18.3L13.7 20.4H10.3L10 18.3L8.9 17.8L7.2 19.2L4.8 16.8L6.2 15.1L5.7 14L3.6 13.7V10.3L5.7 10L6.2 8.9L4.8 7.2L7.2 4.8L8.9 6.2L10 5.7L10.3 3.6H13.7L14 5.7L15.1 6.2L16.8 4.8L19.2 7.2L17.8 8.9Z" /><circle cx="12" cy="12" r="2.8" /></svg>;
  }
  if (name === "audit") {
    // 記録の帳面と虫めがね
    return <svg {...common}><path d="M5 3.5h10l3 3v6" /><path d="M5 3.5v17h7" /><path d="M8 9h7M8 12.5h4" /><circle cx="16.5" cy="17" r="2.8" /><path d="m18.6 19.1 1.9 1.9" /></svg>;
  }
  if (name === "report") {
    // 棒グラフと下向きの矢印（集計を出力）
    return <svg {...common}><path d="M4 20.5h16" /><path d="M6.5 17V12M10.5 17V8M14.5 17v-3" /><path d="M18.5 4v8M16.5 10l2 2 2-2" /></svg>;
  }
  if (name === "dark") {
    // 三日月（暗室表示）
    return <svg {...common}><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" /></svg>;
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
  const [passwordOpen, setPasswordOpen] = useState(false);
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
      if (isModalOpen() || document.querySelector(".dialog-backdrop")) return;
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

  function openPasswordChange() {
    setMenuOpen(false);
    userMenuRef.current?.removeAttribute("open");
    setPasswordOpen(true);
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
  // 施設管理（管理者）またはセット管理（管理者でない医師）のアイコン。管理者は操作記録・経営データ集計も並べる
  const destinations = [
    ...DESTINATIONS,
    ...(settingsItem ? [{ id: "settings", href: settingsItem.href, label: settingsItem.label, match: (path) => path.startsWith("/settings") }] : []),
    ...(context?.canManageSettings ? ADMIN_DESTINATIONS : [])
  ];

  function destinationLink(item, variant) {
    const current = item.match(pathname);
    const name = item.badge && badgeLabel ? `${item.title || item.label}（${badgeLabel}）` : item.title || item.label;
    // 施設管理の中の項目（#audit など）は、同じ画面にいても切り替わるよう普通のリンクにする
    const Anchor = item.href.includes("#") ? "a" : Link;
    return (
      <Anchor
        aria-current={current ? "page" : undefined}
        aria-label={name}
        className={`eh-tool eh-tool-${item.id}${variant === "menu" ? " eh-menu-item" : ""}`}
        href={item.href}
        data-tip={variant === "menu" ? undefined : name}
        key={item.id}
      >
        <Icon name={item.id} />
        <span className="eh-tool-label">{item.label}</span>
        {item.badge && waiting ? <span aria-hidden="true" className="eh-badge" data-badge="waiting">{waiting}</span> : null}
      </Anchor>
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
            {destinations.slice(0, 2).map((item) => destinationLink(item, "bar"))}
          </div>
          <button aria-haspopup="dialog" aria-label="患者検索（/）" className="eh-tool eh-tool-search" data-tip="患者検索（/）" onClick={() => openSearch()} type="button">
            <Icon name="search" />
            <span className="eh-tool-label">検索</span>
          </button>
          <div className="eh-tools">
            {destinations.slice(2).map((item) => destinationLink(item, "bar"))}
            <button aria-label={dark ? "画面を明るく戻す（暗室）" : "画面を暗くする（暗室）"} aria-pressed={dark} className="eh-tool eh-tool-dark" data-tip={dark ? "画面を明るく戻す（暗室）" : "画面を暗くする（暗室）"} onClick={toggleDark} type="button">
              <Icon name="dark" />
              <span className="eh-tool-label">暗室</span>
            </button>
          </div>
          <span aria-hidden="true" className="eh-sep" />
          <button aria-haspopup="dialog" aria-label="ショートカット・ヘルプ" className="eh-tool eh-tool-help" data-tip="ショートカット・ヘルプ" onClick={openHelp} type="button">
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
              <button aria-haspopup="dialog" className="eh-user-item" onClick={openPasswordChange} type="button">パスワード変更</button>
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
            {destinations.map((item) => destinationLink(item, "menu"))}
            <button className="eh-tool eh-menu-item" onClick={() => openSearch()} type="button"><Icon name="search" /><span className="eh-tool-label">患者検索</span></button>
            <button className="eh-tool eh-menu-item" onClick={openHelp} type="button"><Icon name="help" /><span className="eh-tool-label">ショートカット・ヘルプ</span></button>
          </nav>
          <div className="eh-menu-user">
            <p className="eh-menu-user-name">{userName}{roles ? <span className="muted">（{roles}）</span> : null}{clinicName ? <span className="muted eh-menu-clinic">{clinicName}</span> : null}</p>
            <button aria-pressed={dark} className="eh-command" onClick={toggleDark} type="button">{dark ? "暗室表示をやめる" : "暗室表示にする"}</button>
            <button aria-haspopup="dialog" className="eh-command" onClick={openPasswordChange} type="button">パスワード変更</button>
            <button className="eh-command" onClick={logout} type="button">ログアウト</button>
          </div>
        </div>
      ) : null}
      {search ? <PatientSearchModal initialQuery={search.query} onClose={() => setSearch(null)} /> : null}
      {help && typeof document !== "undefined" ? createPortal(<GlobalHelpDialog onClose={() => setHelp(false)} />, document.body) : null}
      {passwordOpen && typeof document !== "undefined" ? createPortal(<PasswordChangeDialog onClose={() => setPasswordOpen(false)} />, document.body) : null}
    </header>
  );
}

// カルテ以外の画面のキー一覧（カルテの画面は自分の一覧を出す）
function GlobalHelpDialog({ onClose }) {
  // タッチ端末（キーボードがないことが多い）では、指での操作の案内を先に出し、キーの一覧はたたむ
  const [touch, setTouch] = useState(false);
  useEffect(() => { setTouch(window.matchMedia?.("(pointer: coarse)").matches || false); }, []);
  const keys = [["/", "患者検索を開く"], ["↑ ↓", "検索結果の行を選ぶ"], ["Enter", "選んだ患者のページを開く"], ["Esc", "検索・ダイアログを閉じる"], ["?", "カルテの画面のショートカット一覧"]];
  const keyList = <dl className="shortcut-list">{keys.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>;
  const keyNote = <p className="muted small">文字のキーは、入力欄にカーソルが無いときに効きます。カルテの画面では ? でその画面の一覧が出ます。</p>;
  return (
    <Modal className="dialog eh-help" labelledBy="eh-help-heading" onClose={onClose}>
      <h2 id="eh-help-heading">{touch ? "操作のヘルプ・ショートカット" : "ショートカット"}</h2>
      {touch ? (
        <>
          <ul className="eh-help-touch">
            <li>患者検索は、画面右上の虫めがねのボタン（またはメニューの「患者検索」）から開きます。</li>
            <li>受付の行を押すとカルテ（または患者のページ）が開きます。「…」で検査入力・受付の編集などを選べます。</li>
            <li>表が画面に入りきらないときは、表を左右になぞると続きが見えます。</li>
          </ul>
          <details className="eh-help-keys">
            <summary>キーボードをつないだときのショートカット</summary>
            {keyList}
            {keyNote}
          </details>
        </>
      ) : (
        <>
          {keyList}
          {keyNote}
        </>
      )}
      <div className="dialog-actions">
        <button autoFocus className="btn btn-primary" onClick={onClose} type="button">閉じる</button>
      </div>
    </Modal>
  );
}
