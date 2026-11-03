"use client";

import Link from "next/link";

// 印刷画面の共通の枠。画面では灰色の机の上に実寸の用紙を置き、操作はすべて上のツールバーに集める。
// 紙面（.sheet の中）は印刷と同じ見た目。下書きは紙にも「下書き・未確定」の透かしを入れる。
// ページの区切りはブラウザの印刷に任せる（JS で計算しない）。

export const PAPER_SIZES = Object.freeze({
  A4: { label: "A4", margin: "12mm 12mm 14mm" },
  A5: { label: "A5", margin: "10mm 10mm 12mm" }
});

export function PrintShell({
  backHref,
  backLabel,
  title,
  subject = "",
  statusLabel,
  draft,
  watermark = "下書き・未確定",
  paper = "A4",
  paperOptions = null,
  onPaperChange = null,
  margin = "",
  footerText = "",
  controls = null,
  alerts = null,
  sheetClassName = "",
  children
}) {
  const size = PAPER_SIZES[paper] ? paper : "A4";
  const pageMargin = margin || PAPER_SIZES[size].margin;
  // 用紙と余白はこの画面にだけ効かせる。ページ番号とフッターは @page の余白欄（対応ブラウザのみ。出なくても壊れない）。
  const pageRule = `@page { size: ${size} portrait; margin: ${pageMargin};`
    + ` @bottom-right { content: counter(page) " / " counter(pages); font-size: 8pt; color: #555; }`
    + (footerText ? ` @bottom-left { content: "${cssString(footerText)}"; font-size: 8pt; color: #555; }` : "")
    + " }";
  return (
    <div className="print-shell">
      <style>{pageRule}</style>
      <header className="print-bar no-print">
        <Link className="btn btn-ghost print-back" href={backHref}>← {backLabel}</Link>
        <div className="print-bar-title">
          <strong>{title}</strong>
          {subject ? <span className="print-bar-subject">{subject}</span> : null}
        </div>
        <span className={`print-state ${draft ? "is-draft" : "is-final"}`}>{statusLabel}</span>
        <div className="print-bar-actions">
          {controls}
          {paperOptions && onPaperChange ? (
            <div aria-label="用紙" className="print-paper" role="group">
              {paperOptions.map((option) => (
                <button aria-pressed={option === size} className="btn btn-chip" key={option} onClick={() => onPaperChange(option)} type="button">{option}</button>
              ))}
            </div>
          ) : null}
          <button className={`btn ${draft ? "btn-ghost print-go is-draft" : "btn-primary print-go"}`} onClick={() => window.print()} type="button">
            {draft ? "下書きとして印刷" : "印刷"}
          </button>
        </div>
      </header>
      {alerts ? <div className="print-alerts no-print">{alerts}</div> : null}
      <div className="print-desk">
        <article className={`sheet sheet-${size.toLowerCase()} ${sheetClassName}`.trim()}>
          {draft ? <PrintWatermark label={watermark} /> : null}
          {children}
        </article>
      </div>
    </div>
  );
}

export function PrintWatermark({ label = "下書き・未確定" }) {
  return <div aria-hidden="true" className="print-watermark"><span>{label}</span></div>;
}

// 読み込み中・エラーも同じ枠の中で出す（戻る手段を残す）。
export function PrintMessage({ backHref, backLabel, children }) {
  return (
    <div className="print-shell">
      <header className="print-bar no-print">
        <Link className="btn btn-ghost print-back" href={backHref}>← {backLabel}</Link>
      </header>
      <div className="print-desk">{children}</div>
    </div>
  );
}

// 版の切り替え（確定した版は /versions/:n から読む）。latestLabel は「最新」の表示。
export function VersionSelect({ versions = [], value, onChange, latestLabel }) {
  if (!versions.length) return null;
  return (
    <label className="print-version">
      <span>版</span>
      <select className="input" onChange={(event) => onChange(event.target.value)} value={value || ""}>
        <option value="">{latestLabel}</option>
        {[...versions].reverse().map((item) => (
          <option key={item.version} value={String(item.version)}>確定 v{item.version}</option>
        ))}
      </select>
    </label>
  );
}

// 施設の名称・住所・電話。文書の API と同じく、有効な施設を優先する。
export function pickFacility(facilities = []) {
  return facilities.find((item) => item.status === "active") || facilities[0] || null;
}

export function facilityInfo(facility) {
  const address = facility?.address || {};
  return {
    name: facility?.legalName || facility?.displayName || "",
    postalCode: address.postalCode || "",
    address: [address.prefecture || facility?.prefecture || "", address.city || "", address.line1 || address.street || "", address.line2 || ""].filter(Boolean).join(" "),
    phone: facility?.phone || ""
  };
}

// 用紙の大きさの記憶（端末ごと）。読めなくても既定の A4 で動く。
export function readStoredPaper(key, fallback = "A4") {
  try {
    const value = window.localStorage.getItem(key);
    return PAPER_SIZES[value] ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storePaper(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 保存できなくても印刷はできる
  }
}

function cssString(text) {
  return String(text).replace(/[\\"]/gu, (char) => `\\${char}`).replace(/[\r\n]+/gu, " ").replace(/</gu, "\\3C ");
}
