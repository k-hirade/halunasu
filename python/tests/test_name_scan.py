from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.name_scan import scan_names


class NameScanTest(unittest.TestCase):
    def _seed(self, db_path: Path) -> None:
        conn = connect(db_path)
        try:
            initialize_schema(conn)
            conn.execute(
                "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                "VALUES (1, 'medical_procedure_master', 'test', 'f', 'c', 'utf-8', 5, '2026-06-01T00:00:00Z')"
            )
            rows = [
                ("180000710", "傷病手当金意見書交付料", 100.0),
                ("113708610", "難病外来指導管理料２", 270.0),
                ("113000000", "指導管理料", 87.0),  # 長い名称に吸収されるべき短い名称
                ("114057970", "在宅データ提出加算", 50.0),  # 加算role
                ("111000110", "初診料", 291.0),  # 111prefix除外
            ]
            for code, name, points in rows:
                conn.execute(
                    "INSERT INTO medical_procedures "
                    "(source_id, code, short_name, base_name, points, inout_applicability, outpatient_aggregate, inpatient_aggregate, "
                    " bundle_lab_group, judgement_kind, judgement_group, specimen_comment_flag, facility_standard_codes, chapter, part, "
                    " alpha_part, section, branch, item, notice_chapter, notice_part, notice_alpha_part, notice_section, notice_branch, "
                    " notice_item, effective_from, effective_to, raw_row_json) "
                    "VALUES (1,?,?,?,?, '', '', '', '', '', '', '', '[]', '', '', '', '', '', '', '', '', '', '', '', '', '2026-06-01', '9999-12-31', '[]')",
                    (code, name, name, points),
                )
            conn.commit()
        finally:
            conn.close()

    def test_scan_matches_names_with_shadowing_and_exclusions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)
            text = (
                "S）休業に伴う傷病手当金意見書を作成・交付。\n"
                "A）難病外来指導管理料２の対象として管理中。\n"
                "P）初診料の算定。次回、在宅データ提出加算を検討。\n"
            )
            result = scan_names({"db_path": str(db_path), "text": text})
            by_code = {m["code"]: m for m in result["matches"]}

            self.assertIn("180000710", by_code)  # 名称一致
            self.assertIn("113708610", by_code)  # 長い名称
            self.assertNotIn("113000000", by_code)  # 「指導管理料」は長い名称に吸収
            self.assertNotIn("111000110", by_code)  # 111prefixは対象外
            self.assertEqual(by_code["114057970"]["role"], "addon")  # 加算はrole付きで返す(採否はNode側)
            # 位置情報は行特定(否定文脈判定)に使う
            self.assertGreaterEqual(by_code["180000710"]["index"], 0)

    def test_same_alias_multiple_codes_returns_one_ambiguous_match(self) -> None:
        """同一別名に複数コードが衝突したら、独立マッチではなく codes[] 付きの1件で返す。"""
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)
            conn = connect(db_path)
            try:
                for code, name, points in [
                    ("114003710", "在宅酸素療法指導管理料（その他）", 2400.0),
                    ("114004110", "在宅酸素療法指導管理料（チアノーゼ型先天性心疾患）", 520.0),
                ]:
                    conn.execute(
                        "INSERT INTO medical_procedures "
                        "(source_id, code, short_name, base_name, points, inout_applicability, outpatient_aggregate, inpatient_aggregate, "
                        " bundle_lab_group, judgement_kind, judgement_group, specimen_comment_flag, facility_standard_codes, chapter, part, "
                        " alpha_part, section, branch, item, notice_chapter, notice_part, notice_alpha_part, notice_section, notice_branch, "
                        " notice_item, effective_from, effective_to, raw_row_json) "
                        "VALUES (1,?,?,?,?, '', '', '', '', '', '', '', '[]', '', '', '', '', '', '', '', '', '', '', '', '', '2026-06-01', '9999-12-31', '[]')",
                        (code, name, name, points),
                    )
                conn.commit()
            finally:
                conn.close()
            result = scan_names({"db_path": str(db_path), "text": "P）在宅酸素を継続する。"})
            matches = [m for m in result["matches"] if m["matchedText"] == "在宅酸素"]
            self.assertEqual(len(matches), 1)
            match = matches[0]
            self.assertEqual(match["codeCount"], 2)
            self.assertEqual([c["code"] for c in match["codes"]], ["114003710", "114004110"])  # 点数降順
            self.assertNotIn("code", match)  # 曖昧マッチは平坦codeを持たない(自動採用防止)

    def test_scan_returns_empty_for_short_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)
            self.assertEqual(scan_names({"db_path": str(db_path), "text": "再診"}), {"matches": []})


if __name__ == "__main__":
    unittest.main()
