from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.checks_api import check_lookup, disease_act_candidates, resolve_diseases
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

    def test_check_lookup_returns_frequency_limits_and_exclusion_pairs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)
            conn = connect(db_path)
            try:
                # がん性疼痛=月1回、外来管理加算×訪問診療料の背反(両方向のうち片側)
                conn.execute(
                    "INSERT INTO electronic_frequency_limits "
                    "(source_id, procedure_code, procedure_name, limit_code, limit_name, effective_from, effective_to, raw_row_json) "
                    "VALUES (1,'113012810','がん性疼痛緩和指導管理料','131','月','2012-04-01','9999-12-31',"
                    "'[\"0\",\"113012810\",\"がん性疼痛緩和指導管理料\",\"131\",\"月\",\"1\",\"0\",\"0\",\"0\",\"0\",\"0\",\"0\",\"20120401\",\"99999999\"]')"
                )
                conn.execute(
                    "INSERT INTO electronic_exclusions "
                    "(source_id, exclusion_table, base_code, base_name, excluded_code, excluded_name, rule_kind, effective_from, effective_to, raw_row_json) "
                    "VALUES (1,'exclusions_day','114001110','在宅患者訪問診療料','112011010','外来管理加算','1','','','[]')"
                )
                # 与えたコード群に相手が居ない背反は返さない
                conn.execute(
                    "INSERT INTO electronic_exclusions "
                    "(source_id, exclusion_table, base_code, base_name, excluded_code, excluded_name, rule_kind, effective_from, effective_to, raw_row_json) "
                    "VALUES (1,'exclusions_day','114001110','在宅患者訪問診療料','199999999','無関係','1','','','[]')"
                )
                conn.commit()
            finally:
                conn.close()

            result = check_lookup(
                {
                    "db_path": str(db_path),
                    "drug_codes": [],
                    "act_codes": ["113012810", "114001110", "112011010"],
                    "disease_codes": [],
                }
            )
            limits = result["actFrequencyLimits"]
            self.assertEqual(limits["113012810"], [{"unitCode": "131", "unit": "月", "maxCount": 1}])
            exclusions = result["actExclusions"]
            self.assertEqual(len(exclusions), 1)
            self.assertEqual(exclusions[0]["baseCode"], "114001110")
            self.assertEqual(exclusions[0]["excludedCode"], "112011010")
            self.assertEqual(exclusions[0]["ruleKind"], "1")

    def test_disease_act_candidates_resolves_filters_and_groups_families(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            conn = connect(db_path)
            try:
                initialize_schema(conn)
                conn.execute(
                    "INSERT INTO master_sources "
                    "(id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                    "VALUES (1, 'payer_check_master', 'test', 'check', 'check', 'cp932', 10, '2026-06-01T00:00:00Z')"
                )
                conn.execute(
                    "INSERT INTO master_sources "
                    "(id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                    "VALUES (2, 'medical_procedure_master', 'test', 'procedure', 'procedure', 'cp932', 10, '2026-06-02T00:00:00Z')"
                )
                conn.executemany(
                    "INSERT INTO diseases (source_id, code, name, effective_to) VALUES (1,?,?, '99999999')",
                    [
                        ("D_COPD", "慢性閉塞性肺疾患"),
                        ("D_BRONCH", "気管支炎"),
                    ],
                )
                conn.execute(
                    "INSERT INTO disease_modifiers (source_id, code, name, kubun) VALUES (1,'8002','の疑い','8')"
                )
                indication_rows = [
                    ("113001810", "D_COPD", "0", 0, 999, "2", "0"),
                    ("113001910", "D_COPD", "0", 0, 999, "2", "0"),
                    ("114099910", "D_COPD", "0", 0, 999, "2", "0"),  # 加算は除外
                    ("113777710", "D_COPD", "1", 0, 999, "2", "0"),  # 男性のみ
                    ("113777810", "D_COPD", "0", 0, 17, "2", "0"),   # 小児のみ
                    ("113777910", "D_COPD", "0", 0, 999, "1", "0"),  # 入院のみ
                    ("114100010", "D_BRONCH", "0", 0, 999, "2", "1"), # 確定のみ
                    ("114100110", "D_BRONCH", "0", 0, 999, "2", "2"), # 疑いのみ
                    ("114100210", "D_BRONCH", "0", 0, 999, "2", "2"), # 期限切れ
                ]
                conn.executemany(
                    "INSERT INTO cc_act_indications "
                    "(source_id, act_code, disease_code, sex, age_min, age_max, nyugai, utagai) "
                    "VALUES (1,?,?,?,?,?,?,?)",
                    indication_rows,
                )
                procedure_rows = [
                    ("113001810", "特定疾患療養管理料（診療所）", 225, "20260601", "99999999"),
                    ("113001910", "特定疾患療養管理料（病院１００床未満）", 147, "20260601", "99999999"),
                    ("114099910", "在宅療養管理加算", 50, "20260601", "99999999"),
                    ("113777710", "男性限定管理料", 100, "20260601", "99999999"),
                    ("113777810", "小児限定管理料", 100, "20260601", "99999999"),
                    ("113777910", "入院限定管理料", 100, "20260601", "99999999"),
                    ("114100010", "気管支炎確定検査", 120, "20260601", "99999999"),
                    ("114100110", "気管支炎疑い検査", 110, "20260601", "99999999"),
                    ("114100210", "旧気管支炎検査", 90, "20250101", "20251231"),
                ]
                conn.executemany(
                    "INSERT INTO medical_procedures "
                    "(source_id, code, short_name, points, effective_from, effective_to, raw_row_json) "
                    "VALUES (2,?,?,?,?,?, '[]')",
                    procedure_rows,
                )
                conn.commit()
            finally:
                conn.close()

            result = disease_act_candidates({
                "db_path": str(db_path),
                "diagnoses": [
                    {"name": "慢性閉塞性肺疾患", "suspected": False},
                    {"name": "気管支炎の疑い", "suspected": True},
                    {"name": "存在しない病名", "suspected": False},
                ],
                "setting": "outpatient",
                "patient_age": 76,
                "patient_sex": "female",
                "service_date": "2026-06-15",
                "act_code_prefixes": ["113", "114"],
                "limit": 12,
            })

        by_family = {item["familyName"]: item for item in result["candidates"]}
        management = by_family["特定疾患療養管理料"]
        self.assertEqual(
            [item["code"] for item in management["codes"]],
            ["113001810", "113001910"],
        )
        self.assertEqual(management["matchedDiseases"], ["慢性閉塞性肺疾患"])
        self.assertIn("気管支炎疑い検査", by_family)
        all_codes = {
            code["code"]
            for candidate in result["candidates"]
            for code in candidate["codes"]
        }
        self.assertNotIn("114099910", all_codes)  # 加算
        self.assertNotIn("113777710", all_codes)  # 性別不一致
        self.assertNotIn("113777810", all_codes)  # 年齢不一致
        self.assertNotIn("113777910", all_codes)  # 入外不一致
        self.assertNotIn("114100010", all_codes)  # 疑い病名に対する確定のみ行
        self.assertNotIn("114100210", all_codes)  # 有効期間外
        self.assertEqual(result["unresolvedNames"], ["存在しない病名"])


if __name__ == "__main__":
    unittest.main()
