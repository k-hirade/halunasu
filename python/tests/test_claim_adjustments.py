from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from medical_fee_calculation.claim_adjustments import (
    apply_age_range_guard,
    apply_electronic_consistency,
    apply_notification_age_addons,
)
from medical_fee_calculation.claim_models import CalculationLine, ClaimItemStatus
from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.electronic_rules import (
    BundleHit,
    ElectronicRuleResult,
    ExclusionHit,
    FrequencyLimitBreach,
)


def _line(code: str, name: str = "", points: float = 100, status=ClaimItemStatus.CONFIRMED) -> CalculationLine:
    return CalculationLine(
        code=code, name=name or f"行{code}", points=points, quantity=1,
        status=status, reason="", source="test",
    )


def _rules(exclusions=(), breaches=(), bundles=()) -> ElectronicRuleResult:
    return ElectronicRuleResult(
        bundles=tuple(bundles),
        exclusions=tuple(exclusions),
        frequency_limits=(),
        frequency_limit_breaches=tuple(breaches),
        required_comments=(),
    )


class ElectronicConsistencyTest(unittest.TestCase):
    def test_exclusion_demotes_loser_by_rule_kind(self) -> None:
        lines = (_line("A", "処置A", 100), _line("B", "処置B", 300))
        # rule_kind '2' = ②(excluded=B)を算定 → ①(A)を降格
        adjusted, messages = apply_electronic_consistency(lines, _rules(exclusions=[
            ExclusionHit(source_id=1, scope="same_day", base_code="A", base_name="処置A",
                         excluded_code="B", excluded_name="処置B", rule_kind="2", matched_from="current"),
        ]))
        self.assertTrue(adjusted[0].excluded_from_total)
        self.assertEqual(adjusted[0].status, ClaimItemStatus.NEEDS_REVIEW)
        self.assertFalse(adjusted[1].excluded_from_total)
        self.assertEqual(sum(l.total_points for l in adjusted if not l.excluded_from_total), 300)
        self.assertEqual(len(messages), 1)

    def test_exclusion_kind3_demotes_lower_points(self) -> None:
        lines = (_line("A", points=100), _line("B", points=300))
        adjusted, _ = apply_electronic_consistency(lines, _rules(exclusions=[
            ExclusionHit(source_id=1, scope="simultaneous", base_code="A", base_name="A",
                         excluded_code="B", excluded_name="B", rule_kind="3", matched_from="current"),
        ]))
        self.assertTrue(adjusted[0].excluded_from_total)  # 低い方(A)が降格
        self.assertFalse(adjusted[1].excluded_from_total)

    def test_history_scoped_exclusion_is_not_demoted(self) -> None:
        lines = (_line("A"), _line("B"))
        adjusted, messages = apply_electronic_consistency(lines, _rules(exclusions=[
            ExclusionHit(source_id=1, scope="same_month", base_code="A", base_name="A",
                         excluded_code="B", excluded_name="B", rule_kind="1", matched_from="history"),
        ]))
        self.assertFalse(any(l.excluded_from_total for l in adjusted))
        self.assertEqual(messages, ())

    def test_frequency_breach_demotes_current_line(self) -> None:
        lines = (_line("C", "がん性疼痛緩和指導管理料", 200),)
        adjusted, messages = apply_electronic_consistency(lines, _rules(breaches=[
            FrequencyLimitBreach(source_id=1, procedure_code="C", procedure_name="がん性疼痛緩和指導管理料",
                                 limit_code="131", limit_name="月", scope="same_month",
                                 matched_from="history", matched_service_date=date(2026, 6, 3)),
        ]))
        self.assertTrue(adjusted[0].excluded_from_total)
        self.assertIn("算定回数上限", messages[0].message)

    def test_bundle_demotes_bundled_line(self) -> None:
        lines = (_line("BASE", "基本項目", 500), _line("INC", "包括対象", 120))
        adjusted, _ = apply_electronic_consistency(lines, _rules(bundles=[
            BundleHit(source_id=1, base_code="BASE", base_name="基本項目",
                      bundle_group_code="G1", bundled_code="INC", bundled_name="包括対象", applicability=""),
        ]))
        self.assertFalse(adjusted[0].excluded_from_total)
        self.assertTrue(adjusted[1].excluded_from_total)


class AgeMechanismsTest(unittest.TestCase):
    def _seed(self, db_path: Path) -> None:
        conn = connect(db_path)
        try:
            initialize_schema(conn)
            conn.execute(
                "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                "VALUES (1, 'medical_procedure_master', 'test', 'f', 'c', 'utf-8', 3, '2026-06-01T00:00:00Z')"
            )
            rows = [
                # 親: がん性疼痛(区分B001-22相当のグループ)
                ("113012810", "がん性疼痛緩和指導管理料", 200, "0", "00", "00"),
                # 注加算: 15歳未満 小児加算
                ("113012970", "小児加算（がん性疼痛緩和指導管理料）（１５歳未満）", 50, "1", "00", "15"),
                # 年齢限定の独立項目: 6歳未満のみ
                ("160099999", "乳幼児検査（６歳未満）", 120, "0", "00", "06"),
            ]
            for code, name, points, addon, age_min, age_max in rows:
                conn.execute(
                    "INSERT INTO medical_procedures "
                    "(source_id, code, short_name, base_name, points, inout_applicability, outpatient_aggregate, inpatient_aggregate, "
                    " bundle_lab_group, judgement_kind, judgement_group, specimen_comment_flag, facility_standard_codes, chapter, part, "
                    " alpha_part, section, branch, item, notice_chapter, notice_part, notice_alpha_part, notice_section, notice_branch, "
                    " notice_item, effective_from, effective_to, raw_row_json, notification_addon_flag, age_min_code, age_max_code) "
                    "VALUES (1,?,?,?,?, '', '', '', '', '', '', '', '[]', '2', '01', '', '001', '00', '022', '', '', '', '', '', '', "
                    "'2026-06-01', '9999-12-31', '[]', ?, ?, ?)",
                    (code, name, name, points, addon, age_min, age_max),
                )
            conn.commit()
        finally:
            conn.close()

    def test_age_addon_added_for_matching_child(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "m.sqlite"
            self._seed(db_path)
            conn = connect(db_path)
            try:
                initialize_schema(conn)
                lines = (_line("113012810", "がん性疼痛緩和指導管理料", 200),)
                added, messages = apply_notification_age_addons(
                    conn, lines, patient_age_years=10, service_date=date(2026, 6, 15))
                self.assertEqual([l.code for l in added], ["113012970"])
                self.assertEqual(added[0].points, 50)
                self.assertIn("自動付与", messages[0].message)

                # 年齢外(20歳)は付与しない
                none_added, _ = apply_notification_age_addons(
                    conn, lines, patient_age_years=20, service_date=date(2026, 6, 15))
                self.assertEqual(none_added, ())

                # 年齢不明は付与しない
                unknown, _ = apply_notification_age_addons(
                    conn, lines, patient_age_years=None, service_date=date(2026, 6, 15))
                self.assertEqual(unknown, ())
            finally:
                conn.close()

    def test_age_range_guard_demotes_out_of_range_line(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "m.sqlite"
            self._seed(db_path)
            conn = connect(db_path)
            try:
                initialize_schema(conn)
                lines = (_line("160099999", "乳幼児検査（６歳未満）", 120),)
                adjusted, messages = apply_age_range_guard(conn, lines, patient_age_years=40)
                self.assertTrue(adjusted[0].excluded_from_total)
                self.assertIn("年齢条件外", messages[0].message)

                in_range, no_msg = apply_age_range_guard(conn, lines, patient_age_years=3)
                self.assertFalse(in_range[0].excluded_from_total)
                self.assertEqual(no_msg, ())
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()


class KizamiTest(unittest.TestCase):
    def test_kizami_total_points_formula(self) -> None:
        from medical_fee_calculation.claim_adjustments import kizami_total_points
        # 人工呼吸: 302点、30分超300分まで30分毎+50点
        self.assertEqual(kizami_total_points(302, 20, kizami_min=30, kizami_max=300, kizami_unit=30, kizami_points=50), 302)
        self.assertEqual(kizami_total_points(302, 90, kizami_min=30, kizami_max=300, kizami_unit=30, kizami_points=50), 402)
        self.assertEqual(kizami_total_points(302, 31, kizami_min=30, kizami_max=300, kizami_unit=30, kizami_points=50), 352)  # 端数切り上げ
        self.assertEqual(kizami_total_points(302, 999, kizami_min=30, kizami_max=300, kizami_unit=30, kizami_points=50), 302 + 9 * 50)  # 上限で頭打ち

    def test_kizami_evaluation_notice_and_recalculation(self) -> None:
        from medical_fee_calculation.claim_adjustments import apply_kizami_evaluation
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "m.sqlite"
            conn = connect(db_path)
            try:
                initialize_schema(conn)
                conn.execute(
                    "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                    "VALUES (1, 'medical_procedure_master', 'test', 'f', 'c', 'utf-8', 1, '2026-06-01T00:00:00Z')"
                )
                conn.execute(
                    "INSERT INTO medical_procedures "
                    "(source_id, code, short_name, base_name, points, inout_applicability, outpatient_aggregate, inpatient_aggregate, "
                    " bundle_lab_group, judgement_kind, judgement_group, specimen_comment_flag, facility_standard_codes, chapter, part, "
                    " alpha_part, section, branch, item, notice_chapter, notice_part, notice_alpha_part, notice_section, notice_branch, "
                    " notice_item, effective_from, effective_to, raw_row_json, kizami_flag, kizami_min, kizami_max, kizami_unit, kizami_points) "
                    "VALUES (1,'140009310','人工呼吸','人工呼吸',302,'','','','','','','','[]','','','','','','','','','','','','','2026-06-01','9999-12-31','[]','1',30,300,30,50)"
                )
                conn.commit()
                lines = (_line("140009310", "人工呼吸", 302),)

                # 数量なし → 未評価の明示
                _same, notices = apply_kizami_evaluation(conn, lines)
                self.assertEqual(len(notices), 1)
                self.assertIn("きざみ未評価", notices[0].message)

                # 数量あり → 再計算
                adjusted, applied = apply_kizami_evaluation(conn, lines, kizami_quantities={"140009310": 90})
                self.assertEqual(adjusted[0].total_points, 402)
                self.assertIn("きざみ点数適用", applied[0].message)
            finally:
                conn.close()
