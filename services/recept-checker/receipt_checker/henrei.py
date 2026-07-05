"""返戻・査定データの取込みと分析

審査支払機関からオンライン請求システムで取得できる2種類のデータを解析する:

1. 返戻ファイル(RECEIPTC.HEN / RECEIPTC.SAH)
   「オンラインによる一次請求返戻ファイル及び再審査等返戻ファイル…に係る
   記録条件仕様(医科用)」に基づく。UKEと同じCSV形式に HI(返戻医療機関)/
   HR(返戻理由)/HG(返戻合計)レコードと請求データ(RE等)が含まれる。
   HRレコード: [HR, 処理年月GYYMM, 返戻区分, 診療識別, 返戻事由コード(L+4桁),
                返戻理由, 補足事項, 補正情報, 増減点連絡書年月, 検索番号, …]

2. 増減点連絡書CSV(ファイル名 RIzogn…/MIzogn… 等)
   「印刷対象帳票・CSV・PDF作成対象ファイル(医科・DPC用)」仕様に基づく。
   レコード種別: 1=ヘッダ 2=タイトル 3=明細1行目 4=明細2行目以降 5=合計/食事 6=集計。
   明細30項目(2診療年月GYYMM, 3レセプト番号, 18氏名, 19カルテ番号, 20箇所(診療識別),
   22法別, 23増減点数(±/±¥), 24事由(A/B/C/D/F/G/H/K 最大2), 26請求内容,
   28補正・査定後内容, 29検索番号)。前行と同一の場合に省略される項目は
   フィルダウン(直前値の引継ぎ)で補完する。

取込んだデータは data/assessments.db に蓄積し、事由別・月別の集計と
「査定されやすい項目」の把握(=チェックルール調整)に使う。
"""

from __future__ import annotations

import datetime
import re
import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .codes import SHINRYO_SHIKIBETSU
from .models import parse_receipt_ym

# 事由記号(増減点連絡書)の説明
JIYU_LABELS = {
    "A": "A: 適応外(医学的に適応と認められない)",
    "B": "B: 過剰・重複",
    "C": "C: A・B以外で医学的に不適当",
    "D": "D: 告示・通知の算定要件に不合致",
    "F": "F: 固定点数誤り",
    "G": "G: 請求点数の集計誤り",
    "H": "H: 縦計計算誤り",
    "K": "K: その他(事務上)",
}

# 返戻区分(HRレコード)
HENREI_KUBUN = {
    "1": "事務上の返戻",
    "2": "審査上の返戻",
    "3": "特別審査上の返戻",
    "4": "再審査等(資格関係等)",
    "5": "再審査等(診療内容)",
    "6": "再審査等(事務上)",
    "7": "再審査等(突合再審査)",
    "8": "再審査等(特別審査上)",
    "9": "再審査等(取下げ)",
}


@dataclass
class AssessmentEntry:
    """返戻・査定の1件"""

    kind: str                  # henrei(返戻) | satei(査定・増減点)
    shori_ym: str = ""         # 処理年月(YYYYMM 西暦)
    shinryo_ym: str = ""       # 診療年月(YYYYMM 西暦)
    receipt_no: str = ""
    patient_name: str = ""
    karte_no: str = ""
    shikibetsu: str = ""       # 診療識別(箇所)
    reason_code: str = ""      # 返戻事由コード(L5106等) / 査定事由記号(A,B,…)
    reason_text: str = ""
    points: Optional[int] = None   # 増減点数(負=減点)。金額(¥)の場合はNone
    amount_yen: Optional[int] = None
    before_text: str = ""      # 請求内容
    after_text: str = ""       # 補正・査定後内容
    search_no: str = ""
    source_file: str = ""


@dataclass
class AssessmentParseResult:
    entries: list = field(default_factory=list)
    kind: str = ""
    warnings: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# 共通ユーティリティ
# ---------------------------------------------------------------------------

def _decode(data: bytes) -> str:
    data = data.rstrip(b"\x1a")
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    try:
        return data.decode("cp932")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def _rows(text: str):
    for line in re.split(r"\r\n|\r|\n", text):
        if line.strip():
            yield line.split(",")


def _g(row: list, idx: int) -> str:
    return row[idx].strip() if idx < len(row) and row[idx] else ""


def _ym_to_seireki(ym: str) -> str:
    """GYYMM(和暦5桁)またはYYYYMM(西暦6桁)を西暦YYYYMMに"""
    d = parse_receipt_ym(ym)
    return f"{d.year:04d}{d.month:02d}" if d else ym


# ---------------------------------------------------------------------------
# 返戻ファイル(HEN/SAH)
# ---------------------------------------------------------------------------

def parse_henrei_bytes(data: bytes, source_name: str = "") -> AssessmentParseResult:
    """返戻ファイルからHRレコード(返戻理由)を抽出する。

    請求データ(RE)から患者名・診療年月・カルテ番号を拾い、
    後続のHRレコードに紐づける。履歴管理ブロックの行
    (先頭がデータ識別数字の行)は先頭3項目を読み飛ばして解釈する。
    """
    res = AssessmentParseResult(kind="henrei")
    text = _decode(data)
    current = {"patient_name": "", "shinryo_ym": "", "karte_no": "", "receipt_no": ""}

    for row in _rows(text):
        rec = _g(row, 0).upper()
        offset = 0
        if rec.isdigit():
            # 履歴管理ブロック: データ識別, 行番号, 枝番号, レコード識別, …
            rec = _g(row, 3).upper()
            offset = 3
        if rec == "RE":
            current = {
                "receipt_no": _g(row, offset + 1),
                "shinryo_ym": _ym_to_seireki(_g(row, offset + 3)),
                "patient_name": _g(row, offset + 4),
                "karte_no": _g(row, offset + 13),
            }
        elif rec == "HR":
            kubun = _g(row, offset + 2)
            hosei = _g(row, offset + 7)  # 補正情報(別表18)
            hosei_label = {
                "1": "一次請求・再請求で補正等あり",
                "2": "一次請求・再請求と再審査等請求の両方で補正等あり",
                "3": "再審査等請求でのみ補正等あり",
            }.get(hosei, hosei)
            entry = AssessmentEntry(
                kind="henrei",
                shori_ym=_ym_to_seireki(_g(row, offset + 1)),
                shikibetsu=_g(row, offset + 3),
                reason_code=_g(row, offset + 4),
                reason_text=_g(row, offset + 5)
                or HENREI_KUBUN.get(kubun, ""),
                before_text=_g(row, offset + 6),
                after_text=hosei_label,
                search_no=_g(row, offset + 9),
                source_file=source_name,
                **current,
            )
            res.entries.append(entry)
    if not res.entries:
        res.warnings.append("HRレコード(返戻理由)が見つかりませんでした。返戻ファイル(RECEIPTC.HEN/SAH)か確認してください。")
    return res


# ---------------------------------------------------------------------------
# 増減点連絡書CSV
# ---------------------------------------------------------------------------

def _parse_amount(s: str):
    """増減点数欄 '-216'(点数) / '-¥7000'(金額) → (points, yen)

    符号(+増点/-減点)と¥マーク(半角¥・全角¥・バックスラッシュ)の有無で
    点数と金額を判別する。解釈できない場合は (None, None)。
    """
    s = (s or "").strip().replace(",", "")
    if not s:
        return None, None
    is_yen = any(mark in s for mark in ("¥", "￥", "\\"))
    digits = re.sub(r"[^0-9]", "", s)
    if not digits:
        return None, None
    value = int(digits) * (-1 if s.lstrip().startswith("-") else 1)
    return (None, value) if is_yen else (value, None)


def parse_zogen_csv_bytes(data: bytes, source_name: str = "") -> AssessmentParseResult:
    """増減点連絡書CSVを解析する(フィルダウン対応)"""
    res = AssessmentParseResult(kind="satei")
    text = _decode(data)
    last: dict = {}

    for row in _rows(text):
        rectype = _g(row, 0)
        if rectype not in ("3", "4"):
            continue  # 1=ヘッダ 2=タイトル 5=合計/食事 6=集計 は明細ではない(二重計上防止)
        # フィルダウン: 種別4以降で省略された基本項目は直前値を引き継ぐ
        shinryo_ym = _g(row, 1) or last.get("shinryo_ym", "")
        receipt_no = _g(row, 2) or last.get("receipt_no", "")
        name = _g(row, 17) or last.get("name", "")
        karte = _g(row, 18) or last.get("karte", "")
        shikibetsu = _g(row, 19) or last.get("shikibetsu", "")
        last = {
            "shinryo_ym": shinryo_ym, "receipt_no": receipt_no,
            "name": name, "karte": karte, "shikibetsu": shikibetsu,
        }
        amount = _g(row, 22)
        jiyu = _g(row, 23)
        if not amount and not jiyu:
            continue  # 増減のない行(合計行等)はスキップ
        points, yen = _parse_amount(amount)
        entry = AssessmentEntry(
            kind="satei",
            shinryo_ym=_ym_to_seireki(shinryo_ym),
            receipt_no=receipt_no,
            patient_name=name,
            karte_no=karte,
            shikibetsu=shikibetsu if shikibetsu in SHINRYO_SHIKIBETSU else shikibetsu,
            reason_code=jiyu,
            reason_text="/".join(JIYU_LABELS.get(c, c) for c in jiyu if c.strip()),
            points=points,
            amount_yen=yen,
            before_text=_g(row, 25),
            after_text=_g(row, 27),
            search_no=_g(row, 28),
            source_file=source_name,
        )
        res.entries.append(entry)
    if not res.entries:
        res.warnings.append("増減点の明細行が見つかりませんでした。増減点連絡書CSV(RIzogn…)か確認してください。")
    return res


def parse_assessment_bytes(data: bytes, source_name: str = "") -> AssessmentParseResult:
    """返戻ファイル/増減点連絡書CSVを自動判別して解析する"""
    text = _decode(data)[:20000]
    has_hr = bool(re.search(r"(^|\n)(\d+,\d+,\d+,)?HR,", text))
    name = (source_name or "").lower()
    if has_hr or name.endswith((".hen", ".sah")):
        return parse_henrei_bytes(data, source_name)
    return parse_zogen_csv_bytes(data, source_name)


# ---------------------------------------------------------------------------
# 蓄積ストア
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    shori_ym TEXT NOT NULL DEFAULT '',
    shinryo_ym TEXT NOT NULL DEFAULT '',
    receipt_no TEXT NOT NULL DEFAULT '',
    patient_name TEXT NOT NULL DEFAULT '',
    karte_no TEXT NOT NULL DEFAULT '',
    shikibetsu TEXT NOT NULL DEFAULT '',
    reason_code TEXT NOT NULL DEFAULT '',
    reason_text TEXT NOT NULL DEFAULT '',
    points INTEGER,
    amount_yen INTEGER,
    before_text TEXT NOT NULL DEFAULT '',
    after_text TEXT NOT NULL DEFAULT '',
    search_no TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL
);
-- SQLiteのUNIQUE制約はNULL同士を別値として扱うため、points/amount_yen(NULL許容)は
-- IFNULLで正規化した式インデックスで重複判定する(再取込みの重複防止)
CREATE UNIQUE INDEX IF NOT EXISTS ux_assessments ON assessments (
    kind, shinryo_ym, receipt_no, shikibetsu, reason_code,
    IFNULL(points, ''), IFNULL(amount_yen, ''), search_no, before_text
);
"""


class AssessmentStore:
    """返戻・査定データの蓄積(スレッドセーフ)"""

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        with self._lock:
            self._migrate()
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def _migrate(self):
        """旧スキーマ(テーブル内UNIQUE制約・NULL重複あり)からの移行"""
        row = self._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='assessments'"
        ).fetchone()
        if not row or "UNIQUE" not in (row[0] or ""):
            return
        # 重複を除去しつつテーブルを再構築する
        self._conn.executescript(
            """
            ALTER TABLE assessments RENAME TO assessments_old;
            """
        )
        self._conn.executescript(SCHEMA)
        self._conn.execute(
            """
            INSERT OR IGNORE INTO assessments
                (kind, shori_ym, shinryo_ym, receipt_no, patient_name, karte_no,
                 shikibetsu, reason_code, reason_text, points, amount_yen,
                 before_text, after_text, search_no, source_file, imported_at)
            SELECT kind, shori_ym, shinryo_ym, receipt_no, patient_name, karte_no,
                   shikibetsu, reason_code, reason_text, points, amount_yen,
                   before_text, after_text, search_no, source_file, imported_at
            FROM assessments_old
            """
        )
        self._conn.execute("DROP TABLE assessments_old")

    def close(self):
        with self._lock:
            self._conn.close()

    def save(self, entries: list) -> int:
        now = datetime.datetime.now().isoformat(timespec="seconds")
        saved = 0
        with self._lock:
            for e in entries:
                cur = self._conn.execute(
                    """
                    INSERT OR IGNORE INTO assessments
                        (kind, shori_ym, shinryo_ym, receipt_no, patient_name, karte_no,
                         shikibetsu, reason_code, reason_text, points, amount_yen,
                         before_text, after_text, search_no, source_file, imported_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        e.kind, e.shori_ym, e.shinryo_ym, e.receipt_no, e.patient_name,
                        e.karte_no, e.shikibetsu, e.reason_code, e.reason_text,
                        e.points, e.amount_yen, e.before_text, e.after_text,
                        e.search_no, e.source_file, now,
                    ),
                )
                saved += cur.rowcount
            self._conn.commit()
        return saved

    def summary(self) -> dict:
        with self._lock:
            by_reason = self._conn.execute(
                "SELECT kind, reason_code, COUNT(*), COALESCE(SUM(points),0) "
                "FROM assessments GROUP BY kind, reason_code ORDER BY COUNT(*) DESC"
            ).fetchall()
            by_month = self._conn.execute(
                "SELECT shinryo_ym, kind, COUNT(*), COALESCE(SUM(points),0) "
                "FROM assessments WHERE shinryo_ym != '' "
                "GROUP BY shinryo_ym, kind ORDER BY shinryo_ym DESC LIMIT 24"
            ).fetchall()
            by_shikibetsu = self._conn.execute(
                "SELECT shikibetsu, COUNT(*), COALESCE(SUM(points),0) FROM assessments "
                "WHERE kind='satei' GROUP BY shikibetsu ORDER BY SUM(points) ASC LIMIT 15"
            ).fetchall()
            totals = self._conn.execute(
                "SELECT kind, COUNT(*), COALESCE(SUM(points),0) FROM assessments GROUP BY kind"
            ).fetchall()
        return {
            "by_reason": by_reason,
            "by_month": by_month,
            "by_shikibetsu": [
                (SHINRYO_SHIKIBETSU.get(s, s or "(不明)"), c, p) for s, c, p in by_shikibetsu
            ],
            "totals": {k: (c, p) for k, c, p in totals},
        }

    def recent(self, limit: int = 100) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT kind, shinryo_ym, receipt_no, patient_name, shikibetsu, "
                "reason_code, reason_text, points, amount_yen, before_text, after_text "
                "FROM assessments ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        cols = ["kind", "shinryo_ym", "receipt_no", "patient_name", "shikibetsu",
                "reason_code", "reason_text", "points", "amount_yen", "before_text", "after_text"]
        return [dict(zip(cols, r)) for r in rows]

    def count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM assessments").fetchone()[0]
