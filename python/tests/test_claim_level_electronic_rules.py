from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from medical_fee_calculation.claim_models import CalculationLine, ClaimItemStatus, CommentInput
from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.lab_calculator import _claim_level_electronic_messages


def _line(code: str) -> CalculationLine:
    return CalculationLine(
        code=code,
        name=f"line {code}",
        points=10,
        quantity=1,
        status=ClaimItemStatus.CANDIDATE,
        reason="",
        source="medical_procedure_master",
    )


def _claim_context(procedure_codes: tuple[str, ...], comment_inputs: tuple = ()) -> SimpleNamespace:
    return SimpleNamespace(
        procedure_codes=procedure_codes,
        encounter=SimpleNamespace(service_date=date(2026, 6, 1)),
        master_sources=SimpleNamespace(electronic_fee_source_id=1, comment_source_id=1),
        comment_inputs=comment_inputs,
        history=SimpleNamespace(
            same_day_history_codes=frozenset(),
            same_week_history_codes=frozenset(),
            same_month_history_codes=frozenset(),
            procedure_history_events=(),
        ),
    )


class ClaimLevelElectronicRulesTest(unittest.TestCase):
    def _seed_exclusion(self, conn) -> None:
        conn.execute(
            """
            INSERT INTO master_sources (
                id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at
            ) VALUES (1, 'electronic_fee', 'test', 'fixture.csv', 'fixture', 'utf-8', 1, '2026-05-29T00:00:00Z')
            """
        )
        conn.execute(
            """
            INSERT INTO electronic_exclusions (
                source_id, exclusion_table, base_code, base_name, excluded_code, excluded_name, rule_kind,
                effective_from, effective_to, raw_row_json
            ) VALUES (1, 'exclusions_simultaneous', 'AAA', '処置A', 'BBB', '画像B', 'exclusive', '2024-06-01', NULL, '{}')
            """
        )
        conn.commit()

    def test_detects_exclusion_between_procedure_and_derived_line(self) -> None:
        # AAA は procedure_code、BBB は派生ライン(検査単位の判定では見えないコード)
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "master.sqlite")
            try:
                initialize_schema(conn)
                self._seed_exclusion(conn)
                messages = _claim_level_electronic_messages(
                    conn,
                    _claim_context(("AAA",)),
                    (_line("BBB"),),
                    (),
                )
            finally:
                conn.close()

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].source, "electronic_exclusion")
        self.assertIn("AAA", messages[0].message)
        self.assertIn("BBB", messages[0].message)

    def test_dedupes_against_existing_messages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "master.sqlite")
            try:
                initialize_schema(conn)
                self._seed_exclusion(conn)
                first = _claim_level_electronic_messages(conn, _claim_context(("AAA",)), (_line("BBB"),), ())
                # 同じ本文を既出メッセージとして渡すと重複出力しない
                second = _claim_level_electronic_messages(conn, _claim_context(("AAA",)), (_line("BBB"),), first)
            finally:
                conn.close()

        self.assertEqual(len(first), 1)
        self.assertEqual(second, ())

    def _seed_required_comment(self, conn) -> None:
        conn.execute(
            """
            INSERT INTO master_sources (
                id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at
            ) VALUES (1, 'comment', 'test', 'fixture.csv', 'fixture', 'utf-8', 1, '2026-05-29T00:00:00Z')
            """
        )
        conn.execute(
            """
            INSERT INTO comment_links (
                source_id, procedure_code, procedure_name, comment_code, comment_text,
                chapter, section, branch, requirement_kind, effective_from, effective_to, raw_row_json
            ) VALUES (1, 'CCC', '医学管理C', '830000001', '症状詳記が必要', NULL, NULL, NULL, 'required', '2024-06-01', NULL, '{}')
            """
        )
        conn.commit()

    def test_emits_required_comment_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "master.sqlite")
            try:
                initialize_schema(conn)
                self._seed_required_comment(conn)
                # CCC は派生ライン(procedure_codes には無い)→ claim横断で必須コメント検知
                messages = _claim_level_electronic_messages(
                    conn,
                    _claim_context((), comment_inputs=()),
                    (_line("CCC"),),
                    (),
                )
            finally:
                conn.close()
        comment_messages = [m for m in messages if m.source == "comment"]
        self.assertEqual(len(comment_messages), 1)
        self.assertIn("830000001", comment_messages[0].message)

    def test_suppresses_required_comment_when_provided(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "master.sqlite")
            try:
                initialize_schema(conn)
                self._seed_required_comment(conn)
                messages = _claim_level_electronic_messages(
                    conn,
                    _claim_context((), comment_inputs=(CommentInput(code="830000001"),)),
                    (_line("CCC"),),
                    (),
                )
            finally:
                conn.close()
        self.assertEqual([m for m in messages if m.source == "comment"], [])

    def test_no_codes_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "master.sqlite")
            try:
                initialize_schema(conn)
                self._seed_exclusion(conn)
                messages = _claim_level_electronic_messages(conn, _claim_context(()), (), ())
            finally:
                conn.close()
        self.assertEqual(messages, ())


if __name__ == "__main__":
    unittest.main()
