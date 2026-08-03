# -*- coding: utf-8 -*-
"""HOMIS互換の疑似カルテHTMLレンダラ。

■ 最重要方針
  スクレイパ（Playwright）が本物のHOMISから情報を取得する際に
  前提としている DOM 構造（XPath・要素ID・JS関数）を忠実に再現する。
  これによりベースURLを差し替えるだけで既存アセットがそのまま動作する。

  再現している主な契約:
    - 患者検索: #patient_name 入力 + a[href*="patient_id="] のリンク
    - カルテ画面 body.innerText: 「診療記録 {種別} 「{院名}」」「カルテID：」「次回診療日：」
                                「在宅医療機器」「行　為」「単一建物：{n}」
    - #pdetail_karte 内の相対XPath:
        div[2]/div[2]/div/div[2]/p[1]      … 診察日時
        div[2]/div[2]/div/div[2]           … SOAP本文
        div[2]/div[1]/div[2]/div           … 要介護度・認知症自立度
        div[2]/div[1]/div[3]               … 訪問看護情報
        div[2]/div[3]/div[1]/div[2]        … 障害支援区分
        div[2]/div[3]/div[2]/div[2]        … 在宅医療機器 管理状況
        div[2]/div[3]/div[3]/div[2]/table  … 処方欄
    - #action_list                         … 行為欄（算定の正解データ）
    - #p1 タブ → #grid/div[1]/div[1]/div[2]/table … 診療開始日
    - 訪問先住所（絶対XPath）
    - #calendar3 カレンダー / pdetail_kartePrev() 日めくり
    - 書類テーブル（絶対XPath）/ #pager
    - 診療計画パターン #grid/div/div/div[2]
"""
import html
import json
from datetime import date

from data.patients import CLINIC_NAME, TARGET_YEAR, TARGET_MONTH
from data.schedule import weekday_label, scheduled_days

E = html.escape


# ══════════════════════════════════════════════════════════════
#  共通レイアウト
# ══════════════════════════════════════════════════════════════
def page(title: str, body_inner: str, extra_head: str = "") -> str:
    return f"""<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)}｜bomis（疑似カルテ）</title>
<link rel="stylesheet" href="/homic/static/style.css">
{extra_head}
</head>
<body>
{body_inner}
<script src="/homic/static/homis.js"></script>
</body></html>"""


def topbar(active: str = "") -> str:
    """body 直下 div[1]（グローバルヘッダ）。"""
    return (
        '<div class="topbar">'
        '<a class="brand" href="/homic/?pid=top_patients">bomis</a>'
        '<span class="brand-sub">在宅医療支援システム（疑似カルテ・デモ環境）</span>'
        '<a class="topbar-nav" href="/homic/?pid=top_patients">☰ 患者一覧</a>'
        '<span class="topbar-right">サンプル在宅クリニック／（デモ環境）</span>'
        '</div>'
    )


# ══════════════════════════════════════════════════════════════
#  ログイン画面
# ══════════════════════════════════════════════════════════════
def login_page() -> str:
    form = (
        '<div class="login-wrap"><div class="login-card">'
        '<h1>bomis ログイン</h1>'
        '<p class="login-note">疑似カルテ・デモ環境（IDとパスワードは任意で可）</p>'
        '<form method="post" action="/homic/login.php">'
        '<label>ID <input type="text" name="id" autocomplete="username"></label>'
        '<label>パスワード <input type="password" name="pw" autocomplete="current-password"></label>'
        '<button type="submit">ログイン</button>'
        '</form></div></div>'
    )
    return page("ログイン", topbar() + form)


# ══════════════════════════════════════════════════════════════
#  患者一覧 / 検索（?pid=top_patients）
# ══════════════════════════════════════════════════════════════
def patient_list_page(patients, q: str = "") -> str:
    rows = []
    for p in patients:
        if q and q not in p["name"].replace(" ", "") and q not in p["kana"].replace(" ", ""):
            continue
        kubun = p["facility_name"] if p["is_facility"] else "個人宅"
        rows.append(
            '<tr>'
            f'<td class="pid">{E(p["id"])}</td>'
            f'<td class="pname"><a href="/homic/?pid=patient_detail&patient_id={E(p["id"])}" '
            f'target="_blank" rel="noopener">{E(p["name"])}</a></td>'
            f'<td>{E(p["kana"])}</td>'
            f'<td>{E(p["sex"])}</td>'
            f'<td>{p["age"]}歳</td>'
            f'<td>{E(kubun)}</td>'
            f'<td>{E(p["address"])}</td>'
            '</tr>'
        )
    table = (
        '<table class="patient-list"><thead><tr>'
        '<th>ID</th><th>氏名</th><th>フリガナ</th><th>性別</th><th>年齢</th>'
        '<th>区分</th><th>住所</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table>'
    )
    search = (
        '<div class="search-bar">'
        '<form method="get" action="/homic/">'
        '<input type="hidden" name="pid" value="top_patients">'
        '氏名・フリガナ検索：'
        f'<input type="text" id="patient_name" name="q" value="{E(q)}" placeholder="例）青田" autofocus>'
        '<button type="submit">検索</button>'
        '</form></div>'
    )
    inner = (
        topbar()
        + '<div class="page-main"><div class="page-head"><h1>患者一覧・検索</h1></div>'
        + search
        + f'<div class="list-count">該当 {len(rows)} 名</div>'
        + table
        + '</div>'
    )
    return page("患者一覧", inner)


# ══════════════════════════════════════════════════════════════
#  カルテ画面（?pid=patient_detail）
# ══════════════════════════════════════════════════════════════
def _visits_desc(patient):
    """全訪問（対象月＋前月）を日付降順に整列。index 0 = 最新。"""
    out = []
    for ym, visits in patient["visits"].items():
        y, m = int(ym[:4]), int(ym[5:7])
        for v in visits:
            iso = f"{y:04d}-{m:02d}-{v['day']:02d}"
            out.append((iso, y, m, v))
    out.sort(key=lambda t: t[0], reverse=True)
    return out


def _shohou_table_html(shohou) -> str:
    if not shohou:
        return '<table class="shohou-table"><tbody><tr><td class="empty">（処方なし・Do）</td></tr></tbody></table>'
    rows = []
    for blk in shohou:
        rows.append(f'<tr class="rp-head"><td>{blk["rp"]}</td><td>{E(blk["type"])}</td><td>カルテ入力</td></tr>')
        for ln in blk["lines"]:
            rows.append(f'<tr class="rp-line"><td></td><td colspan="2">{E(ln)}</td></tr>')
    return f'<table class="shohou-table"><tbody>{"".join(rows)}</tbody></table>'


def _soap_html(iso, wd, time, soap) -> str:
    date_line = f'{int(iso[5:7])}/{int(iso[8:10])}({wd})　{E(time)}～'
    # 診察日時（p[1]）＋ SOAP各行（p[2..]）
    ps = [f'<p class="karte-date">{date_line}</p>']
    for ln in soap.split("\n"):
        ps.append(f'<p>{E(ln)}</p>')
    return "".join(ps)


def _next_visit_str(patient, iso):
    """当該カルテの「次回診療日」文字列を対象月の予約日から求める（表示用）。"""
    days = scheduled_days(TARGET_YEAR, TARGET_MONTH, patient["plan"])
    cur = date.fromisoformat(iso)
    for d in days:
        nd = date(TARGET_YEAR, TARGET_MONTH, d)
        if nd > cur:
            return f'{nd.month}/{nd.day}({weekday_label(nd.year, nd.month, nd.day)})'
    return "未定"


def karte_inner_html(patient, iso, y, m, v) -> str:
    """#pdetail_karte の内部HTML（日めくりで丸ごと差し替える単位）。
    div[1]=ヘッダ / div[2]=本体3カラム / div[3]=行為欄 の構造を厳守。"""
    wd = weekday_label(y, m, v["day"])
    kid = f'{patient["id"]}{m:02d}{v["day"]:02d}'
    tatemono = v.get("tatemono", 0)
    tatemono_html = f'<span class="kv">単一建物：{tatemono}</span>' if tatemono else ''
    next_str = _next_visit_str(patient, iso) if (y == TARGET_YEAR and m == TARGET_MONTH) else "未定"
    kaigo = patient.get("kaigo", "")
    houkan = patient.get("houkan", "")
    shougai = patient.get("shougai", "")
    devices = patient.get("devices", []) or []
    device_text = "<br>".join(E(d) for d in devices) if devices else "（在宅医療機器の登録なし）"

    action_items = "".join(f'<div class="koui-item">{E(a)}</div>' for a in v["action_list"])

    return (
        # ── div[1] ヘッダ ─────────────────────────
        '<div class="karte-head">'
        f'<div class="rec-status">診療記録　{E(v["status"])}　「{E(CLINIC_NAME)}」</div>'
        f'<div class="karte-meta"><span class="kv">カルテID：{kid}</span>'
        f'<span class="kv">次回診療日：{next_str}</span>{tatemono_html}</div>'
        '</div>'
        # ── div[2] 本体 3カラム ───────────────────
        '<div class="karte-body">'
        # 左カラム div[2]/div[1]
        '<div class="col-left">'
        '<div class="col-label">介護・保険情報</div>'
        f'<div class="kaigo-box"><div class="kaigo-text">{E(kaigo)}</div></div>'
        f'<div class="houkan-box">{E(houkan)}</div>'
        '</div>'
        # 中央カラム div[2]/div[2]
        '<div class="col-center">'
        '<div class="karte-note">'
        '<div class="note-toolbar">診療記録（SOAP）</div>'
        f'<div class="note-soap">{_soap_html(iso, wd, v["time"], v["soap"])}</div>'
        '</div>'
        '</div>'
        # 右カラム div[2]/div[3]
        '<div class="col-right">'
        '<div class="shougai-box"><div class="col-label">障害・公費</div>'
        f'<div class="shougai-text">{E(shougai)}</div></div>'
        '<div class="device-box"><div class="col-label">疾病等・在宅医療機器　管理状況</div>'
        '<div class="condition-management-list-status">疾病等状態管理一覧: 全件表示</div>'
        f'<div class="device-text">{device_text}</div></div>'
        '<div class="shohou-box"><div class="col-label">処方</div>'
        f'<div class="shohou-wrap">{_shohou_table_html(v.get("shohou"))}</div></div>'
        '</div>'
        '</div>'
        # ── div[3] 行為欄 ─────────────────────────
        '<div class="koui-area">'
        '<div class="koui-label">行　為</div>'
        f'<div id="action_list">{action_items}</div>'
        '</div>'
    )


def _calendar_inner(patient, y: int, m: int) -> str:
    """#calendar3 の内部（ヘッダ＋表）を指定年月で生成。訪問日をハイライト。"""
    import calendar as _cal
    visit_days = {v["day"] for v in patient["visits"].get(f"{y}-{m:02d}", [])}
    cal = _cal.Calendar(firstweekday=6)  # 日曜始まり
    weeks = cal.monthdayscalendar(y, m)
    head = "".join(f'<th class="{ "sun" if i==0 else "sat" if i==6 else "" }">{d}</th>'
                   for i, d in enumerate(["日", "月", "火", "水", "木", "金", "土"]))
    rows = []
    for wk in weeks:
        tds = []
        for i, d in enumerate(wk):
            if d == 0:
                tds.append('<td></td>')
            else:
                cls = "visit" if d in visit_days else ""
                if i == 0:
                    cls += " sun"
                if i == 6:
                    cls += " sat"
                iso = f"{y}-{m:02d}-{d:02d}"
                span = f'<span class="cal-day" data-iso="{iso}" onclick="karteJump(\'{iso}\')">{d}</span>'
                tds.append(f'<td class="{cls.strip()}">{span}</td>')
        rows.append(f'<tr>{"".join(tds)}</tr>')
    return (
        '<div class="cal-head"><span class="cal-prev" onclick="calShift(-1)">◀</span>'
        f'<span class="cal-title">{y}年{m}月</span>'
        '<span class="cal-next" onclick="calShift(1)">▶</span></div>'
        f'<table><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table>'
    )


def _calendar_months(patient):
    """患者の収録月（昇順）と、対象月の初期インデックスを返す。"""
    months = sorted(patient["visits"].keys())  # ["2024-12", "2025-01"]
    target = f"{TARGET_YEAR}-{TARGET_MONTH:02d}"
    idx = months.index(target) if target in months else len(months) - 1
    return months, idx


def _calendar_html(patient) -> str:
    """#calendar3 … 初期は対象月を描画（月移動は JS が innerHTML を差し替える）。"""
    months, idx = _calendar_months(patient)
    y, m = int(months[idx][:4]), int(months[idx][5:7])
    return f'<div id="calendar3" class="calendar">{_calendar_inner(patient, y, m)}</div>'


def _tab_nav(patient, active: str, on_detail: bool = False) -> str:
    """タブナビ。カルテ画面(on_detail)では 基本情報/カルテ はページ内トグル、
    それ以外のページでは全タブをリンク遷移にして、どのページからでも往復できるようにする。"""
    pid = patient["id"]
    detail = f"/homic/?pid=patient_detail&patient_id={pid}"

    def link(key, label, href):
        cls = "tab active" if active == key else "tab"
        return f'<a class="{cls}" href="{href}">{label}</a>'

    if on_detail:
        cls_p1 = "tab active" if active == "p1" else "tab"
        cls_k = "tab active" if active == "karte" else "tab"
        basic = f'<a class="{cls_p1}" id="p1" onclick="showTab(\'p1\')">基本情報</a>'
        karte = f'<a class="{cls_k}" id="tab-karte" onclick="showTab(\'karte\')">カルテ</a>'
    else:
        basic = link("p1", "基本情報", detail + "&tab=p1")
        karte = link("karte", "カルテ", detail)

    return (
        '<div class="tab-nav">'
        + basic
        + link("problem", "病名", f"/homic/?pid=patient_problem&patient_id={pid}")
        + karte
        + link("plan", "診療予定", f"/homic/?pid=patient_plan0&patient_id={pid}")
        + link("docs", "書類", f"/homic/?pid=docs_index&patient_id={pid}")
        + '</div>'
    )


def _basic_info_panel(patient, visible: bool = False) -> str:
    """#grid（基本情報／1号紙）— 診療開始日テーブル＋訪問先住所（絶対XPath準拠）。"""
    p = patient
    # YYYY/M/D 形式に整形
    sd = date.fromisoformat(p["start_date"])
    start_disp = f"{sd.year}/{sd.month}/{sd.day}"
    hoken = p["hoken"]
    hoken_disp = f'{hoken["kind"]}　{hoken.get("number","")}（{hoken.get("futan","")}）'
    visit_addr = p["address"]
    disp = "block" if visible else "none"
    return (
        f'<div id="grid" class="basic-info-panel" style="display:{disp}">'
        '<div class="grid-inner">'
        # #grid/div[1]/div[1]/div[2]/table … 診療開始日
        '<div class="basic-cols">'
        '<div class="col-label">1号紙（基本情報）</div>'
        '<div class="basic-table-wrap"><table class="basic-table"><tbody>'
        f'<tr><td>氏名</td><td>{E(p["name"])}（{E(p["kana"])}）</td></tr>'
        f'<tr><td>生年月日</td><td>{E(p["birth"])}　{p["age"]}歳　{E(p["sex"])}</td></tr>'
        f'<tr><td>開始終了</td><td>{start_disp} 〜</td></tr>'
        f'<tr><td>保険証住所</td><td>{E(p["postal"])}　{E(p["address"])}</td></tr>'
        f'<tr><td>保険</td><td>{E(hoken_disp)}</td></tr>'
        '</tbody></table></div>'
        '</div>'
        # #grid/div[1]/ul/li[2]/… 訪問先住所（絶対XPath）
        '<ul class="visit-info-list">'
        '<li class="vinfo-label">訪問先情報</li>'
        '<li>'
        '<div class="vwrap1"><div class="vwrap2">'
        '<div class="vcol"><div class="vsub">'
        '<div class="col-label">訪問先</div>'
        '<div class="vaddr-wrap"><table class="vaddr-table"><tbody>'
        f'<tr><td>氏名</td><td>{E(p["name"])}</td></tr>'
        f'<tr><td>生年月日</td><td>{E(p["birth"])}</td></tr>'
        f'<tr><td>電話</td><td>{E(p["phone"])}</td></tr>'
        f'<tr><td>訪問先住所</td><td>{E(visit_addr)}</td></tr>'
        '</tbody></table></div>'
        '</div></div>'
        '</div></div>'
        '</li>'
        '</ul>'
        '</div></div>'
    )


def patient_detail_page(patient, tab: str = "karte") -> str:
    start_p1 = (tab == "p1")
    vdesc = _visits_desc(patient)
    # 最新カルテ（index 0）をサーバ描画。日めくりは JS が KARTE_HTML を差し替える。
    first_iso, fy, fm, fv = vdesc[0]
    karte0 = karte_inner_html(patient, first_iso, fy, fm, fv)
    karte_html_list = [karte_inner_html(patient, iso, y, m, v) for (iso, y, m, v) in vdesc]
    karte_dates = [iso for (iso, y, m, v) in vdesc]

    p = patient
    kubun = p["facility_name"] if p["is_facility"] else ""
    # facility判定用ヘッダ行:「氏名 フリガナ （XX歳 性別） {施設名 or ID} / 保険」
    after_paren = f'　{E(kubun)}　{E(p["id"])} / {E(p["hoken"]["kind"])}' if p["is_facility"] \
        else f'　{E(p["id"])} / {E(p["hoken"]["kind"])}'
    header_line = (
        f'<div class="patient-id-line">{E(p["name"])}　{E(p["kana"])}　'
        f'（{p["age"]}歳　{E(p["sex"])}）{after_paren}</div>'
    )

    patient_header = (
        '<div class="patient-header">'
        + header_line
        + '<div class="ph-sub">'
        + (f'<span class="badge facility">施設入居</span>　{E(p["facility_name"])}' if p["is_facility"]
           else '<span class="badge home">個人宅</span>')
        + f'　診療開始：{E(p["start_date"])}</div>'
        + '</div>'
    )

    # カルテ タブ本体（content/div[1]）: カレンダー + 日めくり + #pdetail_karte
    karte_style = ' style="display:none"' if start_p1 else ''
    karte_panel = (
        f'<div class="karte-panel" id="karte-panel"{karte_style}>'
        '<div class="karte-side">'
        + _calendar_html(patient)
        + '<div class="dayflip">'
        f'<button class="flip-prev" onclick="pdetail_kartePrev({p["id"]})">◀ 前のカルテ</button>'
        '<span class="flip-cur" id="flip-cur"></span>'
        '<button class="flip-next" onclick="pdetail_karteNext()">次のカルテ ▶</button>'
        '</div>'
        '</div>'
        f'<div id="pdetail_karte" class="pdetail-karte">{karte0}</div>'
        '</div>'
    )

    content = (
        '<div class="content">'
        + karte_panel
        + _basic_info_panel(patient, visible=start_p1)
        + '</div>'
    )

    body_main = (
        '<div class="page-main">'
        + patient_header
        + _tab_nav(patient, "p1" if start_p1 else "karte", on_detail=True)
        + content
        + '</div>'
    )

    # カレンダー月移動用データ（両月分の内部HTML）
    months, cal_idx = _calendar_months(patient)
    cal_map = {ym: _calendar_inner(patient, int(ym[:4]), int(ym[5:7])) for ym in months}

    inner = topbar() + body_main
    data_script = (
        '<script>'
        f'window.KARTE_HTML = {json.dumps(karte_html_list, ensure_ascii=False)};'
        f'window.KARTE_DATES = {json.dumps(karte_dates, ensure_ascii=False)};'
        f'window.CAL = {json.dumps(cal_map, ensure_ascii=False)};'
        f'window.CAL_ORDER = {json.dumps(months, ensure_ascii=False)};'
        f'window.CAL_IDX = {cal_idx};'
        f'window.PATIENT_ID = "{p["id"]}";'
        '</script>'
    )
    return page(f'カルテ｜{p["name"]}', inner, extra_head=data_script)


# ══════════════════════════════════════════════════════════════
#  病名（?pid=patient_problem）
# ══════════════════════════════════════════════════════════════
def problem_page(patient) -> str:
    rows = []
    for i, pr in enumerate(patient["problems"], 1):
        main = "（主病）" if pr.get("main") else ""
        rows.append(
            f'<tr><td>{i}</td><td>{E(pr["name"])}{main}</td>'
            f'<td>{E(pr["since"])}</td><td>継続</td></tr>'
        )
    table = (
        '<table class="problem-list"><thead><tr>'
        '<th>No</th><th>病名</th><th>開始日</th><th>転帰</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table>'
    )
    inner = (
        topbar()
        + '<div class="page-main">'
        + _mini_patient_header(patient)
        + _tab_nav(patient, "problem")
        + '<div class="content"><div class="panel"><h2>病名（プロブレム）一覧</h2>'
        + '<div class="problem-list-status list-completeness-status">病名一覧: 全件表示</div>'
        + table + '</div></div></div>'
    )
    return page(f'病名｜{patient["name"]}', inner)


# ══════════════════════════════════════════════════════════════
#  書類（?pid=docs_index）— 絶対XPath準拠テーブル
# ══════════════════════════════════════════════════════════════
def _doc_period_str(doc) -> str:
    """期間 dict/文字列 → 'M/D(曜) - M/D(曜)'（スクレイパの正規表現に一致させる）。"""
    if not doc.get("period"):
        return ""
    f, t = doc["period"]
    fd, td = date.fromisoformat(f), date.fromisoformat(t)
    return (f'{fd.month}/{fd.day}({weekday_label(fd.year, fd.month, fd.day)})'
            f' - {td.month}/{td.day}({weekday_label(td.year, td.month, td.day)})')


def docs_page(patient) -> str:
    doc_rows = []
    for i, d in enumerate(patient.get("docs", []), 1):
        wr = d.get("written", "")
        if wr:
            wd = date.fromisoformat(wr)
            wr_disp = f'{wd.month}/{wd.day}({weekday_label(wd.year, wd.month, wd.day)})'
        else:
            wr_disp = ""
        doc_rows.append(
            f'<tr><td>{i}</td><td>{E(d["kind"])}</td>'
            f'<td>{E(_doc_period_str(d))}</td><td>{wr_disp}</td><td>作成済</td></tr>'
        )
    if not doc_rows:
        doc_rows.append('<tr><td colspan="5" class="empty">登録書類なし</td></tr>')
    docs_table = (
        '<table class="docs-table"><thead><tr>'
        '<th>No</th><th>書類種別</th><th>期間</th><th>記入日</th><th>状態</th>'
        '</tr></thead>'
        f'<tbody>{"".join(doc_rows)}</tbody></table>'
    )
    # 絶対XPath /html/body/div[2]/div[3]/div[2]/div[2]/div[1]/div/div[2]/table/tbody を満たす入れ子
    content = (
        '<div class="content">'          # body/div[2]/div[3]
        '<div class="docs-c1"></div>'    # div[1]
        '<div class="docs-c2">'          # div[2]
        '<div class="docs-c2a"></div>'   # div[1]
        '<div class="docs-c2b">'         # div[2]
        '<div class="docs-panel">'       # div[1]
        '<div>'                          # div（単一）
        '<div class="docs-toolbar">書類一覧</div>'  # div[1]
        '<div class="docs-table-wrap">'  # div[2]
        + docs_table +                   # table
        '</div>'
        '</div>'
        '</div>'
        '<div id="pager" class="pager"><a href="#">1</a><a href="#">2</a></div>'
        '</div>'
        '</div>'
        '</div>'
    )
    inner = (
        topbar()
        + '<div class="page-main">'      # body/div[2]
        + _mini_patient_header(patient)  # div[1]
        + _tab_nav(patient, "docs")      # div[2]
        + content                        # div[3]
        + '</div>'
    )
    return page(f'書類｜{patient["name"]}', inner)


# ══════════════════════════════════════════════════════════════
#  診療予定（?pid=patient_plan0）— #grid/div/div/div[2] にパターン
# ══════════════════════════════════════════════════════════════
def plan_page(patient) -> str:
    pattern = patient["plan"]
    days = scheduled_days(TARGET_YEAR, TARGET_MONTH, pattern)
    day_chips = "".join(
        f'<span class="plan-chip">{TARGET_MONTH}/{d}'
        f'({weekday_label(TARGET_YEAR, TARGET_MONTH, d)})</span>' for d in days
    )
    grid = (
        '<div id="grid" class="plan-grid">'   # #grid
        '<div>'                                # #grid/div
        '<div>'                                # #grid/div/div
        '<div class="plan-科">在宅診療</div>'   # div[1]
        f'<div class="plan-pattern">{E(pattern)}</div>'  # div[2] ← パターン本文
        '</div>'
        '</div>'
        '</div>'
    )
    history_rows = []
    target_month = f"{TARGET_YEAR}-{TARGET_MONTH:02d}"
    encounter_labels = {
        "定期": "定期訪問",
        "臨時": "往診",
        "電話": "電話再診",
        "外来": "外来",
    }
    for visit in patient["visits"].get(target_month, []):
        label = encounter_labels.get(visit["type"], visit["type"])
        service_date = f"{TARGET_YEAR:04d}-{TARGET_MONTH:02d}-{visit['day']:02d}"
        source_record_id = f"{patient['id']}{TARGET_MONTH:02d}{visit['day']:02d}"
        history_rows.append(
            '<tr>'
            f'<td>{service_date}</td><td>{E(label)}</td>'
            f'<td>完了</td><td>{E(source_record_id)}</td></tr>'
        )
    encounter_history = (
        '<div class="encounter-history-status list-completeness-status">当月受診履歴: 全件表示</div>'
        '<table class="encounter-history"><thead><tr>'
        '<th>診療日</th><th>受診種別</th><th>状態</th><th>カルテID</th>'
        '</tr></thead><tbody>'
        + "".join(history_rows)
        + '</tbody></table>'
    )
    content = (
        '<div class="content"><div class="panel">'
        '<h2>診療予定（予約パターン）</h2>'
        + grid
        + f'<div class="plan-dates">当月予約日：{day_chips}</div>'
        + '<h3>当月受診履歴</h3>'
        + encounter_history
        + '</div></div>'
    )
    inner = (
        topbar()
        + '<div class="page-main">'
        + _mini_patient_header(patient)
        + _tab_nav(patient, "plan")
        + content
        + '</div>'
    )
    return page(f'診療予定｜{patient["name"]}', inner)


def _mini_patient_header(patient) -> str:
    p = patient
    kubun = f'{p["facility_name"]}' if p["is_facility"] else "個人宅"
    return (
        '<div class="patient-header">'
        f'<div class="patient-id-line">{E(p["name"])}　{E(p["kana"])}　'
        f'（{p["age"]}歳　{E(p["sex"])}）　{E(p["id"])} / {E(p["hoken"]["kind"])}</div>'
        f'<div class="ph-sub">{E(kubun)}　診療開始：{E(p["start_date"])}</div>'
        '</div>'
    )
