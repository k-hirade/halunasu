from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from experiments.wx0_entity_types import build_entity_types


class Wx0EntityTypesTest(unittest.TestCase):
    def test_builds_closed_types_from_current_master_sections(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path = root / "master.sqlite"
            schema_path = root / "axes.json"
            schema_path.write_text(json.dumps({"properties": {}}), encoding="utf-8")
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
                      chapter TEXT,
                      alpha_part TEXT
                    );
                    INSERT INTO master_sources
                      VALUES (1, 'medical_procedure_master', '2026-06-15', '2026-06-15');
                    INSERT INTO medical_procedures VALUES (1, '2', 'D');
                    INSERT INTO medical_procedures VALUES (1, '2', 'D');
                    INSERT INTO medical_procedures VALUES (1, '2', 'E');
                    INSERT INTO medical_procedures VALUES (1, '6', '-');
                    """
                )
                conn.commit()
            finally:
                conn.close()

            artifact = build_entity_types(db_path, schema_path)
            self.assertEqual(
                artifact["source"]["medicalProcedureMasterVersion"],
                "2026-06-15",
            )
            self.assertEqual(
                [(item["category"], item["masterRowCount"]) for item in artifact["types"]],
                [("lab", 2), ("imaging", 1)],
            )
            self.assertNotIn("generatedAt", artifact)


if __name__ == "__main__":
    unittest.main()
