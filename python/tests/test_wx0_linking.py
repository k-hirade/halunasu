from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from experiments.wx0_linking import (
    build_exact_alias_index,
    evaluate_candidate_rows,
    exact_alias_candidates,
    load_master_documents,
    normalize_alias,
)


class Wx0LinkingTest(unittest.TestCase):
    def test_loads_master_documents_and_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "master.sqlite"
            conn = sqlite3.connect(db_path)
            try:
                conn.executescript(
                    """
                    CREATE TABLE master_sources (
                      id INTEGER PRIMARY KEY,
                      source_type TEXT,
                      source_version TEXT,
                      imported_at TEXT
                    );
                    CREATE TABLE medical_procedures (
                      source_id INTEGER,
                      code TEXT,
                      short_name TEXT,
                      base_name TEXT,
                      alpha_part TEXT
                    );
                    CREATE TABLE drugs (
                      source_id INTEGER,
                      code TEXT,
                      name TEXT,
                      kana TEXT,
                      base_name TEXT,
                      generic_prescription_text TEXT
                    );
                    CREATE TABLE diseases (
                      source_id INTEGER,
                      code TEXT,
                      name TEXT,
                      name_kana TEXT,
                      icd10 TEXT
                    );
                    INSERT INTO master_sources VALUES
                      (1, 'medical_procedure_master', 'v1', '2026-01-01'),
                      (2, 'drug_master', 'v1', '2026-01-01');
                    INSERT INTO medical_procedures VALUES
                      (1, '114003710', '在宅酸素療法指導管理料（その他）',
                       '在宅酸素療法指導管理料', 'C');
                    INSERT INTO drugs VALUES
                      (2, '612345678', 'テスト錠５ｍｇ', 'テストジョウ', 'テスト錠', NULL);
                    INSERT INTO diseases VALUES
                      (3, 'D001', '高血圧症', 'コウケツアツショウ', 'I10');
                    """
                )
                conn.commit()
            finally:
                conn.close()

            documents = load_master_documents(db_path)
            self.assertEqual(len(documents), 3)
            alias_index = build_exact_alias_index(documents)
            candidates = exact_alias_candidates("在宅酸素", alias_index)
            self.assertEqual(candidates[0]["code"], "114003710")
            self.assertEqual(normalize_alias("テスト錠 5mg"), "テスト錠5mg")

    def test_evaluates_candidate_ranks(self) -> None:
        queries = [
            {
                "caseId": "one",
                "specialty": "internal_medicine",
                "encounterSetting": "outpatient",
                "text": "採血",
                "expectedCodes": ["A"],
            }
        ]
        result = evaluate_candidate_rows(
            queries,
            [[{"code": "B"}, {"code": "A"}]],
        )
        self.assertEqual(result["overall"]["recallAt"]["1"], 0)
        self.assertEqual(result["overall"]["recallAt"]["5"], 1)
        self.assertEqual(result["overall"]["mrr"], 0.5)


if __name__ == "__main__":
    unittest.main()
