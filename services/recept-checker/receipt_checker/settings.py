"""点検設定ストア(点検除外・ルールON/OFF)

市販ソフトの「エラー例外設定」「チェック項目カスタマイズ」に相当する。
- 点検除外: 特定の指摘(ルール×対象×患者)を「確認済み・以後表示しない」にする
- ルールスイッチ: ルール単位で点検の有効/無効を切り替える

設定は data/settings.db(SQLite)に保存され、Web UI・CLIの両方から参照される。
"""

from __future__ import annotations

import datetime
import sqlite3
import threading
from pathlib import Path
from typing import Optional

from .models import Finding

SCHEMA = """
CREATE TABLE IF NOT EXISTS exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',        -- exact=0のとき空=対象を問わない
    patient_name TEXT NOT NULL DEFAULT '',  -- exact=0のとき空=患者を問わない
    exact INTEGER NOT NULL DEFAULT 0,       -- 1=完全一致(空は空とだけ一致)
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_excl_rule ON exclusions (rule_id);
CREATE TABLE IF NOT EXISTS rule_switches (
    rule_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
);
"""


class AppSettings:
    """点検設定(スレッドセーフ)"""

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        with self._lock:
            self._conn.executescript(SCHEMA)
            # 旧スキーマ(exact列なし)からの移行
            cols = {r[1] for r in self._conn.execute("PRAGMA table_info(exclusions)")}
            if "exact" not in cols:
                self._conn.execute(
                    "ALTER TABLE exclusions ADD COLUMN exact INTEGER NOT NULL DEFAULT 0"
                )
            self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()

    # -- 点検除外 -------------------------------------------------------------

    def add_exclusion(
        self,
        rule_id: str,
        target: str = "",
        patient_name: str = "",
        reason: str = "",
        exact: bool = False,
    ) -> int:
        """点検除外を登録する。

        exact=True: 指摘の値との完全一致で照合(空は空とだけ一致)。
                    点検結果画面の「除外」ボタンはこちらを使う
                    (対象・患者が空の指摘からワイルドカード除外が生まれる事故を防ぐ)。
        exact=False: 空の項目を「問わない」として扱う(範囲除外。API/設定編集用)。
        """
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO exclusions (rule_id, target, patient_name, exact, reason, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    rule_id.strip(), target.strip(), patient_name.strip(),
                    1 if exact else 0, reason.strip(),
                    datetime.datetime.now().isoformat(timespec="seconds"),
                ),
            )
            self._conn.commit()
            return cur.lastrowid

    def remove_exclusion(self, exclusion_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM exclusions WHERE id=?", (exclusion_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def list_exclusions(self) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, rule_id, target, patient_name, exact, reason, created_at "
                "FROM exclusions ORDER BY id DESC"
            ).fetchall()
        return [
            {
                "id": r[0], "rule_id": r[1], "target": r[2],
                "patient_name": r[3], "exact": bool(r[4]),
                "reason": r[5], "created_at": r[6],
            }
            for r in rows
        ]

    def _exclusion_rules(self) -> list:
        with self._lock:
            return self._conn.execute(
                "SELECT rule_id, target, patient_name, exact FROM exclusions"
            ).fetchall()

    def filter_findings(self, findings: list) -> tuple:
        """除外設定に合致する指摘を取り除く。戻り値: (残った指摘, 除外された件数)"""
        rules = self._exclusion_rules()
        if not rules:
            return findings, 0
        kept = []
        excluded = 0
        for f in findings:
            if self._matches_any(f, rules):
                excluded += 1
            else:
                kept.append(f)
        return kept, excluded

    @staticmethod
    def _matches_any(f: Finding, rules: list) -> bool:
        for rule_id, target, patient, exact in rules:
            if f.rule_id != rule_id:
                continue
            if exact:
                # 完全一致(空は空とだけ一致): 指摘1件単位の除外
                if f.target != target or f.patient_name != patient:
                    continue
            else:
                # 範囲除外: 空の項目は「問わない」
                if target and f.target != target:
                    continue
                if patient and f.patient_name != patient:
                    continue
            return True
        return False

    # -- ルールスイッチ ---------------------------------------------------------

    def disabled_rule_ids(self) -> set:
        with self._lock:
            rows = self._conn.execute(
                "SELECT rule_id FROM rule_switches WHERE enabled=0"
            ).fetchall()
        return {r[0] for r in rows}

    def set_rule_enabled(self, rule_id: str, enabled: bool):
        with self._lock:
            self._conn.execute(
                "INSERT INTO rule_switches (rule_id, enabled) VALUES (?, ?) "
                "ON CONFLICT (rule_id) DO UPDATE SET enabled=excluded.enabled",
                (rule_id, 1 if enabled else 0),
            )
            self._conn.commit()
