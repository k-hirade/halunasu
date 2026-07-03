from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from medical_fee_calculation.check_masters_import import import_check_masters
from medical_fee_calculation.checks_api import check_lookup


def _row(width: int, values: dict[int, str]) -> list[str]:
    row = ["" for _ in range(width)]
    for index, value in values.items():
        row[index] = value
    return row


def _write_csv(path: Path, rows: list[list[str]]) -> None:
    with open(path, "w", encoding="cp932", errors="replace", newline="") as fh:
        writer = csv.writer(fh)
        for row in rows:
            writer.writerow(row)


class CheckMastersImportTest(unittest.TestCase):
    def _make_raw(self, raw: Path) -> None:
        # 傷病名 b_*.txt: r1='B', code=r2, name=r5, kana=r9, icd=r15, end=r23
        _write_csv(raw / "b_test.txt", [
            _row(46, {1: "B", 2: "8830592", 5: "高血圧症", 9: "コウケツアツショウ", 15: "I10", 18: "", 23: "99999999"}),
            _row(46, {1: "B", 2: "8834321", 5: "妊娠", 9: "ニンシン", 15: "Z33", 23: "99999999"}),
        ])
        # 修飾語 z_*.txt: r1='Z', code=r2, name=r6, kubun=r18
        _write_csv(raw / "z_test.txt", [
            _row(19, {1: "Z", 2: "8002", 6: "の疑い", 18: "8"}),
        ])
        # IY_Tekio: header + data(24列, r22取消区分). 薬620…適応=8830592(男性)
        _write_csv(raw / "IY_Tekio_test.csv", [
            _row(24, {0: "H"}),  # header(skip)
            _row(24, {0: "620000600", 1: "8830592", 4: "1", 5: "0", 6: "999", 7: "1", 12: "", 14: "", 20: "", 22: "0", 23: "R08"}),
        ])
        # IY_ShobyoKinki: 薬620…禁忌=8834321(妊娠)
        _write_csv(raw / "IY_ShobyoKinki_test.csv", [
            _row(8, {0: "H"}),
            _row(8, {0: "620000600", 1: "8834321", 6: "0", 7: "R08"}),
        ])
        # IY_HeiyoKinki: 620と621は併用禁忌
        _write_csv(raw / "IY_HeiyoKinki_test.csv", [
            _row(10, {0: "H"}),
            _row(10, {0: "620000600", 1: "620000601", 8: "0", 9: "R08"}),
        ])
        # SI_Shobyo: 診療行為160…適応=8830592(疑い可 utagai=r10=1)
        _write_csv(raw / "SI_Shobyo_test.csv", [
            _row(13, {0: "H"}),
            _row(13, {0: "160008010", 1: "8830592", 6: "", 7: "0", 8: "999", 9: "", 10: "1", 11: "0", 12: "R08"}),
        ])

    def test_import_then_check_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            raw.mkdir()
            self._make_raw(raw)
            db_path = Path(tmp) / "master.sqlite"

            counts = import_check_masters(raw, db_path, version_label="令和8年度版(test)", quiet=True)

            self.assertEqual(counts["傷病名"], 2)
            self.assertEqual(counts["修飾語"], 1)
            self.assertEqual(counts["医薬品適応"], 1)
            self.assertEqual(counts["禁忌傷病名"], 1)
            self.assertEqual(counts["併用禁忌"], 1)
            self.assertEqual(counts["診療行為適応"], 1)

            result = check_lookup({
                "db_path": str(db_path),
                "drug_codes": ["620000600", "620000601"],
                "act_codes": ["160008010"],
                "disease_codes": ["8830592", "8834321"],
            })

        self.assertEqual(result["drugIndications"]["620000600"][0]["diseaseCode"], "8830592")
        self.assertEqual(result["drugIndications"]["620000600"][0]["sex"], "1")
        self.assertEqual(result["drugContraDiseases"]["620000600"], ["8834321"])
        self.assertEqual(result["drugInteractions"], [["620000600", "620000601"]])
        self.assertEqual(result["actIndications"]["160008010"][0]["utagai"], "1")
        self.assertEqual(result["diseaseNames"]["8830592"], "高血圧症")

    def test_reimport_refreshes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw"
            raw.mkdir()
            self._make_raw(raw)
            db_path = Path(tmp) / "master.sqlite"
            import_check_masters(raw, db_path, quiet=True)
            counts = import_check_masters(raw, db_path, quiet=True)  # 二度目でも重複しない
            self.assertEqual(counts["傷病名"], 2)
            result = check_lookup({"db_path": str(db_path), "disease_codes": ["8830592"]})
            self.assertEqual(result["diseaseNames"]["8830592"], "高血圧症")


if __name__ == "__main__":
    unittest.main()
