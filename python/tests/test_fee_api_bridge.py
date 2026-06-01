from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.api import build_claim_payload, calculate_fee_session
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

    def test_build_claim_payload_uses_session_detail_input(self) -> None:
        payload = build_claim_payload(
            {
                "feeSessionId": "fee_advanced",
                "patientId": "pat_001",
                "serviceDate": "2026-05-28",
                "setting": "outpatient",
                "claimContext": {
                    "record_id": "legacy-claim-1",
                    "material_inputs": [{"code": "710000001", "quantity": 1}],
                },
                "calculationOptions": {
                    "comment_inputs": [{"code": "840000001", "text": "コメント"}],
                },
            },
            {},
        )

        self.assertEqual(payload["record_id"], "legacy-claim-1")
        self.assertEqual(payload["material_inputs"][0]["code"], "710000001")

        payload = build_claim_payload(
            {
                "feeSessionId": "fee_options",
                "patientId": "pat_001",
                "serviceDate": "2026-05-28",
                "setting": "outpatient",
                "orders": [
                    {
                        "orderType": "material",
                        "standardCode": "710000001",
                        "quantity": 2,
                    }
                ],
                "calculationOptions": {
                    "facility_standard_keys": ["検体検査管理加算1"],
                },
            },
            {
                "calculationOptions": {
                    "comment_inputs": [{"code": "840000001", "text": "コメント"}],
                }
            },
        )

        self.assertEqual(payload["material_inputs"][0]["code"], "710000001")
        self.assertEqual(payload["material_inputs"][0]["quantity"], "2")
        self.assertEqual(payload["facility_standard_keys"], ["検体検査管理加算1"])
        self.assertEqual(payload["comment_inputs"][0]["code"], "840000001")


if __name__ == "__main__":
    unittest.main()
