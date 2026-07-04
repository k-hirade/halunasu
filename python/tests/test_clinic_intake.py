from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.clinic_intake import build_claims


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with open(path, "w", encoding="cp932", errors="replace", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for row in rows:
            writer.writerow(row)


class ClinicIntakeTest(unittest.TestCase):
    def _setup(self, raw: Path) -> dict:
        _write_csv(raw / "patients.csv", ["pid", "sex", "age"], [["AB", "1", "68"]])
        _write_csv(
            raw / "diagnosis.csv",
            ["pid", "code", "name", "start", "tenki", "main"],
            [
                ["AB", "8830592", "高血圧症", "20260110", "1", "1"],
                ["AB", "2500013", "気管支炎の疑い", "20260901", "1", ""],
            ],
        )
        _write_csv(
            raw / "labs.csv",
            ["pid", "code", "name", "date", "count"],
            [["AB", "160008010", "末梢血液一般", "20260903", "1"]],
        )
        _write_csv(
            raw / "drug.csv",
            ["pid", "code", "name", "date", "count"],
            [["AB", "620000600", "アムロジピン", "20260903", "1"]],
        )
        return {
            "encoding": "cp932",
            "patients": {"path": "patients.csv", "columns": {"patientKey": "pid", "sex": "sex", "ageYears": "age"}},
            "diagnosis": {
                "path": "diagnosis.csv",
                "columns": {"patientKey": "pid", "code": "code", "name": "name", "startDate": "start", "tenki": "tenki", "isMain": "main"},
            },
            "orders": [
                {"path": "labs.csv", "recType": "SI", "columns": {"patientKey": "pid", "code": "code", "name": "name", "date": "date", "count": "count"}},
                {"path": "drug.csv", "recType": "IY", "columns": {"patientKey": "pid", "code": "code", "name": "name", "date": "date", "count": "count"}},
            ],
        }

    def test_builds_patient_month_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            raw = Path(tmpdir)
            intake_map = self._setup(raw)
            claims = build_claims(intake_map, raw)

        self.assertEqual(len(claims), 1)
        claim = claims[0]
        self.assertEqual(claim["claimMonth"], "2026-09")
        self.assertEqual(claim["sex"], "1")
        self.assertEqual(claim["ageYears"], 68)
        self.assertFalse(claim["isInpatient"])
        # items: 検体(SI) + 医薬品(IY)
        rec_types = sorted(i["recType"] for i in claim["items"])
        self.assertEqual(rec_types, ["IY", "SI"])
        codes = {i["code"] for i in claim["items"]}
        self.assertEqual(codes, {"160008010", "620000600"})
        # diseases: 患者の全病名が付与され、疑い判定される
        self.assertEqual(len(claim["diseases"]), 2)
        suspected = {d["name"]: d["suspected"] for d in claim["diseases"]}
        self.assertTrue(suspected["気管支炎の疑い"])
        self.assertFalse(suspected["高血圧症"])
        main = [d for d in claim["diseases"] if d["isMain"]]
        self.assertEqual(main[0]["code"], "8830592")

    def test_disease_filtered_by_claim_month(self) -> None:
        # 請求月(2026-09)より後に開始した病名は付与されない
        with tempfile.TemporaryDirectory() as tmpdir:
            raw = Path(tmpdir)
            _write_csv(raw / "patients.csv", ["pid", "sex", "age"], [["AB", "1", "68"]])
            _write_csv(
                raw / "diagnosis.csv",
                ["pid", "code", "name", "start", "tenki", "main"],
                [
                    ["AB", "8830592", "高血圧症", "20260110", "1", "1"],      # 開始 <= 請求月 → 付与
                    ["AB", "2500013", "肺炎", "20261005", "1", ""],           # 開始 > 請求月 → 除外
                ],
            )
            _write_csv(raw / "labs.csv", ["pid", "code", "date"], [["AB", "160008010", "20260903"]])
            intake_map = {
                "encoding": "cp932",
                "patients": {"path": "patients.csv", "columns": {"patientKey": "pid", "sex": "sex", "ageYears": "age"}},
                "diagnosis": {"path": "diagnosis.csv", "columns": {"patientKey": "pid", "code": "code", "name": "name", "startDate": "start", "tenki": "tenki", "isMain": "main"}},
                "orders": [{"path": "labs.csv", "recType": "SI", "columns": {"patientKey": "pid", "code": "code", "date": "date"}}],
            }
            claims = build_claims(intake_map, raw)

        self.assertEqual(len(claims), 1)
        codes = {d["code"] for d in claims[0]["diseases"]}
        self.assertIn("8830592", codes)
        self.assertNotIn("2500013", codes)  # 未来開始の病名は除外

    def test_exclude_resolved_diseases_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            raw = Path(tmpdir)
            _write_csv(raw / "patients.csv", ["pid", "sex", "age"], [["AB", "1", "68"]])
            _write_csv(
                raw / "diagnosis.csv",
                ["pid", "code", "name", "start", "tenki"],
                [
                    ["AB", "8830592", "高血圧症", "20260110", "1"],   # 継続
                    ["AB", "8834321", "妊娠", "20260101", "2"],       # 治ゆ(終了)
                ],
            )
            _write_csv(raw / "labs.csv", ["pid", "code", "date"], [["AB", "160008010", "20260903"]])
            base_map = {
                "encoding": "cp932",
                "patients": {"path": "patients.csv", "columns": {"patientKey": "pid", "sex": "sex", "ageYears": "age"}},
                "diagnosis": {"path": "diagnosis.csv", "columns": {"patientKey": "pid", "code": "code", "name": "name", "startDate": "start", "tenki": "tenki"}},
                "orders": [{"path": "labs.csv", "recType": "SI", "columns": {"patientKey": "pid", "code": "code", "date": "date"}}],
            }
            included = build_claims({**base_map, "includeResolvedDiseases": True}, raw)
            excluded = build_claims({**base_map, "includeResolvedDiseases": False}, raw)

        self.assertEqual({d["code"] for d in included[0]["diseases"]}, {"8830592", "8834321"})
        self.assertEqual({d["code"] for d in excluded[0]["diseases"]}, {"8830592"})  # 治ゆ病名は除外

    def test_missing_optional_files_ok(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            raw = Path(tmpdir)
            _write_csv(raw / "drug.csv", ["pid", "code", "date"], [["AB", "620000600", "20260903"]])
            intake_map = {
                "encoding": "cp932",
                "orders": [{"path": "drug.csv", "recType": "IY", "columns": {"patientKey": "pid", "code": "code", "date": "date"}}],
            }
            claims = build_claims(intake_map, raw)
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["items"][0]["code"], "620000600")
        self.assertEqual(claims[0]["diseases"], [])


if __name__ == "__main__":
    unittest.main()
