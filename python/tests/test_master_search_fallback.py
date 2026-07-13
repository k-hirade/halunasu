from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.master_search import search_master


class MasterSearchFallbackTest(unittest.TestCase):
    def _seed(self, db_path: Path) -> None:
        conn = connect(db_path)
        try:
            initialize_schema(conn)
            conn.execute(
                "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
                "VALUES (1, 'medical_procedure_master', 'test', 'f', 'c', 'utf-8', 2, '2026-06-01T00:00:00Z')"
            )
            for code, name in [("180000710", "傷病手当金意見書交付料"), ("114001110", "在宅患者訪問診療料")]:
                conn.execute(
                    "INSERT INTO medical_procedures "
                    "(source_id, code, short_name, base_name, points, inout_applicability, outpatient_aggregate, inpatient_aggregate, "
                    " bundle_lab_group, judgement_kind, judgement_group, specimen_comment_flag, facility_standard_codes, chapter, part, "
                    " alpha_part, section, branch, item, notice_chapter, notice_part, notice_alpha_part, notice_section, notice_branch, "
                    " notice_item, effective_from, effective_to, raw_row_json) "
                    "VALUES (1,?,?,?,100, '', '', '', '', '', '', '', '[]', '', '', '', '', '', '', '', '', '', '', '', '', '2026-06-01', '9999-12-31', '[]')",
                    (code, name, name),
                )
            conn.commit()
        finally:
            conn.close()

    def test_composite_query_falls_back_to_noun_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            self._seed(db_path)
            # 全文一致では0件になる複合表現でも、名詞トークンで解決される
            result = search_master({
                "db_path": str(db_path),
                "type": "procedure",
                "query": "傷病手当金意見書 作成・交付",
                "limit": 5,
            })
            self.assertEqual([item["code"] for item in result["items"]], ["180000710"])

            # 助詞で繋がる複合語もサブトークンで解決される
            result2 = search_master({
                "db_path": str(db_path),
                "type": "procedure",
                "query": "在宅医療の訪問診療",
                "limit": 5,
            })
            self.assertIn("114001110", [item["code"] for item in result2["items"]])


if __name__ == "__main__":
    unittest.main()
