// カルテの右下の操作帯の絵（自前の簡単な線画。色は文字色 currentColor）。
const base = { "aria-hidden": true, fill: "none", focusable: "false", height: 22, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, viewBox: "0 0 24 24", width: 22 };

export function YenIcon() {
  return <svg {...base}><path d="M6 4l6 8 6-8M12 12v8M7 13h10M7 17h10" /></svg>;
}

// 検査依頼: 書類（依頼票）と右向きの矢印
export function ExamRequestIcon() {
  return <svg {...base}><path d="M5 3h9l4 4v5" /><path d="M5 3v18h8" /><path d="M8 9h6M8 13h4" /><path d="M15 18h6M18 15l3 3-3 3" /></svg>;
}

export function SaveIcon() {
  return <svg {...base}><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4" /><rect height="5" width="8" x="8" y="13" /></svg>;
}

export function PrintIcon() {
  return <svg {...base}><path d="M7 9V4h10v5" /><rect height="8" rx="1.5" width="18" x="3" y="9" /><path d="M7 14h10v6H7z" /></svg>;
}

export function NextIcon() {
  return <svg {...base}><path d="M4 12h15M13 6l6 6-6 6" /></svg>;
}

export function MoreIcon() {
  return <svg {...base}><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></svg>;
}

// 警告一覧の種類の印
export function WarnIcon({ level }) {
  if (level === "blocker") return <svg {...base} height={16} width={16}><circle cx="12" cy="12" r="9" /><path d="M8 8l8 8M16 8l-8 8" /></svg>;
  if (level === "high") return <svg {...base} height={16} width={16}><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></svg>;
  return <svg {...base} height={16} width={16}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>;
}
