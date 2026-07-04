"""デモ用の小さな点検マスタDBを作る（実123万行は不要）。

nishiyama-demo サンプルで各点検（判断料もれ/適応なし/禁忌/併用禁忌/病名コード化）が
発火するのに必要な最小限のマスタ行だけを投入する。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from medical_fee_calculation.db import connect, initialize_schema


def seed(db_path: str, force: bool = False) -> None:
    # 安全ガード: このスクリプトは指定DBの diseases/medical_procedures/点検マスタを削除する。
    # 実マスタ(master_data/master.sqlite 等)を誤って壊さないよう、パスに 'demo' を含むこと、
    # または --force-demo-db を必須にする。
    if not force and "demo" not in Path(db_path).name.lower():
        raise SystemExit(
            f"拒否: '{db_path}' はデモDBに見えません(ファイル名に 'demo' が必要)。"
            " デモ用の使い捨てDBパスを指定するか、意図的な場合のみ --force-demo-db を付けてください。"
        )
    conn = connect(Path(db_path))
    try:
        initialize_schema(conn)
        conn.execute("DELETE FROM master_sources WHERE source_type IN ('payer_check_master','medical_procedure_master')")
        for table in ("diseases", "disease_modifiers", "cc_drug_indications",
                      "cc_drug_contra_disease", "cc_drug_interactions", "cc_act_indications", "medical_procedures"):
            conn.execute(f"DELETE FROM {table}")

        conn.execute(
            "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
            "VALUES (1, 'medical_procedure_master', 'demo', 'demo', 'demo', 'utf-8', 1, '2026-09-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO master_sources (id, source_type, source_version, raw_path, checksum_sha256, encoding, row_count, imported_at) "
            "VALUES (2, 'payer_check_master', 'demo', 'demo', 'demo', 'cp932', 1, '2026-09-01T00:00:00Z')"
        )

        # 診療行為: 末梢血液一般(検査 judgement_kind=1 group=2) → 判断料もれの対象
        conn.execute(
            "INSERT INTO medical_procedures (source_id, code, short_name, points, judgement_kind, judgement_group, chapter, section, raw_row_json) "
            "VALUES (1, '160008010', '末梢血液一般', 21, '1', '02', 'D', '血液学的検査', '{}')"
        )

        # 傷病名マスタ(病名コード化・候補名称用)
        for code, name in [("8830592", "高血圧症"), ("8834321", "妊娠"), ("2500013", "気管支炎")]:
            conn.execute("INSERT INTO diseases (source_id, code, name, effective_to) VALUES (2, ?, ?, '99999999')", (code, name))
        # 修飾語(接頭・接尾)
        for code, name, kubun in [("8002", "の疑い", "8"), ("4012", "急性", "1")]:
            conn.execute("INSERT INTO disease_modifiers (source_id, code, name, kubun) VALUES (2, ?, ?, ?)", (code, name, kubun))

        # 適応: アムロジピン(620000600) の適応は高血圧症(8830592)
        conn.execute("INSERT INTO cc_drug_indications (source_id, drug_code, disease_code, sex, age_min, age_max) VALUES (2, '620000600', '8830592', '', 0, 999)")
        # 禁忌: 薬剤X(620000700) は妊娠(8834321)に禁忌
        conn.execute("INSERT INTO cc_drug_contra_disease (source_id, drug_code, disease_code) VALUES (2, '620000700', '8834321')")
        # 併用禁忌: アムロジピン(620000600) × ワルファリン(620000601)  ※デモ用の作為
        conn.execute("INSERT INTO cc_drug_interactions (source_id, drug_a, drug_b) VALUES (2, '620000600', '620000601')")

        conn.commit()
    finally:
        conn.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="デモ用点検マスタDBのシード")
    parser.add_argument("--db", required=True)
    parser.add_argument("--force-demo-db", action="store_true",
                        help="パスに 'demo' を含まないDBでも強制的にシードする(実マスタ破壊注意)")
    args = parser.parse_args(argv)
    seed(args.db, force=args.force_demo_db)
    print(f"seeded demo master: {args.db}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
