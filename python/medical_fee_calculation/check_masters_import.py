"""レセ点検マスタ(支払基金コンピュータチェックマスタ + 傷病名/修飾語)の取込。

公的・無償公開データ(社会保険診療報酬支払基金)を halunasu のマスタDBへ取り込む。
算定本体では使わず、fee-core の適応/禁忌/併用/病名整備の点検が参照する。
パースは recept-checker(official_import.py)の実績ある列マッピングを踏襲。

データ源(年度版ごとにURLが変わる。改定・更新時に確認):
  傷病名 b_*.txt / 修飾語 z_*.txt:
    https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/
  コンピュータチェックマスタ(IY_Tekio/IY_ShobyoKinki/IY_HeiyoKinki/SI_Shobyo …):
    https://www.ssk.or.jp/shinryohoshu/ssk_cc/

使い方:
  # ZIPを展開したディレクトリ(b_*.txt, z_*.txt, IY_Tekio*.csv, SI_Shobyo*.csv 等が並ぶ)を指定
  PYTHONPATH=python python3 -m medical_fee_calculation.check_masters_import \
      --raw /path/to/extracted --db master_data/master.sqlite --label 令和8年度版 --effective 202606
"""

from __future__ import annotations

import argparse
import csv
import datetime
import sys
from pathlib import Path
from typing import Any, Iterable

from medical_fee_calculation.db import connect, initialize_schema

CHECK_SOURCE_TYPE = "payer_check_master"


def _f(value: str) -> float | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _i(value: str) -> int | None:
    parsed = _f(value)
    return int(parsed) if parsed is not None else None


def _rows(path: Path, encoding: str, skip_header: bool = False) -> Iterable[list[str]]:
    with open(path, encoding=encoding, errors="replace", newline="") as fh:
        for index, row in enumerate(csv.reader(fh)):
            if skip_header and index == 0:
                continue
            if row:
                yield row


def _find(raw: Path, prefix: str, suffixes=(".csv", ".txt")) -> Path | None:
    files = [p for p in raw.iterdir() if p.suffix.lower() in suffixes]
    lower = prefix.lower()
    candidates = sorted(p for p in files if p.name.lower().startswith(lower))
    if candidates:
        return candidates[-1]
    norm = lower.replace("_", "")
    candidates = sorted(p for p in files if p.name.lower().replace("_", "").startswith(norm))
    return candidates[-1] if candidates else None


def _batch_insert(conn: Any, sql: str, rows: Iterable[tuple], batch: int = 5000) -> int:
    buffer: list[tuple] = []
    total = 0
    for row in rows:
        buffer.append(row)
        if len(buffer) >= batch:
            conn.executemany(sql, buffer)
            total += len(buffer)
            buffer.clear()
    if buffer:
        conn.executemany(sql, buffer)
        total += len(buffer)
    return total


def _reset_check_tables(conn: Any) -> None:
    # 点検マスタは全件リフレッシュ(単一版運用)。改定跨ぎの多版運用は effective で切替(将来対応)。
    for table in (
        "diseases",
        "disease_modifiers",
        "cc_drug_indications",
        "cc_drug_contra_disease",
        "cc_drug_interactions",
        "cc_act_indications",
    ):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("DELETE FROM master_sources WHERE source_type = ?", (CHECK_SOURCE_TYPE,))


def _ensure_source(conn: Any, raw: Path, version_label: str) -> int:
    now = datetime.datetime.now().isoformat(timespec="seconds")
    cur = conn.execute(
        """
        INSERT INTO master_sources
            (source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (CHECK_SOURCE_TYPE, version_label or "check_master", str(raw), "-", "cp932", 0, now),
    )
    return int(cur.lastrowid)


def import_check_masters(
    raw_dir: str | Path,
    db_path: str | Path,
    version_label: str = "",
    effective_from: str = "",
    encoding: str = "cp932",
    quiet: bool = False,
) -> dict[str, int]:
    raw = Path(raw_dir)
    if not raw.is_dir():
        raise FileNotFoundError(f"raw dir not found: {raw}")
    db = Path(db_path)
    db.parent.mkdir(parents=True, exist_ok=True)

    conn = connect(db)
    counts: dict[str, int] = {}
    try:
        initialize_schema(conn)
        _reset_check_tables(conn)
        source_id = _ensure_source(conn, raw, version_label)

        def log(label: str, n: int) -> None:
            counts[label] = n
            if not quiet:
                print(f"  {label}: {n:,}件")

        # 傷病名マスタ b_*.txt (recept-checker byomei: code=r2,name=r5,kana=r9,icd=r15||r13,tandoku=r18,end=r23)
        p = _find(raw, "b_")
        if p:
            def gen():
                for r in _rows(p, encoding):
                    if len(r) < 44 or r[1] != "B":
                        continue
                    icd = (r[15].strip() or r[13].strip()) if len(r) > 15 else ""
                    yield (source_id, r[2], r[5], r[9], "", icd, r[18], effective_from, r[23], "")
            log("傷病名", _batch_insert(conn, "INSERT INTO diseases VALUES (?,?,?,?,?,?,?,?,?,?)", gen()))

        # 修飾語マスタ z_*.txt (code=r2, name=r6, kubun=r18)
        p = _find(raw, "z_")
        if p:
            def gen():
                for r in _rows(p, encoding):
                    if len(r) < 19 or r[1] != "Z":
                        continue
                    yield (source_id, r[2], r[6], r[18])
            log("修飾語", _batch_insert(conn, "INSERT INTO disease_modifiers VALUES (?,?,?,?)", gen()))

        # 医薬品適応・投与量 IY_Tekio (skip header, len>=24, 取消区分 r22 not in 1/9)
        p = _find(raw, "IY_Tekio")
        if p:
            def gen():
                for r in _rows(p, encoding, skip_header=True):
                    if len(r) < 24 or r[22] in ("1", "9"):
                        continue
                    yield (source_id, r[0], r[1], r[4], _f(r[5]), _f(r[6]), r[7], _f(r[12]), _i(r[14]), r[20], r[23])
            log("医薬品適応", _batch_insert(conn, "INSERT INTO cc_drug_indications VALUES (?,?,?,?,?,?,?,?,?,?,?)", gen()))

        # 傷病名禁忌 IY_ShobyoKinki (len>=8, r6 not in 1/9)
        p = _find(raw, "IY_ShobyoKinki")
        if p:
            def gen():
                for r in _rows(p, encoding, skip_header=True):
                    if len(r) < 8 or r[6] in ("1", "9"):
                        continue
                    yield (source_id, r[0], r[1], r[7])
            log("禁忌傷病名", _batch_insert(conn, "INSERT INTO cc_drug_contra_disease VALUES (?,?,?,?)", gen()))

        # 併用禁忌 IY_HeiyoKinki (len>=10, r8 not in 1/9)
        p = _find(raw, "IY_HeiyoKinki")
        if p:
            def gen():
                for r in _rows(p, encoding, skip_header=True):
                    if len(r) < 10 or r[8] in ("1", "9"):
                        continue
                    yield (source_id, r[0], r[1], r[9])
            log("併用禁忌", _batch_insert(conn, "INSERT INTO cc_drug_interactions VALUES (?,?,?,?)", gen()))

        # 診療行為適応 SI_Shobyo (len>=13, r11 not in 1/9)
        p = _find(raw, "SI_Shobyo")
        if p:
            def gen():
                for r in _rows(p, encoding, skip_header=True):
                    if len(r) < 13 or r[11] in ("1", "9"):
                        continue
                    yield (source_id, r[0], r[1], r[6], _f(r[7]), _f(r[8]), r[9], r[10], r[12])
            log("診療行為適応", _batch_insert(conn, "INSERT INTO cc_act_indications VALUES (?,?,?,?,?,?,?,?,?)", gen()))

        conn.execute(
            "UPDATE master_sources SET row_count = ? WHERE id = ?",
            (sum(counts.values()), source_id),
        )
        conn.commit()
    finally:
        conn.close()
    return counts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="レセ点検マスタ(支払基金チェックマスタ+傷病名/修飾語)の取込")
    parser.add_argument("--raw", required=True, help="ZIP展開済みディレクトリ(b_*.txt, IY_Tekio*.csv 等)")
    parser.add_argument("--db", required=True, help="取込先マスタDB(SQLite)")
    parser.add_argument("--label", default="", help="版の表示名。例: 令和8年度版")
    parser.add_argument("--effective", default="", help="適用開始年月(YYYYMM)。例: 202606")
    parser.add_argument("--encoding", default="cp932")
    args = parser.parse_args(argv)
    print(f"取込開始: {args.raw} → {args.db}")
    counts = import_check_masters(args.raw, args.db, version_label=args.label, effective_from=args.effective, encoding=args.encoding)
    print(f"完了: 合計 {sum(counts.values()):,}件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
