from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.api import calculate_fee_session
from medical_fee_calculation.db import connect, initialize_schema


class FeeApiBridgeTest(unittest.TestCase):
    def test_calculates_fee_session_with_python_engine(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            conn = connect(db_path)
            try:
                initialize_schema(conn)
                conn.execute(
                    """
                    INSERT INTO master_sources (
                        id,
                        source_type,
                        source_version,
                        raw_path,
                        checksum_sha256,
                        encoding,
                        row_count,
                        imported_at
                    )
                    VALUES (1, 'medical_procedure_master', 'test', 'fixture.csv', 'fixture', 'utf-8', 1, '2026-05-29T00:00:00Z')
                    """
                )
                conn.execute(
                    """
                    INSERT INTO medical_procedures (
                        source_id,
                        code,
                        short_name,
                        points,
                        effective_from,
                        effective_to,
                        raw_row_json
                    )
                    VALUES (1, '160000410', '血液検査', 88, '2024-06-01', NULL, '{}')
                    """
                )
                conn.commit()
            finally:
                conn.close()

            result = calculate_fee_session(
                {
                    "db_path": str(db_path),
                    "session": {
                        "feeSessionId": "fee_001",
                        "patientId": "pat_001",
                        "patientRef": "P-001",
                        "serviceDate": "2026-05-28",
                        "setting": "outpatient",
                        "facilitySnapshot": {
                            "medicalInstitutionCode": "0410001",
                            "regionalBureau": "tohoku",
                        },
                        "orders": [
                            {
                                "orderType": "procedure",
                                "standardCode": "160000410",
                                "quantity": 1,
                            }
                        ],
                    },
                    "input": {},
                }
            )

        calculation = result["calculationResult"]
        self.assertEqual(calculation["provider"], "medical_fee_calculation")
        self.assertEqual(calculation["totalPoints"], 88)
        self.assertEqual(calculation["lineItems"][0]["code"], "160000410")


if __name__ == "__main__":
    unittest.main()
