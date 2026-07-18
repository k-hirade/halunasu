from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from medical_fee_calculation.claim_adjustments import apply_electronic_consistency
from medical_fee_calculation.claim_batch import _parse_procedure_history_events
from medical_fee_calculation.claim_models import CalculationLine, ClaimItemStatus
from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.electronic_rules import (
    ElectronicRuleContext,
    ProcedureHistoryEvent,
    check_electronic_rules,
)
from medical_fee_calculation.lab_calculator import _claim_level_electronic_messages


def _line(code: str, *, quantity: float = 1) -> CalculationLine:
    return CalculationLine(
        code=code,
        name=f"行{code}",
        points=100,
        quantity=quantity,
        status=ClaimItemStatus.CONFIRMED,
        reason="",
        source="test",
    )


class ElectronicFrequencyLimitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.conn = connect(Path(self.tmp.name) / "master.sqlite")
        self.addCleanup(self.conn.close)
        initialize_schema(self.conn)
        self.conn.execute(
            """
            INSERT INTO master_sources (
                id, source_type, source_version, raw_path, checksum_sha256,
                encoding, row_count, imported_at
            ) VALUES (1, 'electronic_fee', 'test', 'fixture.csv', 'fixture',
                      'utf-8', 5, '2026-06-01T00:00:00Z')
            """
        )
        self._insert_limit("WEEK3", "週3回", "121", "週", 3)
        self._insert_limit("WEEK1", "週1回", "121", "週", 1)
        self._insert_limit("DAY1", "日1回", "111", "日", 1)
        self._insert_limit("ZERO", "回数情報なし", "121", "週", 0)
        self.conn.commit()

    def _insert_limit(
        self,
        code: str,
        name: str,
        limit_code: str,
        limit_name: str,
        limit_count: int,
    ) -> None:
        raw = ["0", code, name, limit_code, limit_name, str(limit_count)]
        raw.extend(["0"] * 6)
        raw.extend(["20260601", "99999999"])
        self.conn.execute(
            """
            INSERT INTO electronic_frequency_limits (
                source_id, procedure_code, procedure_name, limit_code, limit_name,
                effective_from, effective_to, raw_row_json
            ) VALUES (1, ?, ?, ?, ?, '2026-06-01', '9999-12-31', ?)
            """,
            (code, name, limit_code, limit_name, json.dumps(raw, ensure_ascii=False)),
        )

    def _check(
        self,
        code: str,
        *,
        service_date: date = date(2026, 6, 10),
        events: tuple[ProcedureHistoryEvent, ...] = (),
        same_week_codes: frozenset[str] = frozenset(),
        same_day_codes: frozenset[str] = frozenset(),
        quantity: float | None = None,
        multi_day_claim: bool = False,
    ):
        quantities = {} if quantity is None else {code: quantity}
        return check_electronic_rules(
            self.conn,
            [code],
            ElectronicRuleContext(
                service_date=service_date,
                source_id=1,
                procedure_history_events=events,
                same_week_history_codes=same_week_codes,
                same_day_history_codes=same_day_codes,
                current_code_quantities=quantities,
                multi_day_claim=multi_day_claim,
            ),
        )

    def test_weekly_limit_allows_second_of_three_occurrences(self) -> None:
        result = self._check(
            "WEEK3",
            events=(ProcedureHistoryEvent("WEEK3", date(2026, 6, 8)),),
        )

        self.assertEqual(result.frequency_limits[0].limit_count, 3)
        self.assertEqual(result.frequency_limit_breaches, ())
        adjusted, messages = apply_electronic_consistency(
            (_line("WEEK3"),),
            result,
        )
        self.assertFalse(adjusted[0].excluded_from_total)
        self.assertEqual(messages, ())

    def test_weekly_limit_demotes_fourth_occurrence(self) -> None:
        result = self._check(
            "WEEK3",
            events=(
                ProcedureHistoryEvent("WEEK3", date(2026, 6, 9), quantity=3),
            ),
        )

        self.assertEqual(len(result.frequency_limit_breaches), 1)
        breach = result.frequency_limit_breaches[0]
        self.assertTrue(breach.occurrence_count_known)
        self.assertEqual(breach.history_occurrences, 3)
        self.assertEqual(breach.current_quantity, 1)
        adjusted, messages = apply_electronic_consistency(
            (_line("WEEK3"),),
            result,
        )
        self.assertTrue(adjusted[0].excluded_from_total)
        self.assertIn("上限3回", messages[0].message)
        self.assertIn("期間内履歴3回", messages[0].message)

    def test_week_uses_sunday_to_saturday_calendar_boundary(self) -> None:
        result = self._check(
            "WEEK1",
            service_date=date(2026, 6, 14),
            events=(ProcedureHistoryEvent("WEEK1", date(2026, 6, 7)),),
        )

        self.assertEqual(result.frequency_limit_breaches, ())

    def test_set_based_history_warns_but_does_not_demote(self) -> None:
        result = self._check(
            "WEEK3",
            same_week_codes=frozenset({"WEEK3"}),
        )

        self.assertEqual(len(result.frequency_limit_breaches), 1)
        self.assertFalse(result.frequency_limit_breaches[0].occurrence_count_known)
        adjusted, messages = apply_electronic_consistency(
            (_line("WEEK3"),),
            result,
        )
        self.assertFalse(adjusted[0].excluded_from_total)
        self.assertEqual(messages, ())

    def test_set_based_history_demotes_when_lower_bound_proves_breach(self) -> None:
        result = self._check(
            "DAY1",
            same_day_codes=frozenset({"DAY1"}),
        )

        self.assertEqual(len(result.frequency_limit_breaches), 1)
        breach = result.frequency_limit_breaches[0]
        self.assertFalse(breach.occurrence_count_known)
        self.assertTrue(breach.limit_exceeded_certain)
        adjusted, messages = apply_electronic_consistency(
            (_line("DAY1"),),
            result,
        )
        self.assertTrue(adjusted[0].excluded_from_total)
        self.assertIn("期間内履歴1以上", messages[0].message)

    def test_set_based_lower_bound_combines_with_current_quantity(self) -> None:
        result = self._check(
            "WEEK3",
            same_week_codes=frozenset({"WEEK3"}),
            quantity=3,
        )

        breach = result.frequency_limit_breaches[0]
        self.assertTrue(breach.limit_exceeded_certain)
        adjusted, _messages = apply_electronic_consistency(
            (_line("WEEK3", quantity=3),),
            result,
        )
        self.assertTrue(adjusted[0].excluded_from_total)

    def test_daily_limit_demotes_second_same_day_occurrence(self) -> None:
        result = self._check(
            "DAY1",
            events=(ProcedureHistoryEvent("DAY1", date(2026, 6, 10)),),
        )

        self.assertEqual(len(result.frequency_limit_breaches), 1)
        adjusted, _messages = apply_electronic_consistency(
            (_line("DAY1"),),
            result,
        )
        self.assertTrue(adjusted[0].excluded_from_total)

    def test_multi_day_claim_skips_current_quantity_only_breach(self) -> None:
        result = self._check(
            "DAY1",
            quantity=12,
            multi_day_claim=True,
        )

        self.assertEqual(result.frequency_limit_breaches, ())
        adjusted, messages = apply_electronic_consistency(
            (_line("DAY1", quantity=12),),
            result,
        )
        self.assertFalse(adjusted[0].excluded_from_total)
        self.assertEqual(messages, ())

    def test_single_day_current_quantity_only_breach_warns_without_demotion(self) -> None:
        result = self._check("DAY1", quantity=2)

        self.assertEqual(len(result.frequency_limit_breaches), 1)
        breach = result.frequency_limit_breaches[0]
        self.assertEqual(breach.matched_from, "current_claim_quantity")
        self.assertTrue(breach.occurrence_count_known)
        self.assertFalse(breach.limit_exceeded_certain)
        adjusted, messages = apply_electronic_consistency(
            (_line("DAY1", quantity=2),),
            result,
        )
        self.assertFalse(adjusted[0].excluded_from_total)
        self.assertEqual(messages, ())

    def test_multi_day_claim_keeps_history_based_demotion(self) -> None:
        result = self._check(
            "WEEK3",
            events=(ProcedureHistoryEvent("WEEK3", date(2026, 6, 9), quantity=3),),
            multi_day_claim=True,
        )

        self.assertEqual(len(result.frequency_limit_breaches), 1)
        self.assertTrue(result.frequency_limit_breaches[0].limit_exceeded_certain)
        adjusted, _messages = apply_electronic_consistency(
            (_line("WEEK3"),),
            result,
        )
        self.assertTrue(adjusted[0].excluded_from_total)

    def test_zero_limit_count_does_not_create_event_based_breach(self) -> None:
        result = self._check(
            "ZERO",
            events=(ProcedureHistoryEvent("ZERO", date(2026, 6, 9)),),
        )

        self.assertEqual(result.frequency_limits[0].limit_count, 0)
        self.assertEqual(result.frequency_limit_breaches, ())

    def test_claim_level_aggregates_same_code_line_quantities(self) -> None:
        claim_context = SimpleNamespace(
            procedure_codes=("WEEK3",),
            encounter=SimpleNamespace(service_date=date(2026, 6, 10), is_outpatient=True),
            inpatient_basic=SimpleNamespace(basic_fee_days=1),
            master_sources=SimpleNamespace(
                electronic_fee_source_id=1,
                comment_source_id=None,
            ),
            comment_inputs=(),
            history=SimpleNamespace(
                same_day_history_codes=frozenset(),
                same_week_history_codes=frozenset(),
                same_month_history_codes=frozenset(),
                procedure_history_events=(),
            ),
        )

        messages, rules = _claim_level_electronic_messages(
            self.conn,
            claim_context,
            (_line("WEEK3", quantity=2), _line("WEEK3", quantity=2)),
            (),
        )

        self.assertIsNotNone(rules)
        self.assertEqual(len(rules.frequency_limit_breaches), 1)
        self.assertEqual(rules.frequency_limit_breaches[0].current_quantity, 4)
        self.assertEqual(rules.frequency_limit_breaches[0].matched_from, "current_claim_quantity")
        self.assertFalse(rules.frequency_limit_breaches[0].limit_exceeded_certain)
        self.assertIn("当該請求内の数量4回", messages[0].message)
        self.assertIn("複数部位等の正当な理由", messages[0].message)

    def test_history_event_parser_preserves_quantity_and_defaults_to_one(self) -> None:
        events = _parse_procedure_history_events([
            {"procedure_code": "WEEK3", "service_date": "2026-06-09", "quantity": 2.5},
            {"procedure_code": "DAY1", "service_date": "2026-06-10"},
        ])

        self.assertEqual(events[0].quantity, 2.5)
        self.assertEqual(events[1].quantity, 1)


if __name__ == "__main__":
    unittest.main()
