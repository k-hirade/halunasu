from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.api import calculate_fee_session
from medical_fee_calculation.db import connect, initialize_schema


class MasterCoverageWarningTest(unittest.TestCase):
    def _seed(self, db_path: Path) -> None:
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
                " notice_item, effective_from, effective_to, raw_row_json) "
                "VALUES (1,'113012810','がん性疼痛緩和指導管理料','',200,'','','','','','','','[]','','','','','','','','','','','','','2026-06-01','9999-12-31','[]')"
            )
            conn.commit()
        finally:
            conn.close()

    def _calculate(self, db_path: Path, service_date: str) -> dict:
        return calculate_fee_session({
            "db_path": str(db_path),
            "session": {"feeSessionId": "t", "patientId": "p", "serviceDate": service_date},
            "input": {"claimContext": {
                "record_id": "t",
                "patient": {"patient_id": "p"},
                "encounter": {"service_date": service_date, "is_outpatient": True},
                "procedure_codes": ["113012810"],
                "drug_inputs": [], "medication_orders": [], "injection_drug_inputs": [],
                "injection_orders": [], "treatment_orders": [], "imaging_orders": [],
                "material_inputs": [], "comment_inputs": [], "diagnoses": [], "clinical_text": ""
            }}
        })["calculationResult"]

    def test_out_of_range_service_date_gets_explicit_warning(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)

            out_of_range = self._calculate(db_path, "2025-01-15")
            self.assertTrue(any("マスタ適用期間外" in w for w in out_of_range["warnings"]))
            self.assertEqual(out_of_range["totalPoints"], 0)

            in_range = self._calculate(db_path, "2026-06-15")
            self.assertFalse(any("マスタ適用期間外" in w for w in in_range["warnings"]))
            self.assertEqual(in_range["totalPoints"], 200.0)


if __name__ == "__main__":
    unittest.main()
