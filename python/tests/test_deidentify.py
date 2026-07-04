from __future__ import annotations

import csv
import json
import tempfile
import unittest
from pathlib import Path

import contextlib
import io
import json as _json

from medical_fee_calculation.deidentify import deidentify_file, main, pseudonymize, run


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with open(path, "w", encoding="cp932", errors="replace", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for row in rows:
            writer.writerow(row)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, encoding="cp932", errors="replace", newline="") as fh:
        return [dict(r) for r in csv.DictReader(fh)]


class DeidentifyTest(unittest.TestCase):
    def _setup(self, tmp: Path) -> dict:
        raw = tmp / "raw"
        raw.mkdir()
        _write_csv(
            raw / "patients.csv",
            ["患者ID", "氏名", "カナ", "生年月日", "性別", "保険者番号"],
            [["P001", "山田太郎", "ヤマダタロウ", "19580210", "1", "01130012"]],
        )
        _write_csv(
            raw / "diagnosis.csv",
            ["患者ID", "傷病名コード", "傷病名", "診療開始日"],
            [["P001", "8830592", "高血圧症", "20260103"]],
        )
        config = {
            "salt": "test-salt",
            "reference_date": "2026-09-01",
            "date_granularity": "month",
            "files": {
                "patients": {
                    "path": "patients.csv",
                    "encoding": "cp932",
                    "columns": {
                        "患者ID": "patient_key",
                        "氏名": "drop",
                        "カナ": "drop",
                        "生年月日": "birthdate",
                        "性別": "keep",
                        "保険者番号": "drop",
                    },
                },
                "diagnosis": {
                    "path": "diagnosis.csv",
                    "encoding": "cp932",
                    "columns": {
                        "患者ID": "patient_key",
                        "傷病名コード": "keep",
                        "傷病名": "keep",
                        "診療開始日": "service_date",
                    },
                },
            },
        }
        return {"raw": raw, "config": config}

    def test_deidentify_strips_identifiers_and_keeps_linkage(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ctx = self._setup(tmp)
            out = tmp / "out"
            report = run(ctx["config"], ctx["raw"], out, b"test-salt")

            patients = _read_csv(out / "patients.deid.csv")
            diagnosis = _read_csv(out / "diagnosis.deid.csv")

            # 直接識別子は列ごと削除
            self.assertNotIn("氏名", patients[0])
            self.assertNotIn("カナ", patients[0])
            self.assertNotIn("保険者番号", patients[0])
            # 患者IDは擬似ID化され、生の値は残らない
            self.assertNotEqual(patients[0]["患者ID"], "P001")
            self.assertEqual(patients[0]["患者ID"], pseudonymize("P001", b"test-salt"))
            # ファイル横断で同一患者は同一擬似ID(突合可能)
            self.assertEqual(patients[0]["患者ID"], diagnosis[0]["患者ID"])
            # 生年月日 → 年齢(2026-09-01時点で68歳)
            self.assertEqual(patients[0]["生年月日"], "68")
            # 性別・コードは保持
            self.assertEqual(patients[0]["性別"], "1")
            self.assertEqual(diagnosis[0]["傷病名コード"], "8830592")
            # service_date(month) → YYYY-MM
            self.assertEqual(diagnosis[0]["診療開始日"], "2026-01")
            # サマリ
            self.assertEqual(report["files"]["patients"]["droppedColumns"], ["氏名", "カナ", "保険者番号"])

    def test_residual_identifier_scan_warns(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            raw = tmp / "raw"
            raw.mkdir()
            # keep列(傷病名)に氏名らしきカナと長桁番号を混入
            _write_csv(
                raw / "diagnosis.csv",
                ["患者ID", "傷病名"],
                [["P001", "ヤマダ 高血圧症 12345678"]],
            )
            config = {
                "salt": "s",
                "files": {
                    "diagnosis": {
                        "path": "diagnosis.csv",
                        "encoding": "cp932",
                        "columns": {"患者ID": "patient_key", "傷病名": "keep"},
                    }
                },
            }
            report = run(config, raw, tmp / "out", b"s")
            warnings = report["files"]["diagnosis"]["residualIdentifierWarnings"]
            self.assertGreaterEqual(warnings.get("katakana_name", 0), 1)
            self.assertGreaterEqual(warnings.get("long_digits", 0), 1)

    def test_dry_run_produces_no_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ctx = self._setup(tmp)
            out = tmp / "out"
            report = run(ctx["config"], ctx["raw"], out, b"test-salt", dry_run=True)
            self.assertTrue(report["dryRun"])
            self.assertFalse((out / "patients.deid.csv").exists())
            self.assertFalse(out.exists())  # 出力ディレクトリ自体を作らない

    def test_unmapped_columns_fail_closed(self) -> None:
        # 未マッピング列(住所)がある場合、既定(error)では停止する
        fieldnames = ["患者ID", "住所"]
        rows = [{"患者ID": "P001", "住所": "静岡県…"}]
        columns = {"患者ID": "patient_key"}
        with self.assertRaises(ValueError):
            deidentify_file(rows, fieldnames, columns, b"s", __import__("datetime").date(2026, 9, 1))
        # policy=drop なら未定義列は削除されて残らない
        out_rows, out_fields, summary = deidentify_file(
            rows, fieldnames, columns, b"s", __import__("datetime").date(2026, 9, 1), unmapped_policy="drop"
        )
        self.assertNotIn("住所", out_fields)
        self.assertNotIn("住所", out_rows[0])
        self.assertEqual(summary["unmappedColumns"], ["住所"])

    def test_cli_dry_run_creates_no_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ctx = self._setup(tmp)
            # salt を明示しない → 本来は生成して SALT.keep-secret.txt を書くが、dry-run では書かない
            config = dict(ctx["config"])
            config.pop("salt", None)
            config_path = tmp / "config.json"
            config_path.write_text(_json.dumps(config, ensure_ascii=False), encoding="utf-8")
            out = tmp / "out"
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = main([
                    "--config", str(config_path), "--input", str(ctx["raw"]),
                    "--output", str(out), "--dry-run",
                ])
            self.assertEqual(rc, 0)
            self.assertFalse(out.exists())  # 出力ディレクトリもSALTファイルも作られない
            self.assertFalse((out / "SALT.keep-secret.txt").exists())


if __name__ == "__main__":
    unittest.main()
