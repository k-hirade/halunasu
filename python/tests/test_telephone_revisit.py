from __future__ import annotations

import sqlite3
import unittest
from datetime import date

from medical_fee_calculation.claim_batch import parse_claim_context_payload
from medical_fee_calculation.claim_models import (
    CalculationLine,
    ClaimItemStatus,
    OutpatientBasicFeeKind,
    OutpatientBasicFeeOptionContext,
    OutpatientVisitKind,
    TelephoneEligibilityContext,
)
from medical_fee_calculation.db import initialize_schema
from medical_fee_calculation.outpatient_basic import (
    calculate_outpatient_basic_derived_add_ons,
    calculate_outpatient_basic_fee,
    calculate_outpatient_management_add_on,
)


class TelephoneRevisitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        initialize_schema(self.conn)
        cursor = self.conn.execute(
            """
            INSERT INTO master_sources (
                source_type, source_version, published_at, raw_path,
                checksum_sha256, encoding, row_count, imported_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "medical_procedure",
                "test-2026-06",
                "2026-06-01",
                "test.csv",
                "telephone-revisit-test",
                "utf-8",
                6,
                "2026-07-23T00:00:00Z",
            ),
        )
        self.source_id = int(cursor.lastrowid)
        for code, name, points in (
            ("112007950", "電話等再診料", 76),
            ("112011010", "外来管理加算", 52),
            ("112000970", "乳幼児加算（再診）", 38),
            ("112015770", "明細書発行体制等加算", 1),
            ("180725810", "外来・在宅ベースアップ評価料（１）２（再診時等）", 4),
            ("180820010", "物価対応料１（再診時等）ロ", 2),
        ):
            self.conn.execute(
                """
                INSERT INTO medical_procedures (
                    source_id, code, short_name, points, effective_from, raw_row_json
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (self.source_id, code, name, points, "2026-06-01", "{}"),
            )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    def eligible_context(self) -> OutpatientBasicFeeOptionContext:
        return OutpatientBasicFeeOptionContext(
            fee_kind=OutpatientBasicFeeKind.REVISIT,
            visit_kind=OutpatientVisitKind.TELEPHONE_REVISIT,
            telephone_eligibility=TelephoneEligibilityContext(
                established_patient=True,
                patient_initiated=True,
                instruction_given=True,
                scheduled_management=False,
            ),
        )

    def test_selects_telephone_revisit_only_when_all_eligibility_is_confirmed(self) -> None:
        result = calculate_outpatient_basic_fee(
            self.conn,
            (),
            date(2026, 7, 23),
            self.eligible_context(),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["112007950"])
        self.assertEqual(result.messages, ())

    def test_unknown_or_ineligible_fact_does_not_fall_back_to_normal_revisit(self) -> None:
        contexts = (
            TelephoneEligibilityContext(
                established_patient=None,
                patient_initiated=True,
                instruction_given=True,
                scheduled_management=False,
            ),
            TelephoneEligibilityContext(
                established_patient=True,
                patient_initiated=True,
                instruction_given=True,
                scheduled_management=True,
            ),
        )
        for eligibility in contexts:
            with self.subTest(eligibility=eligibility):
                result = calculate_outpatient_basic_fee(
                    self.conn,
                    (),
                    date(2026, 7, 23),
                    OutpatientBasicFeeOptionContext(
                        fee_kind=OutpatientBasicFeeKind.REVISIT,
                        visit_kind=OutpatientVisitKind.TELEPHONE_REVISIT,
                        telephone_eligibility=eligibility,
                    ),
                    is_outpatient=True,
                    source_id=self.source_id,
                )
                self.assertEqual(result.lines, ())
                self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)
                self.assertEqual(result.messages[0].code, "112007950")

    def test_allows_source_backed_add_ons_and_suppresses_outpatient_management(self) -> None:
        telephone_line = CalculationLine(
            code="112007950",
            name="電話等再診料",
            points=76,
            quantity=1,
            status=ClaimItemStatus.CANDIDATE,
            reason="test",
            source="outpatient_basic_fee",
        )
        add_ons = calculate_outpatient_basic_derived_add_ons(
            self.conn,
            (),
            date(2026, 7, 23),
            is_outpatient=True,
            existing_lines=(telephone_line,),
            facility_standard_keys={"base_up_hyoka_1", "meisaisho_hakko_taisei"},
            patient_age_years=4,
            source_id=self.source_id,
        )
        management = calculate_outpatient_management_add_on(
            self.conn,
            (),
            date(2026, 7, 23),
            OutpatientBasicFeeOptionContext(
                **{
                    **self.eligible_context().__dict__,
                    "management_explanation_performed": True,
                }
            ),
            is_outpatient=True,
            existing_lines=(telephone_line,),
            source_id=self.source_id,
        )

        self.assertEqual(
            {line.code for line in add_ons.lines},
            {"180820010", "180725810", "112015770", "112000970"},
        )
        self.assertEqual(management.lines, ())

    def test_batch_contract_preserves_nullable_telephone_eligibility(self) -> None:
        context = parse_claim_context_payload(
            {
                "encounter": {
                    "service_date": "2026-07-23",
                    "is_outpatient": True,
                },
                "procedure_codes": [],
                "outpatient_basic": {
                    "fee_kind": "revisit",
                    "visit_kind": "telephone_revisit",
                    "telephone_eligibility": {
                        "established_patient": None,
                        "patient_initiated": True,
                        "instruction_given": True,
                        "scheduled_management": False,
                    },
                },
            },
            conn=self.conn,
        )

        self.assertEqual(context.outpatient_basic.visit_kind, OutpatientVisitKind.TELEPHONE_REVISIT)
        self.assertIsNone(context.outpatient_basic.telephone_eligibility.established_patient)
        self.assertTrue(context.outpatient_basic.telephone_eligibility.patient_initiated)


if __name__ == "__main__":
    unittest.main()
