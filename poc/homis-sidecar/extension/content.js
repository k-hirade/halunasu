// bomis(疑似HOMIS)患者詳細ページから、算定に必要な最小情報を読み取る。
// 抽出のみを行い、通信・保存はしない(通信はサイドパネル側)。
// セレクタ契約:
//   - 患者ID: URLの patient_id
//   - 表示中カルテ: #pdetail_karte
//   - カルテID(例 10010125 = 患者1001 + MMDD): .karte-meta .kv
//   - 診療日ラベル(例 1/25(土)　10:30～): .note-soap .karte-date
//   - 年: カレンダー見出し .cal-title (例 2025年1月)
//   - SOAP本文: #pdetail_karte .note-soap p (karte-dateを除く)

function extractKarte() {
  const url = new URL(location.href);
  const externalPatientId = url.searchParams.get("patient_id") || "";
  const container = document.querySelector("#pdetail_karte");
  if (!externalPatientId || !container) {
    return { ok: false, error: "患者詳細のカルテ画面ではありません" };
  }

  const metaText = [...container.querySelectorAll(".karte-meta .kv")]
    .map((el) => el.textContent || "").join(" ");
  const karteId = (metaText.match(/カルテID：\s*(\d{6,10})/) || [])[1] || "";

  const dateLabel = container.querySelector(".note-soap .karte-date")?.textContent || "";
  const receptionTime = (dateLabel.match(/(\d{1,2}:\d{2})/) || [])[1] || "";
  const monthDay = dateLabel.match(/(\d{1,2})\/(\d{1,2})/);

  const calTitle = document.querySelector(".cal-title")?.textContent || "";
  const calYear = (calTitle.match(/(\d{4})年/) || [])[1] || "";

  let serviceDate = "";
  if (monthDay && calYear) {
    serviceDate = `${calYear}-${String(monthDay[1]).padStart(2, "0")}-${String(monthDay[2]).padStart(2, "0")}`;
  } else if (karteId.length >= 8 && calYear) {
    const mmdd = karteId.slice(externalPatientId.length, externalPatientId.length + 4);
    serviceDate = `${calYear}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`;
  }

  const soapParagraphs = [...container.querySelectorAll(".note-soap p")]
    .filter((p) => !p.classList.contains("karte-date"))
    .map((p) => (p.textContent || "").trim())
    .filter(Boolean);

  if (!soapParagraphs.length) {
    return { ok: false, error: "SOAP本文が見つかりません" };
  }

  return {
    ok: true,
    externalPatientId,
    karteId,
    serviceDate,
    receptionTime,
    clinicalText: soapParagraphs.join("\n"),
    sourceUrl: location.href,
    extractedAt: new Date().toISOString()
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "halunasu:extract") {
    sendResponse(extractKarte());
  }
  return false;
});
