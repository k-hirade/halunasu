// 患者検索をどこからでも開くための合図（ヘッダーが受け取って、デジカルと同じ形の患者検索のモーダルを開く）。
// ヘッダーに常に出す入力欄はやめた（デジカルと同じく、虫めがねか「/」でモーダルを開く）。
export const OPEN_PATIENT_SEARCH_EVENT = "halunasu-eye:open-patient-search";
// ヘッダーの［ヘルプ］。カルテの画面はこの合図を受けて自分のショートカット一覧を出し、preventDefault で知らせる。
// 受け取る画面が無いときは、ヘッダーが共通のキー一覧を出す。
export const SHORTCUT_HELP_EVENT = "halunasu-eye:shortcut-help";
// 施設管理で医療機関情報を保存した合図（ヘッダーの医療機関名を取り直す）
export const FACILITY_CHANGED_EVENT = "halunasu-eye:facility-changed";

export function openPatientSearch(query = "") {
  window.dispatchEvent(new CustomEvent(OPEN_PATIENT_SEARCH_EVENT, { detail: { query } }));
}

// 英数字だけの入力は患者番号とみなし、番号の完全一致 → 前方一致 → その他の順にする
export function rankPatients(patients = [], query = "") {
  if (!/^[0-9A-Za-z-]+$/u.test(query)) return patients;
  const target = query.toLowerCase();
  const rank = (patient) => {
    const number = String(patient.primaryPatientNumber || "").toLowerCase();
    if (number === target) return 0;
    if (number.startsWith(target)) return 1;
    return 2;
  };
  return patients.map((patient, index) => ({ patient, index })).sort((left, right) => rank(left.patient) - rank(right.patient) || left.index - right.index).map((item) => item.patient);
}
