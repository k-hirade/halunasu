"""縦覧点検用の履歴ストア

過去月のレセプトをSQLiteに保存し、複数月にまたがるチェック
(月1回制限の重複算定、初診料の算定間隔など)を可能にする。

- 一意キー: 医療機関 × 患者キー × 生年月日 × 性別 × 診療年月 × 入外区分
  (同一患者の同月の入院レセと外来レセは別レコードとして保存される)
- 患者キーはカルテ番号を優先し、なければ氏名で照合する
  (氏名照合は同姓同名・同生年月日で混線し得るため、カルテ番号の記録を推奨)
- Web UI等のマルチスレッド環境から呼ばれるため、全操作をロックで直列化する
"""

from __future__ import annotations

import datetime
import json
import sqlite3
import threading
from pathlib import Path
from typing import Optional

from .models import Receipt

SCHEMA = """
CREATE TABLE IF NOT EXISTS receipt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_code TEXT NOT NULL,
    karte_no TEXT NOT NULL,
    patient_name TEXT NOT NULL,
    birthdate TEXT NOT NULL,
    sex TEXT NOT NULL DEFAULT '',
    nyugai TEXT NOT NULL DEFAULT '',    -- 1:入院 2:入院外
    shinryo_ym TEXT NOT NULL,           -- 正規化済み YYYYMM (西暦)
    receipt_no INTEGER,
    total_points INTEGER,
    payload TEXT NOT NULL,              -- 診療行為・医薬品・傷病名のJSON
    imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hist_unique
    ON receipt_history (facility_code, karte_no, birthdate, sex, shinryo_ym, nyugai);
CREATE INDEX IF NOT EXISTS idx_hist_patient
    ON receipt_history (facility_code, karte_no, birthdate);
"""


def _normalize_ym(receipt: Receipt) -> Optional[str]:
    d = receipt.shinryo_ym_as_date()
    if not d:
        return None
    return f"{d.year:04d}{d.month:02d}"


def _patient_key(receipt: Receipt) -> str:
    """患者を同定するキー。カルテ番号があれば優先、なければ氏名。"""
    return receipt.karte_no.strip() or receipt.patient_name.strip()


def _nyugai(receipt: Receipt) -> str:
    return "1" if receipt.is_inpatient else "2"


class HistoryStore:
    """レセプト履歴のSQLiteストア(スレッドセーフ)"""

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        with self._lock:
            self._migrate()
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def _migrate(self):
        """旧スキーマからの移行。

        旧版は (1) sex/nyugai 列がない、(2) テーブル内UNIQUE制約または
        4列のUNIQUEインデックスを持つ。ALTER TABLEでは制約を除去できないため、
        旧形式を検出したらテーブルを再構築して新スキーマに移行する。
        """
        try:
            row = self._conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='receipt_history'"
            ).fetchone()
        except sqlite3.Error:
            return
        if not row:
            return
        cols = {r[1] for r in self._conn.execute("PRAGMA table_info(receipt_history)")}
        table_sql = row[0] or ""
        # 旧UNIQUEインデックス(4列)が残っていないか確認
        old_index = False
        for idx_name, in self._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='receipt_history'"
        ):
            info = [r[2] for r in self._conn.execute(f"PRAGMA index_info({idx_name})")]
            unique = self._conn.execute(
                "SELECT 1 FROM pragma_index_list('receipt_history') WHERE name=? AND \"unique\"=1",
                (idx_name,),
            ).fetchone()
            if unique and "sex" not in info:
                old_index = True
        needs_rebuild = (
            "sex" not in cols or "nyugai" not in cols
            or "UNIQUE" in table_sql.upper()
            or old_index
        )
        if not needs_rebuild:
            return
        self._conn.execute("ALTER TABLE receipt_history RENAME TO receipt_history_old")
        self._conn.executescript(SCHEMA)
        select_cols = (
            "facility_code, karte_no, patient_name, birthdate, "
            + ("sex, " if "sex" in cols else "'', ")
            + ("nyugai, " if "nyugai" in cols else "'', ")
            + "shinryo_ym, receipt_no, total_points, payload, imported_at"
        )
        self._conn.execute(
            "INSERT OR IGNORE INTO receipt_history "
            "(facility_code, karte_no, patient_name, birthdate, sex, nyugai, "
            " shinryo_ym, receipt_no, total_points, payload, imported_at) "
            f"SELECT {select_cols} FROM receipt_history_old"
        )
        self._conn.execute("DROP TABLE receipt_history_old")

    def close(self):
        with self._lock:
            self._conn.close()

    # -- 保存 ---------------------------------------------------------------

    def save_claim_file(self, claim_file) -> int:
        """点検済みファイルのレセプトを履歴に保存(同一キーは上書き)"""
        saved = 0
        now = datetime.datetime.now().isoformat(timespec="seconds")
        with self._lock:
            for r in claim_file.receipts:
                ym = _normalize_ym(r)
                key = _patient_key(r)
                if not ym or not key:
                    continue
                payload = json.dumps(_receipt_payload(r), ensure_ascii=False)
                self._conn.execute(
                    """
                    INSERT INTO receipt_history
                        (facility_code, karte_no, patient_name, birthdate, sex, nyugai,
                         shinryo_ym, receipt_no, total_points, payload, imported_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (facility_code, karte_no, birthdate, sex, shinryo_ym, nyugai)
                    DO UPDATE SET
                        patient_name = excluded.patient_name,
                        receipt_no = excluded.receipt_no,
                        total_points = excluded.total_points,
                        payload = excluded.payload,
                        imported_at = excluded.imported_at
                    """,
                    (
                        claim_file.facility.facility_code,
                        key,
                        r.patient_name,
                        r.birthdate,
                        r.sex,
                        _nyugai(r),
                        ym,
                        r.receipt_no,
                        r.total_points,
                        payload,
                        now,
                    ),
                )
                saved += 1
            self._conn.commit()
        return saved

    # -- 参照 ---------------------------------------------------------------

    def past_months(
        self,
        facility_code: str,
        receipt: Receipt,
        months_back: int = 6,
    ) -> list:
        """指定レセプトの患者の過去レセプト(当月を除く直近N月)を返す。

        同一月に入院・外来など複数レセプトがある場合は1エントリに統合する。
        戻り値: [{"shinryo_ym": "202405", "items": [...], "diseases": [...],
                  "total_points": int}] 新しい月順
        """
        ym = _normalize_ym(receipt)
        key = _patient_key(receipt)
        if not ym or not key:
            return []
        base = datetime.date(int(ym[:4]), int(ym[4:6]), 1)
        floor_d = _add_months(base, -months_back)
        floor_ym = f"{floor_d.year:04d}{floor_d.month:02d}"
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT shinryo_ym, total_points, payload FROM receipt_history
                WHERE facility_code = ? AND karte_no = ? AND birthdate = ?
                  AND shinryo_ym < ? AND shinryo_ym >= ?
                ORDER BY shinryo_ym DESC
                """,
                (facility_code, key, receipt.birthdate, ym, floor_ym),
            ).fetchall()
        merged: dict = {}
        order: list = []
        for row_ym, points, payload in rows:
            data = json.loads(payload)
            if row_ym not in merged:
                merged[row_ym] = {
                    "shinryo_ym": row_ym,
                    "items": [],
                    "diseases": [],
                    "total_points": 0,
                }
                order.append(row_ym)
            m = merged[row_ym]
            m["items"].extend(data.get("items", []))
            m["diseases"].extend(data.get("diseases", []))
            m["total_points"] += points or 0
        return [merged[y] for y in order]

    def count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM receipt_history").fetchone()[0]

    def months(self) -> list:
        with self._lock:
            return [
                row[0]
                for row in self._conn.execute(
                    "SELECT DISTINCT shinryo_ym FROM receipt_history ORDER BY shinryo_ym DESC"
                )
            ]

    def clear(self):
        with self._lock:
            self._conn.execute("DELETE FROM receipt_history")
            self._conn.commit()


def _receipt_payload(r: Receipt) -> dict:
    return {
        "items": [
            {
                "rec_type": it.rec_type,
                "shinryo_shikibetsu": it.shinryo_shikibetsu,
                "code": it.code,
                "name": it.display_name,
                "count": it.total_count,
                "days": it.days_used,
            }
            for it in r.items
        ],
        "diseases": [
            {
                "code": d.code,
                "name": d.display_name,
                "start_date": d.start_date,
                "tenki": d.tenki,
                "suspected": d.is_suspected,
            }
            for d in r.diseases
        ],
    }


def _add_months(d: datetime.date, months: int) -> datetime.date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    return datetime.date(y, m, 1)
