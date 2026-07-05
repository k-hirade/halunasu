from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.checks_api import check_lookup, resolve_diseases
from medical_fee_calculation.db import connect, initialize_schema


class ChecksApiTest(unittest.TestCase):
    def _seed(self, db_path: Path) -> None:
        conn = connect(db_path)
        try:
            initialize_schema(conn)
            conn.execute(
                "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                "VALUES (1, 'check_master', 'test', 'f', 'c', 'utf-8', 1, '2026-06-01T00:00:00Z')"
            )
            # 薬剤600の適応=病名A(男性)、禁忌=病名Z。薬剤600と601は併用禁忌。
            conn.execute(
                "INSERT INTO cc_drug_indications "
                "(source_id, drug_code, disease_code, sex, age_min, age_max, check_kubun, max_dose, max_days, tekigi, ref_range) "
                "VALUES (1,'600','A','1',0,999,'1',60,14,'','mg')"
            )
            conn.execute(
                "INSERT INTO cc_drug_dose_groups "
                "(source_id, drug_code, dosage_form, unit, group_name, disease_code, sex, age_min, age_max, ingredient_amount, target_flag, max_dose, ref_range) "
                "VALUES (1,'600','21','mg','成分X','0000000','',0,999,10,'2',100,'')"
            )
            conn.execute(
                "INSERT INTO cc_drug_contra_disease (source_id, drug_code, disease_code) VALUES (1,'600','Z')"
            )
            conn.execute(
                "INSERT INTO cc_drug_interactions (source_id, drug_a, drug_b) VALUES (1,'600','601')"
            )
            # 診療行為700の適応=病名B(疑い可)
            conn.execute(
                "INSERT INTO cc_act_indications (source_id, act_code, disease_code, sex, age_min, age_max, nyugai, utagai) "
                "VALUES (1,'700','B','',0,999,'','1')"
            )
            conn.execute("INSERT INTO diseases (source_id, code, name) VALUES (1,'A','高血圧症')")
            conn.execute("INSERT INTO diseases (source_id, code, name) VALUES (1,'Z','妊娠')")
            conn.commit()
        finally:
            conn.close()

    def test_check_lookup_returns_indication_contra_interaction_and_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)
            result = check_lookup(
                {
                    "db_path": str(db_path),
                    "drug_codes": ["600", "601"],
                    "act_codes": ["700"],
                    "disease_codes": ["A", "Z"],
                }
            )
            # 患者病名(disease_codes)を渡さなくても、適応/禁忌マスタ側の候補コードは名称化される(P1-2)
            result2 = check_lookup({"db_path": str(db_path), "drug_codes": ["600"]})

        self.assertEqual(result["drugIndications"]["600"][0]["diseaseCode"], "A")
        self.assertEqual(result["drugIndications"]["600"][0]["sex"], "1")
        self.assertEqual(result["drugDoseRules"]["600"][0]["maxDose"], 60)
        self.assertEqual(result["drugDoseRules"]["600"][0]["maxDays"], 14)
        self.assertEqual(result["drugDoseGroups"]["600"][0]["groupName"], "成分X")
        self.assertEqual(result["drugDoseGroups"]["600"][0]["ingredientAmount"], 10)
        self.assertEqual(result["drugContraDiseases"]["600"], ["Z"])
        self.assertEqual(result["drugInteractions"], [["600", "601"]])
        self.assertEqual(result["actIndications"]["700"][0]["utagai"], "1")
        self.assertEqual(result["diseaseNames"]["A"], "高血圧症")
        self.assertEqual(result2["diseaseNames"]["A"], "高血圧症")  # 適応候補
        self.assertEqual(result2["diseaseNames"]["Z"], "妊娠")      # 禁忌候補

    def test_resolve_diseases_exact_and_decompose_with_suspected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            conn = connect(db_path)
            try:
                initialize_schema(conn)
                conn.execute(
                    "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                    "VALUES (1, 'payer_check_master', 'test', 'f', 'c', 'cp932', 1, '2026-06-01T00:00:00Z')"
                )
                conn.execute("INSERT INTO diseases (source_id, code, name, effective_to) VALUES (1,'8830592','高血圧症','99999999')")
                conn.execute("INSERT INTO diseases (source_id, code, name, effective_to) VALUES (1,'2500013','気管支炎','99999999')")
                conn.execute("INSERT INTO disease_modifiers (source_id, code, name, kubun) VALUES (1,'8002','の疑い','8')")
                conn.execute("INSERT INTO disease_modifiers (source_id, code, name, kubun) VALUES (1,'4012','急性','1')")
                conn.commit()
            finally:
                conn.close()

            result = resolve_diseases({"db_path": str(db_path), "names": ["高血圧症", "急性気管支炎の疑い", "存在しない病名"]})

        resolved = result["resolved"]
        self.assertEqual(resolved["高血圧症"]["code"], "8830592")
        self.assertEqual(resolved["高血圧症"]["matchType"], "exact")
        self.assertFalse(resolved["高血圧症"]["suspected"])
        # 接頭語(急性)+基本病名(気管支炎)+接尾語(の疑い)に分解し、疑いフラグを立てる
        self.assertEqual(resolved["急性気管支炎の疑い"]["code"], "2500013")
        self.assertTrue(resolved["急性気管支炎の疑い"]["suspected"])
        self.assertEqual(resolved["存在しない病名"]["matchType"], "none")

    def test_check_lookup_empty_when_no_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)
            result = check_lookup({"db_path": str(db_path)})
        self.assertEqual(result["drugIndications"], {})
        self.assertEqual(result["drugDoseRules"], {})
        self.assertEqual(result["drugDoseGroups"], {})
        self.assertEqual(result["drugInteractions"], [])
        self.assertEqual(result["diseaseNames"], {})


if __name__ == "__main__":
    unittest.main()
