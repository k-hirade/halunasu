// 疑似HOMIS クライアント挙動
// スクレイパが page.evaluate("pdetail_kartePrev(ID)") で日めくりする前提を再現する（本物HOMIS互換）。
// KARTE_HTML / KARTE_DATES は index 0 が最新（降順）。

(function () {
  window.__karteIdx = 0;

  function renderKarte() {
    if (!window.KARTE_HTML) return;
    var el = document.getElementById("pdetail_karte");
    if (!el) return;
    var idx = window.__karteIdx;
    if (idx < 0) idx = 0;
    if (idx >= window.KARTE_HTML.length) idx = window.KARTE_HTML.length - 1;
    window.__karteIdx = idx;
    el.innerHTML = window.KARTE_HTML[idx];
    var cur = document.getElementById("flip-cur");
    if (cur && window.KARTE_DATES) cur.textContent = window.KARTE_DATES[idx];
    syncCalendarToKarte();
  }

  // ── カレンダー月移動 ─────────────────────────────
  function renderCal() {
    if (!window.CAL || !window.CAL_ORDER) return;
    var i = window.CAL_IDX;
    if (i < 0) i = 0;
    if (i >= window.CAL_ORDER.length) i = window.CAL_ORDER.length - 1;
    window.CAL_IDX = i;
    var box = document.getElementById("calendar3");
    if (box) box.innerHTML = window.CAL[window.CAL_ORDER[i]];
    highlightCalendar();
  }

  function highlightCalendar() {
    var iso = window.KARTE_DATES ? window.KARTE_DATES[window.__karteIdx] : null;
    document.querySelectorAll(".cal-day").forEach(function (s) {
      s.parentElement.classList.toggle("current", s.getAttribute("data-iso") === iso);
    });
  }

  // カルテ表示月にカレンダーを合わせる（日めくりで前月に入ったら前月カレンダーへ）
  function syncCalendarToKarte() {
    if (!window.KARTE_DATES || !window.CAL_ORDER) { highlightCalendar(); return; }
    var ym = (window.KARTE_DATES[window.__karteIdx] || "").slice(0, 7);
    var idx = window.CAL_ORDER.indexOf(ym);
    if (idx >= 0) window.CAL_IDX = idx;
    renderCal();
  }

  // カレンダーの ◀▶
  window.calShift = function (delta) {
    if (!window.CAL_ORDER) return;
    var i = (window.CAL_IDX || 0) + delta;
    if (i < 0) i = 0;
    if (i >= window.CAL_ORDER.length) i = window.CAL_ORDER.length - 1;
    window.CAL_IDX = i;
    renderCal();
    return false;
  };

  // 前のカルテ（過去方向）へ日めくり。スクレイパが呼び出す。
  window.pdetail_kartePrev = function (patientId) {
    window.__karteIdx += 1;
    renderKarte();
    return false;
  };
  // 次のカルテ（未来方向）へ。
  window.pdetail_karteNext = function () {
    window.__karteIdx -= 1;
    renderKarte();
    return false;
  };
  // カレンダー日付クリックで該当カルテへジャンプ。
  window.karteJump = function (iso) {
    if (!window.KARTE_DATES) return;
    var i = window.KARTE_DATES.indexOf(iso);
    if (i >= 0) { window.__karteIdx = i; renderKarte(); }
  };

  // タブ切替（基本情報 #grid ⇔ カルテ）。カルテ画面内でのみ使用（他ページからはリンク遷移）。
  window.showTab = function (key) {
    var karte = document.getElementById("karte-panel");
    var grid = document.getElementById("grid");
    var p1tab = document.getElementById("p1");
    var karteTab = document.getElementById("tab-karte");
    if (key === "p1") {
      if (karte) karte.style.display = "none";
      if (grid) grid.style.display = "block";
      if (p1tab) p1tab.classList.add("active");
      if (karteTab) karteTab.classList.remove("active");
    } else {
      if (grid) grid.style.display = "none";
      if (karte) karte.style.display = "flex";
      if (karteTab) karteTab.classList.add("active");
      if (p1tab) p1tab.classList.remove("active");
      renderKarte();  // 何度戻ってきても必ずカルテ本文を再描画
    }
    return false;
  };

  // #p1 タブは href を持たないリンク。クリックで基本情報表示。
  document.addEventListener("DOMContentLoaded", function () {
    renderKarte();
    var p1 = document.getElementById("p1");
    if (p1) p1.addEventListener("click", function (e) { e.preventDefault(); showTab("p1"); });
  });
})();
