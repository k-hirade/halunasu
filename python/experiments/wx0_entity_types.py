"""Build WX0 span entity types from the effective fee master."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any


ALPHA_PART_TYPES = {
    "A": ("outpatient_basic", "基本診療料", "初診、再診、入院など診療の基本となる行為"),
    "B": ("management", "医学管理", "疾患や療養に対する医学的な指導・管理"),
    "C": ("management", "在宅医療", "訪問診療、往診、在宅療養に関する診療行為"),
    "D": ("lab", "検査", "検体検査、生体検査、検査判断"),
    "E": ("imaging", "画像診断", "X線、CT、MRI、超音波などの画像診断"),
    "F": ("medication", "投薬", "処方、調剤、薬剤の投与"),
    "G": ("injection", "注射", "皮下、筋肉内、静脈内などの注射"),
    "H": ("treatment", "リハビリテーション", "運動器、脳血管、呼吸器などのリハビリ"),
    "I": ("counseling", "精神科専門療法", "精神療法、心理支援、精神科訪問看護"),
    "J": ("procedure", "処置", "創傷、熱傷、吸引などの処置"),
    "K": ("procedure", "手術", "手術および手術に付随する操作"),
    "L": ("procedure", "麻酔", "麻酔、神経ブロック"),
    "M": ("treatment", "放射線治療", "放射線照射、定位放射線治療"),
    "N": ("pathology", "病理診断", "病理組織、細胞診、病理判断"),
    "O": ("other", "その他の診療行為", "上記以外の診療行為や評価料"),
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_entity_types(
    db_path: Path,
    clinical_axes_schema_path: Path,
) -> dict[str, Any]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        source = conn.execute(
            """
            SELECT id, source_version
            FROM master_sources
            WHERE source_type = 'medical_procedure_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        if source is None:
            raise ValueError("medical_procedure_master source is missing")
        rows = conn.execute(
            """
            SELECT alpha_part, COUNT(*) AS row_count
            FROM medical_procedures
            WHERE source_id = ? AND chapter IN ('1', '2')
            GROUP BY alpha_part
            ORDER BY alpha_part
            """,
            (source["id"],),
        ).fetchall()
    finally:
        conn.close()

    types = []
    for row in rows:
        alpha_part = str(row["alpha_part"] or "").strip()
        definition = ALPHA_PART_TYPES.get(alpha_part)
        if definition is None:
            continue
        category, label, description = definition
        types.append(
            {
                "id": f"medical_procedure_{alpha_part.lower()}",
                "category": category,
                "label": label,
                "definition": description,
                "modelLabel": f"{label}: {description}",
                "masterSelector": {
                    "table": "medical_procedures",
                    "chapter": ["1", "2"],
                    "alphaPart": alpha_part,
                },
                "masterRowCount": int(row["row_count"]),
            }
        )

    if not types:
        raise ValueError("no supported medical procedure alpha parts were found")

    return {
        "schemaVersion": "fee-wx0-entity-types-v1",
        "source": {
            "medicalProcedureMasterVersion": str(source["source_version"]),
            "masterSha256": _sha256(db_path),
            "clinicalAxesSchemaSha256": _sha256(clinical_axes_schema_path),
        },
        "types": types,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("python/data/master/standard-master.sqlite"),
    )
    parser.add_argument(
        "--clinical-axes-schema",
        type=Path,
        default=Path(
            "packages/medical-core/generated/clinical-axes.schema.json"
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/tests/fee-specialty-matrix/entity-types.json"),
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    artifact = build_entity_types(
        args.db.expanduser().resolve(),
        args.clinical_axes_schema.expanduser().resolve(),
    )
    serialized = json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"
    output = args.output.expanduser().resolve()
    if args.check:
        if not output.exists() or output.read_text(encoding="utf-8") != serialized:
            print(f"WX0 entity type artifact is missing or stale: {output}")
            return 1
        print(f"WX0 entity type artifact is current: {output}")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(serialized, encoding="utf-8")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
