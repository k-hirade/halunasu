from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
import subprocess
import zlib
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from medical_fee_calculation.hospital_profile import normalize_medical_institution_code
from medical_fee_calculation.hospital_quality import HOSPITAL_INSTITUTION_TYPES
from medical_fee_calculation.importers import ImportResult, _compact_date, _upsert_source, sha256_file


DPC_HOSPITAL_COEFFICIENT_SOURCE_TYPE = "dpc_hospital_coefficient"

PREFECTURE_TO_REGIONAL_BUREAU = {
    "北海道": "hokkaido",
    "青森": "tohoku",
    "岩手": "tohoku",
    "宮城": "tohoku",
    "秋田": "tohoku",
    "山形": "tohoku",
    "福島": "tohoku",
    "茨城": "kanto_shinetsu",
    "栃木": "kanto_shinetsu",
    "群馬": "kanto_shinetsu",
    "埼玉": "kanto_shinetsu",
    "千葉": "kanto_shinetsu",
    "東京": "kanto_shinetsu",
    "神奈川": "kanto_shinetsu",
    "新潟": "kanto_shinetsu",
    "山梨": "kanto_shinetsu",
    "長野": "kanto_shinetsu",
    "富山": "tokai_hokuriku",
    "石川": "tokai_hokuriku",
    "岐阜": "tokai_hokuriku",
    "静岡": "tokai_hokuriku",
    "愛知": "tokai_hokuriku",
    "三重": "tokai_hokuriku",
    "福井": "kinki",
    "滋賀": "kinki",
    "京都": "kinki",
    "大阪": "kinki",
    "兵庫": "kinki",
    "奈良": "kinki",
    "和歌山": "kinki",
    "鳥取": "chugoku_shikoku",
    "島根": "chugoku_shikoku",
    "岡山": "chugoku_shikoku",
    "広島": "chugoku_shikoku",
    "山口": "chugoku_shikoku",
    "徳島": "shikoku",
    "香川": "shikoku",
    "愛媛": "shikoku",
    "高知": "shikoku",
    "福岡": "kyushu",
    "佐賀": "kyushu",
    "長崎": "kyushu",
    "熊本": "kyushu",
    "大分": "kyushu",
    "宮崎": "kyushu",
    "鹿児島": "kyushu",
    "沖縄": "kyushu",
}

_LEGAL_ENTITY_TOKENS = (
    "独立行政法人国立病院機構",
    "地方独立行政法人",
    "国立大学法人",
    "公立大学法人",
    "学校法人",
    "社会医療法人財団",
    "社会医療法人社団",
    "社会医療法人",
    "医療法人財団",
    "医療法人社団",
    "医療法人",
    "公益財団法人",
    "公益社団法人",
    "一般財団法人",
    "一般社団法人",
    "社会福祉法人",
    "日本赤十字社",
)

_PREFECTURES = (
    "北海道",
    "神奈川",
    "和歌山",
    "鹿児島",
    "青森",
    "岩手",
    "宮城",
    "秋田",
    "山形",
    "福島",
    "茨城",
    "栃木",
    "群馬",
    "埼玉",
    "千葉",
    "東京",
    "新潟",
    "富山",
    "石川",
    "福井",
    "山梨",
    "長野",
    "岐阜",
    "静岡",
    "愛知",
    "三重",
    "滋賀",
    "京都",
    "大阪",
    "兵庫",
    "奈良",
    "鳥取",
    "島根",
    "岡山",
    "広島",
    "山口",
    "徳島",
    "香川",
    "愛媛",
    "高知",
    "福岡",
    "佐賀",
    "長崎",
    "熊本",
    "大分",
    "宮崎",
    "沖縄",
)

_PREFECTURE_PATTERN = "|".join(re.escape(prefecture) for prefecture in _PREFECTURES)
_COEFFICIENT_PATTERN = r"-?\d\.\d{4}"
_NOTICE_ROW_RE = re.compile(
    rf"(?P<notice_code>\d{{4,5}})\s*"
    rf"(?P<prefecture>{_PREFECTURE_PATTERN})\s*"
    rf"(?P<institution_name>.+?)\s*"
    rf"(?P<base>{_COEFFICIENT_PATTERN})\s*"
    rf"(?P<function_ii>{_COEFFICIENT_PATTERN})\s*"
    rf"(?P<emergency>{_COEFFICIENT_PATTERN})\s*"
    rf"(?P<mitigation>{_COEFFICIENT_PATTERN})"
)
_NOTICE_ROW_TRAILING_NAME_RE = re.compile(
    rf"(?P<notice_code>\d{{4,5}})\s*"
    rf"(?P<prefecture>{_PREFECTURE_PATTERN})\s*"
    rf"(?P<base>{_COEFFICIENT_PATTERN})\s*"
    rf"(?P<function_ii>{_COEFFICIENT_PATTERN})\s*"
    rf"(?P<emergency>{_COEFFICIENT_PATTERN})\s*"
    rf"(?P<mitigation>{_COEFFICIENT_PATTERN})\s*"
    rf"(?P<institution_name>.+)"
)
_TABLE_LABEL_RE = re.compile(r"別?表第?([一二三四五六])")
_TABLE_LABELS = {
    "一": "別表第一",
    "二": "別表第二",
    "三": "別表第三",
    "四": "別表第四",
    "五": "別表第五",
    "六": "別表第六",
}
_PDF_OBJECT_RE = re.compile(rb"(\d+)\s+0\s+obj(.*?)endobj", re.S)
_PDF_STREAM_RE = re.compile(rb"stream\r?\n?(.*?)\r?\n?endstream", re.S)
_PDF_TOKEN_RE = re.compile(
    rb"(\[[^\]]*\]|<[0-9A-Fa-f\s]+>|/[A-Za-z0-9_.#]+|[-+]?(?:\d+\.\d+|\d+|\.\d+)|[A-Za-z][A-Za-z0-9*']*)",
    re.S,
)

_COLUMN_ALIASES = {
    "prefecture_name": ("prefecture_name", "prefecture", "都道府県", "都道府県名"),
    "medical_institution_code": (
        "medical_institution_code",
        "institution_code",
        "医療機関コード",
        "医療機関番号",
    ),
    "institution_name": (
        "institution_name",
        "hospital_name",
        "name",
        "病院名",
        "医療機関名",
    ),
    "hospital_group": ("hospital_group", "group", "医療機関群", "病院群"),
    "base_coefficient": ("base_coefficient", "基礎係数"),
    "functional_evaluation_coefficient_i": (
        "functional_evaluation_coefficient_i",
        "function_i",
        "機能評価係数I",
        "機能評価係数Ⅰ",
    ),
    "functional_evaluation_coefficient_ii": (
        "functional_evaluation_coefficient_ii",
        "function_ii",
        "機能評価係数II",
        "機能評価係数Ⅱ",
    ),
    "emergency_correction_coefficient": (
        "emergency_correction_coefficient",
        "emergency",
        "救急補正係数",
    ),
    "mitigation_coefficient": (
        "mitigation_coefficient",
        "mitigation",
        "激変緩和係数",
    ),
    "total_coefficient": (
        "total_coefficient",
        "hospital_coefficient",
        "医療機関別係数",
        "合計係数",
    ),
    "effective_from": ("effective_from", "開始日", "有効開始日", "適用開始日"),
    "effective_to": ("effective_to", "終了日", "有効終了日", "適用終了日"),
}


@dataclass(frozen=True)
class DpcCoefficientNoticeRow:
    notice_code: str
    prefecture_name: str
    institution_name: str
    hospital_group: str | None
    base_coefficient: float
    functional_evaluation_coefficient_ii: float
    emergency_correction_coefficient: float
    mitigation_coefficient: float
    total_coefficient: float
    effective_from: str | None
    effective_to: str | None
    source_line: int
    raw_text: str

    def to_csv_row(self) -> dict[str, str]:
        return {
            "notice_code": self.notice_code,
            "prefecture_name": self.prefecture_name,
            "medical_institution_code": "",
            "institution_name": self.institution_name,
            "hospital_group": self.hospital_group or "",
            "base_coefficient": _format_coefficient(self.base_coefficient),
            "functional_evaluation_coefficient_ii": _format_coefficient(
                self.functional_evaluation_coefficient_ii
            ),
            "emergency_correction_coefficient": _format_coefficient(
                self.emergency_correction_coefficient
            ),
            "mitigation_coefficient": _format_coefficient(self.mitigation_coefficient),
            "total_coefficient": _format_coefficient(self.total_coefficient),
            "effective_from": self.effective_from or "",
            "effective_to": self.effective_to or "",
            "source_line": str(self.source_line),
            "raw_text": self.raw_text,
        }


@dataclass(frozen=True)
class DpcCoefficientNoticeExtraction:
    rows: tuple[DpcCoefficientNoticeRow, ...]
    warnings: tuple[str, ...]
    text_source: str
    pdf_text_converter: str | None = None

    def to_report(self) -> dict[str, Any]:
        return {
            "row_count": len(self.rows),
            "warning_count": len(self.warnings),
            "text_source": self.text_source,
            "pdf_text_converter": self.pdf_text_converter,
            "hospital_groups": sorted(
                {row.hospital_group for row in self.rows if row.hospital_group}
            ),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class DpcHospitalCoefficientRegistryAuditRow:
    source_id: int
    row_index: int
    prefecture_name: str
    expected_regional_bureau: str
    institution_name: str
    hospital_group: str
    total_coefficient: float
    match_status: str
    recommended_action: str
    candidate_count: int
    candidate_regional_bureau: str
    candidate_medical_institution_code: str
    candidate_institution_name: str
    candidate_institution_type: str
    match_basis: str

    def to_dict(self) -> dict[str, float | int | str]:
        return {
            "source_id": self.source_id,
            "row_index": self.row_index,
            "prefecture_name": self.prefecture_name,
            "expected_regional_bureau": self.expected_regional_bureau,
            "institution_name": self.institution_name,
            "hospital_group": self.hospital_group,
            "total_coefficient": self.total_coefficient,
            "match_status": self.match_status,
            "recommended_action": self.recommended_action,
            "candidate_count": self.candidate_count,
            "candidate_regional_bureau": self.candidate_regional_bureau,
            "candidate_medical_institution_code": self.candidate_medical_institution_code,
            "candidate_institution_name": self.candidate_institution_name,
            "candidate_institution_type": self.candidate_institution_type,
            "match_basis": self.match_basis,
        }


@dataclass(frozen=True)
class DpcHospitalCoefficientRegistryFixPlanRow:
    source_id: int
    row_index: int
    prefecture_name: str
    expected_regional_bureau: str
    institution_name: str
    hospital_group: str
    total_coefficient: float
    current_match_status: str
    fix_category: str
    recommended_action: str
    candidate_source: str
    candidate_count: int
    candidate_regional_bureau: str
    candidate_medical_institution_code: str
    candidate_institution_name: str
    candidate_basis: str

    def to_dict(self) -> dict[str, float | int | str]:
        return {
            "source_id": self.source_id,
            "row_index": self.row_index,
            "prefecture_name": self.prefecture_name,
            "expected_regional_bureau": self.expected_regional_bureau,
            "institution_name": self.institution_name,
            "hospital_group": self.hospital_group,
            "total_coefficient": self.total_coefficient,
            "current_match_status": self.current_match_status,
            "fix_category": self.fix_category,
            "recommended_action": self.recommended_action,
            "candidate_source": self.candidate_source,
            "candidate_count": self.candidate_count,
            "candidate_regional_bureau": self.candidate_regional_bureau,
            "candidate_medical_institution_code": self.candidate_medical_institution_code,
            "candidate_institution_name": self.candidate_institution_name,
            "candidate_basis": self.candidate_basis,
        }


def extract_dpc_hospital_coefficients_from_pdf(
    pdf_path: str | Path,
    *,
    effective_from: str | None = "2026-06-01",
    effective_to: str | None = "9999-12-31",
) -> DpcCoefficientNoticeExtraction:
    text, converter = _extract_text_from_pdf(Path(pdf_path))
    result = extract_dpc_hospital_coefficients_from_text(
        text,
        text_source=str(pdf_path),
        effective_from=effective_from,
        effective_to=effective_to,
    )
    return DpcCoefficientNoticeExtraction(
        rows=result.rows,
        warnings=result.warnings,
        text_source=result.text_source,
        pdf_text_converter=converter,
    )


def extract_dpc_hospital_coefficients_from_text(
    text: str,
    *,
    text_source: str = "text",
    effective_from: str | None = "2026-06-01",
    effective_to: str | None = "9999-12-31",
) -> DpcCoefficientNoticeExtraction:
    rows: list[DpcCoefficientNoticeRow] = []
    warnings: list[str] = []
    current_group: str | None = None
    buffer = ""
    buffer_line = 0

    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = _clean_notice_text_line(raw_line)
        if not line:
            continue

        parsed_any = False
        if _line_starts_notice_row(line):
            if buffer:
                warnings.append(f"line {buffer_line}: unresolved coefficient row fragment")
            buffer = line
            buffer_line = line_number
        elif buffer:
            buffer = f"{buffer} {line}"
        else:
            current_group = _maybe_update_table_label(current_group, line)
            continue

        while buffer:
            match = _NOTICE_ROW_RE.search(buffer)
            if match is None:
                match = _NOTICE_ROW_TRAILING_NAME_RE.search(buffer)
            if match is None:
                break
            rows.append(
                _notice_row_from_match(
                    match,
                    current_group=current_group,
                    line_number=buffer_line,
                    raw_text=buffer,
                    effective_from=effective_from,
                    effective_to=effective_to,
                )
            )
            parsed_any = True
            tail = buffer[match.end() :].strip()
            current_group = _maybe_update_table_label(current_group, tail)
            next_match = re.search(rf"\d{{4,5}}\s*(?:{_PREFECTURE_PATTERN})", tail)
            if next_match is None:
                buffer = ""
                buffer_line = 0
            else:
                buffer = tail[next_match.start() :]
        if parsed_any:
            continue
        if buffer and len(buffer) > 500:
            warnings.append(f"line {buffer_line}: coefficient row fragment exceeded 500 chars")
            buffer = ""
            buffer_line = 0

    if buffer:
        warnings.append(f"line {buffer_line}: unresolved coefficient row fragment")

    return DpcCoefficientNoticeExtraction(
        rows=tuple(rows),
        warnings=tuple(warnings),
        text_source=text_source,
    )


def write_dpc_hospital_coefficients_csv(
    extraction: DpcCoefficientNoticeExtraction,
    path: str | Path,
) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = (
        "notice_code",
        "prefecture_name",
        "medical_institution_code",
        "institution_name",
        "hospital_group",
        "base_coefficient",
        "functional_evaluation_coefficient_ii",
        "emergency_correction_coefficient",
        "mitigation_coefficient",
        "total_coefficient",
        "effective_from",
        "effective_to",
        "source_line",
        "raw_text",
    )
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in extraction.rows:
            writer.writerow(row.to_csv_row())


def write_dpc_hospital_coefficients_extraction_report(
    extraction: DpcCoefficientNoticeExtraction,
    path: str | Path,
) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(extraction.to_report(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def import_dpc_hospital_coefficients(
    conn: sqlite3.Connection,
    path: str | Path,
    *,
    source_version: str,
    published_at: str | None = None,
    url: str | None = None,
    encoding: str = "utf-8-sig",
    retrieved_at: str | None = None,
) -> ImportResult:
    """Import an audited CSV/TSV extracted from the official DPC coefficient notice.

    The MHLW source is a legal PDF notice. This importer intentionally consumes a
    machine-readable extraction artifact while preserving every raw row, so the
    extraction step can be audited independently from the calculation engine.
    """

    input_path = Path(path)
    rows = _read_dict_rows(input_path, encoding=encoding)
    checksum = sha256_file(input_path)
    source_id = _upsert_source(
        conn,
        source_type=DPC_HOSPITAL_COEFFICIENT_SOURCE_TYPE,
        source_version=source_version,
        raw_path=str(input_path),
        checksum_sha256=checksum,
        row_count=len(rows),
        published_at=published_at,
        url=url,
        encoding=encoding,
        retrieved_at=retrieved_at,
        replace_tables=("dpc_hospital_coefficients",),
    )

    records: list[tuple[Any, ...]] = []
    for row_index, row in enumerate(rows, start=1):
        record = _coefficient_record(source_id, row_index, row)
        if record is not None:
            records.append(record)

    conn.executemany(
        """
        INSERT INTO dpc_hospital_coefficients (
            source_id,
            row_index,
            prefecture_name,
            medical_institution_code,
            institution_name,
            normalized_institution_name,
            hospital_group,
            base_coefficient,
            functional_evaluation_coefficient_i,
            functional_evaluation_coefficient_ii,
            emergency_correction_coefficient,
            mitigation_coefficient,
            total_coefficient,
            effective_from,
            effective_to,
            raw_row_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        records,
    )
    conn.commit()
    return ImportResult(source_id=source_id, row_count=len(records), checksum_sha256=checksum)


def normalize_institution_name(value: str | None) -> str:
    text = str(value or "")
    text = text.replace("　", " ").strip()
    text = re.sub(r"\s+", "", text)
    text = text.replace("（", "(").replace("）", ")")
    return text


def audit_dpc_hospital_coefficient_registry_matches(
    conn: sqlite3.Connection,
    *,
    source_id: int | None = None,
) -> list[DpcHospitalCoefficientRegistryAuditRow]:
    """Classify DPC coefficient rows by how safely they connect to the hospital registry.

    Only deterministic matches are promoted to candidates. Fuzzy matches are intentionally
    excluded because near-name matches can point to a different hospital.
    """

    resolved_source_id = source_id if source_id is not None else _latest_dpc_coefficient_source_id(conn)
    if resolved_source_id is None:
        return []

    coefficient_rows = conn.execute(
        """
        SELECT
            source_id,
            row_index,
            prefecture_name,
            institution_name,
            normalized_institution_name,
            hospital_group,
            total_coefficient
        FROM dpc_hospital_coefficients
        WHERE source_id = ?
        ORDER BY row_index
        """,
        (resolved_source_id,),
    ).fetchall()
    registry_rows = _registry_candidate_rows(conn)

    audit_rows: list[DpcHospitalCoefficientRegistryAuditRow] = []
    for coefficient in coefficient_rows:
        prefecture_name = str(coefficient["prefecture_name"] or "")
        expected_bureau = PREFECTURE_TO_REGIONAL_BUREAU.get(prefecture_name, "")
        normalized_name = str(coefficient["normalized_institution_name"] or "")
        canonical_name = _canonical_institution_name(normalized_name)
        expected_registry = [
            row for row in registry_rows if row["regional_bureau"] == expected_bureau
        ]
        exact_candidates = [
            row for row in expected_registry if row["normalized_institution_name"] == normalized_name
        ]
        canonical_candidates = [
            row
            for row in expected_registry
            if canonical_name and row["canonical_institution_name"] == canonical_name
        ]
        cross_bureau_candidates = [
            row
            for row in registry_rows
            if row["regional_bureau"] != expected_bureau
            and (
                row["normalized_institution_name"] == normalized_name
                or (
                    canonical_name
                    and row["canonical_institution_name"] == canonical_name
                )
            )
        ]

        if not expected_bureau:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="unknown_prefecture",
                    recommended_action="manual_map_prefecture_to_regional_bureau",
                    candidates=[],
                    match_basis="prefecture_name",
                )
            )
        elif len(exact_candidates) == 1:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="exact_match",
                    recommended_action="none",
                    candidates=exact_candidates,
                    match_basis="normalized_name",
                )
            )
        elif len(exact_candidates) > 1:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="ambiguous_exact_name",
                    recommended_action="manual_select_registry_record",
                    candidates=exact_candidates,
                    match_basis="normalized_name",
                )
            )
        elif len(canonical_candidates) == 1:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="canonical_name_candidate",
                    recommended_action="apply_name_alias_after_review",
                    candidates=canonical_candidates,
                    match_basis="legal_entity_stripped_name",
                )
            )
        elif len(canonical_candidates) > 1:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="ambiguous_canonical_name",
                    recommended_action="manual_select_registry_record",
                    candidates=canonical_candidates,
                    match_basis="legal_entity_stripped_name",
                )
            )
        elif cross_bureau_candidates:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="expected_bureau_missing_cross_bureau_candidate",
                    recommended_action="manual_review_prefecture_or_registry_source",
                    candidates=cross_bureau_candidates,
                    match_basis="cross_bureau_name",
                )
            )
        elif not expected_registry:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="expected_bureau_registry_empty",
                    recommended_action="refresh_or_add_expected_bureau_registry_source",
                    candidates=[],
                    match_basis="regional_bureau",
                )
            )
        else:
            audit_rows.append(
                _audit_row(
                    coefficient,
                    expected_bureau=expected_bureau,
                    match_status="expected_bureau_name_not_found",
                    recommended_action="refresh_or_add_expected_bureau_registry_source",
                    candidates=[],
                    match_basis="expected_bureau_name",
                )
            )

    return audit_rows


def dpc_hospital_coefficient_registry_audit_to_markdown(
    rows: list[DpcHospitalCoefficientRegistryAuditRow],
    *,
    include_matched: bool = False,
) -> str:
    status_counts = Counter(row.match_status for row in rows)
    action_counts = Counter(row.recommended_action for row in rows)
    actionable_rows = [
        row for row in rows if include_matched or row.match_status != "exact_match"
    ]
    lines = [
        "# DPC Hospital Coefficient Registry Audit",
        "",
        f"Total coefficient rows: {len(rows)}",
        f"Rows requiring action: {sum(1 for row in rows if row.match_status != 'exact_match')}",
        "",
        "## Match Status",
        "",
        "| Status | Count |",
        "| --- | ---: |",
    ]
    for status, count in sorted(status_counts.items()):
        lines.append(f"| {status} | {count} |")

    lines.extend(("", "## Recommended Actions", "", "| Action | Count |", "| --- | ---: |"))
    for action, count in sorted(action_counts.items()):
        lines.append(f"| {action} | {count} |")

    lines.extend(
        (
            "",
            "## Rows",
            "",
            (
                "| Row | Prefecture | Bureau | Group | Institution | Status | "
                "Action | Candidates |"
            ),
            "| ---: | --- | --- | --- | --- | --- | --- | --- |",
        )
    )
    for row in actionable_rows:
        candidates = _audit_candidate_summary(row)
        lines.append(
            "| "
            + " | ".join(
                (
                    str(row.row_index),
                    _escape_markdown_table_cell(row.prefecture_name),
                    _escape_markdown_table_cell(row.expected_regional_bureau),
                    _escape_markdown_table_cell(row.hospital_group),
                    _escape_markdown_table_cell(row.institution_name),
                    row.match_status,
                    row.recommended_action,
                    _escape_markdown_table_cell(candidates),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def dpc_hospital_coefficient_registry_audit_to_json(
    rows: list[DpcHospitalCoefficientRegistryAuditRow],
) -> str:
    return json.dumps([row.to_dict() for row in rows], ensure_ascii=False, indent=2) + "\n"


def dpc_hospital_coefficient_registry_audit_to_csv(
    rows: list[DpcHospitalCoefficientRegistryAuditRow],
) -> str:
    return _audit_rows_to_delimited(rows, delimiter=",")


def dpc_hospital_coefficient_registry_audit_to_tsv(
    rows: list[DpcHospitalCoefficientRegistryAuditRow],
) -> str:
    return _audit_rows_to_delimited(rows, delimiter="\t")


def plan_dpc_hospital_coefficient_registry_fixes(
    conn: sqlite3.Connection,
    *,
    source_id: int | None = None,
    include_connected: bool = False,
) -> list[DpcHospitalCoefficientRegistryFixPlanRow]:
    audit_rows = audit_dpc_hospital_coefficient_registry_matches(
        conn,
        source_id=source_id,
    )
    facility_rows = _facility_standard_candidate_rows(conn)
    plan_rows: list[DpcHospitalCoefficientRegistryFixPlanRow] = []
    for row in audit_rows:
        if row.match_status == "exact_match":
            if include_connected:
                plan_rows.append(
                    _fix_plan_row(
                        row,
                        fix_category="already_connected",
                        recommended_action="none",
                        candidate_source="hospital_registry",
                        candidate_count=row.candidate_count,
                        candidate_regional_bureau=row.candidate_regional_bureau,
                        candidate_medical_institution_code=(
                            row.candidate_medical_institution_code
                        ),
                        candidate_institution_name=row.candidate_institution_name,
                        candidate_basis=row.match_basis,
                    )
                )
            continue

        if row.match_status == "canonical_name_candidate":
            plan_rows.append(
                _fix_plan_row(
                    row,
                    fix_category="registry_name_alias_candidate",
                    recommended_action="review_then_add_registry_name_alias",
                    candidate_source="hospital_registry",
                    candidate_count=row.candidate_count,
                    candidate_regional_bureau=row.candidate_regional_bureau,
                    candidate_medical_institution_code=row.candidate_medical_institution_code,
                    candidate_institution_name=row.candidate_institution_name,
                    candidate_basis=row.match_basis,
                )
            )
            continue

        if row.match_status in (
            "ambiguous_exact_name",
            "ambiguous_canonical_name",
        ):
            plan_rows.append(
                _fix_plan_row(
                    row,
                    fix_category="manual_registry_candidate_selection",
                    recommended_action="select_registry_record_by_address_or_code",
                    candidate_source="hospital_registry",
                    candidate_count=row.candidate_count,
                    candidate_regional_bureau=row.candidate_regional_bureau,
                    candidate_medical_institution_code=row.candidate_medical_institution_code,
                    candidate_institution_name=row.candidate_institution_name,
                    candidate_basis=row.match_basis,
                )
            )
            continue

        if row.match_status == "expected_bureau_missing_cross_bureau_candidate":
            plan_rows.append(
                _fix_plan_row(
                    row,
                    fix_category="manual_prefecture_or_registry_source_review",
                    recommended_action="review_prefecture_mapping_or_expected_bureau_source",
                    candidate_source="hospital_registry",
                    candidate_count=row.candidate_count,
                    candidate_regional_bureau=row.candidate_regional_bureau,
                    candidate_medical_institution_code=row.candidate_medical_institution_code,
                    candidate_institution_name=row.candidate_institution_name,
                    candidate_basis=row.match_basis,
                )
            )
            continue

        if row.match_status == "unknown_prefecture":
            plan_rows.append(
                _fix_plan_row(
                    row,
                    fix_category="prefecture_mapping_gap",
                    recommended_action="manual_map_prefecture_to_regional_bureau",
                    candidate_source="",
                    candidate_count=0,
                    candidate_regional_bureau="",
                    candidate_medical_institution_code="",
                    candidate_institution_name="",
                    candidate_basis="prefecture_name",
                )
            )
            continue

        facility_match = _facility_standard_match_for_audit_row(row, facility_rows)
        if facility_match is not None:
            fix_category, action, candidates, basis = facility_match
            plan_rows.append(
                _fix_plan_row(
                    row,
                    fix_category=fix_category,
                    recommended_action=action,
                    candidate_source="hospital_facility_standards",
                    candidate_count=len(candidates),
                    candidate_regional_bureau=_join_candidate_field(
                        candidates,
                        "regional_bureau",
                    ),
                    candidate_medical_institution_code=_join_candidate_field(
                        candidates,
                        "medical_institution_code",
                    ),
                    candidate_institution_name=_join_candidate_field(
                        candidates,
                        "institution_name",
                    ),
                    candidate_basis=basis,
                )
            )
            continue

        plan_rows.append(
            _fix_plan_row(
                row,
                fix_category="regional_registry_and_facility_source_gap",
                recommended_action="refresh_or_add_official_registry_and_facility_sources",
                candidate_source="",
                candidate_count=0,
                candidate_regional_bureau="",
                candidate_medical_institution_code="",
                candidate_institution_name="",
                candidate_basis="no_registry_or_facility_standard_name_match",
            )
        )

    return plan_rows


def dpc_hospital_coefficient_registry_fix_plan_to_markdown(
    rows: list[DpcHospitalCoefficientRegistryFixPlanRow],
) -> str:
    category_counts = Counter(row.fix_category for row in rows)
    action_counts = Counter(row.recommended_action for row in rows)
    source_gap_counts = Counter(
        (row.expected_regional_bureau, row.prefecture_name)
        for row in rows
        if row.fix_category == "regional_registry_and_facility_source_gap"
    )
    lines = [
        "# DPC Hospital Coefficient Registry Fix Plan",
        "",
        f"Rows requiring fix/review: {len(rows)}",
        "",
        "## Fix Categories",
        "",
        "| Category | Count |",
        "| --- | ---: |",
    ]
    for category, count in sorted(category_counts.items()):
        lines.append(f"| {category} | {count} |")

    lines.extend(("", "## Recommended Actions", "", "| Action | Count |", "| --- | ---: |"))
    for action, count in sorted(action_counts.items()):
        lines.append(f"| {action} | {count} |")

    if source_gap_counts:
        lines.extend(
            (
                "",
                "## Source Gaps By Bureau/Prefecture",
                "",
                "| Bureau | Prefecture | Count |",
                "| --- | --- | ---: |",
            )
        )
        for (bureau, prefecture), count in sorted(source_gap_counts.items()):
            lines.append(
                f"| {_escape_markdown_table_cell(bureau)} | "
                f"{_escape_markdown_table_cell(prefecture)} | {count} |"
            )

    lines.extend(
        (
            "",
            "## Rows",
            "",
            (
                "| Row | Prefecture | Bureau | Group | Institution | Current Status | "
                "Fix Category | Action | Candidate Source | Candidates |"
            ),
            "| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        )
    )
    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                (
                    str(row.row_index),
                    _escape_markdown_table_cell(row.prefecture_name),
                    _escape_markdown_table_cell(row.expected_regional_bureau),
                    _escape_markdown_table_cell(row.hospital_group),
                    _escape_markdown_table_cell(row.institution_name),
                    row.current_match_status,
                    row.fix_category,
                    row.recommended_action,
                    row.candidate_source,
                    _escape_markdown_table_cell(_fix_plan_candidate_summary(row)),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def dpc_hospital_coefficient_registry_fix_plan_to_json(
    rows: list[DpcHospitalCoefficientRegistryFixPlanRow],
) -> str:
    return json.dumps([row.to_dict() for row in rows], ensure_ascii=False, indent=2) + "\n"


def dpc_hospital_coefficient_registry_fix_plan_to_csv(
    rows: list[DpcHospitalCoefficientRegistryFixPlanRow],
) -> str:
    return _fix_plan_rows_to_delimited(rows, delimiter=",")


def dpc_hospital_coefficient_registry_fix_plan_to_tsv(
    rows: list[DpcHospitalCoefficientRegistryFixPlanRow],
) -> str:
    return _fix_plan_rows_to_delimited(rows, delimiter="\t")


def _read_dict_rows(path: Path, *, encoding: str) -> list[dict[str, str]]:
    text = path.read_text(encoding=encoding)
    sample = text[:4096]
    delimiter = "\t" if sample.count("\t") > sample.count(",") else ","
    reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
    return [
        {str(key or "").strip(): str(value or "").strip() for key, value in row.items()}
        for row in reader
        if any(str(value or "").strip() for value in row.values())
    ]


def _coefficient_record(
    source_id: int,
    row_index: int,
    row: dict[str, str],
) -> tuple[Any, ...] | None:
    institution_name = _field(row, "institution_name")
    if not institution_name:
        return None

    base = _float_field(row, "base_coefficient")
    function_i = _float_field(row, "functional_evaluation_coefficient_i")
    function_ii = _float_field(row, "functional_evaluation_coefficient_ii")
    emergency = _float_field(row, "emergency_correction_coefficient")
    mitigation = _float_field(row, "mitigation_coefficient")
    total = _float_field(row, "total_coefficient")
    if total is None:
        total = _sum_optional_coefficients(base, function_i, function_ii, emergency, mitigation)
    if total is None or total <= 0:
        return None

    raw_code = _field(row, "medical_institution_code")
    institution_code = normalize_medical_institution_code(raw_code) if raw_code else ""

    return (
        source_id,
        row_index,
        _field(row, "prefecture_name"),
        institution_code or None,
        institution_name,
        normalize_institution_name(institution_name),
        _field(row, "hospital_group"),
        base,
        function_i,
        function_ii,
        emergency,
        mitigation,
        total,
        _compact_date(_field(row, "effective_from") or ""),
        _compact_date(_field(row, "effective_to") or ""),
        json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
    )


def _field(row: dict[str, str], canonical_name: str) -> str | None:
    for alias in _COLUMN_ALIASES[canonical_name]:
        value = row.get(alias)
        if value:
            return value.strip()
    return None


def _float_field(row: dict[str, str], canonical_name: str) -> float | None:
    value = _field(row, canonical_name)
    if value is None:
        return None
    cleaned = value.replace(",", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _sum_optional_coefficients(*values: float | None) -> float | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    return round(sum(present), 6)


def _latest_dpc_coefficient_source_id(conn: sqlite3.Connection) -> int | None:
    row = conn.execute(
        """
        SELECT id
        FROM master_sources
        WHERE source_type = ?
        ORDER BY imported_at DESC, id DESC
        LIMIT 1
        """,
        (DPC_HOSPITAL_COEFFICIENT_SOURCE_TYPE,),
    ).fetchone()
    return int(row["id"]) if row is not None else None


def _registry_candidate_rows(conn: sqlite3.Connection) -> list[dict[str, str]]:
    placeholders = ", ".join("?" for _ in HOSPITAL_INSTITUTION_TYPES)
    rows = conn.execute(
        f"""
        SELECT
            regional_bureau,
            medical_institution_code,
            institution_name,
            institution_type
        FROM hospital_registry
        WHERE institution_type IN ({placeholders})
          AND status = '現存'
        ORDER BY regional_bureau, medical_institution_code, institution_name
        """,
        HOSPITAL_INSTITUTION_TYPES,
    ).fetchall()
    return [
        {
            "regional_bureau": str(row["regional_bureau"] or ""),
            "medical_institution_code": str(row["medical_institution_code"] or ""),
            "institution_name": str(row["institution_name"] or ""),
            "institution_type": str(row["institution_type"] or ""),
            "normalized_institution_name": normalize_institution_name(row["institution_name"]),
            "canonical_institution_name": _canonical_institution_name(row["institution_name"]),
        }
        for row in rows
    ]


def _facility_standard_candidate_rows(conn: sqlite3.Connection) -> list[dict[str, str]]:
    rows = conn.execute(
        """
        SELECT DISTINCT
            regional_bureau,
            medical_institution_code,
            institution_name
        FROM hospital_facility_standards
        WHERE medical_institution_code IS NOT NULL
          AND medical_institution_code <> ''
          AND institution_name IS NOT NULL
          AND institution_name <> ''
        ORDER BY regional_bureau, medical_institution_code, institution_name
        """
    ).fetchall()
    return [
        {
            "regional_bureau": str(row["regional_bureau"] or ""),
            "medical_institution_code": str(row["medical_institution_code"] or ""),
            "institution_name": str(row["institution_name"] or ""),
            "normalized_institution_name": normalize_institution_name(row["institution_name"]),
            "canonical_institution_name": _canonical_institution_name(row["institution_name"]),
        }
        for row in rows
    ]


def _audit_row(
    coefficient: sqlite3.Row,
    *,
    expected_bureau: str,
    match_status: str,
    recommended_action: str,
    candidates: list[dict[str, str]],
    match_basis: str,
) -> DpcHospitalCoefficientRegistryAuditRow:
    return DpcHospitalCoefficientRegistryAuditRow(
        source_id=int(coefficient["source_id"]),
        row_index=int(coefficient["row_index"]),
        prefecture_name=str(coefficient["prefecture_name"] or ""),
        expected_regional_bureau=expected_bureau,
        institution_name=str(coefficient["institution_name"] or ""),
        hospital_group=str(coefficient["hospital_group"] or ""),
        total_coefficient=float(coefficient["total_coefficient"]),
        match_status=match_status,
        recommended_action=recommended_action,
        candidate_count=len(candidates),
        candidate_regional_bureau=_join_candidate_field(candidates, "regional_bureau"),
        candidate_medical_institution_code=_join_candidate_field(
            candidates, "medical_institution_code"
        ),
        candidate_institution_name=_join_candidate_field(candidates, "institution_name"),
        candidate_institution_type=_join_candidate_field(candidates, "institution_type"),
        match_basis=match_basis,
    )


def _facility_standard_match_for_audit_row(
    row: DpcHospitalCoefficientRegistryAuditRow,
    facility_rows: list[dict[str, str]],
) -> tuple[str, str, list[dict[str, str]], str] | None:
    normalized_name = normalize_institution_name(row.institution_name)
    canonical_name = _canonical_institution_name(row.institution_name)
    same_bureau_rows = [
        candidate
        for candidate in facility_rows
        if candidate["regional_bureau"] == row.expected_regional_bureau
    ]
    exact_candidates = [
        candidate
        for candidate in same_bureau_rows
        if candidate["normalized_institution_name"] == normalized_name
    ]
    if len(exact_candidates) == 1:
        return (
            "registry_code_backfill_from_facility_standard",
            "review_then_add_registry_row_or_code_alias_from_facility_standard",
            exact_candidates,
            "facility_standard_normalized_name",
        )
    if len(exact_candidates) > 1:
        return (
            "manual_facility_standard_candidate_selection",
            "select_facility_standard_record_by_address_or_code",
            exact_candidates,
            "facility_standard_normalized_name",
        )

    canonical_candidates = [
        candidate
        for candidate in same_bureau_rows
        if canonical_name
        and candidate["canonical_institution_name"] == canonical_name
    ]
    if len(canonical_candidates) == 1:
        return (
            "registry_code_backfill_from_facility_standard",
            "review_then_add_registry_row_or_code_alias_from_facility_standard",
            canonical_candidates,
            "facility_standard_legal_entity_stripped_name",
        )
    if len(canonical_candidates) > 1:
        return (
            "manual_facility_standard_candidate_selection",
            "select_facility_standard_record_by_address_or_code",
            canonical_candidates,
            "facility_standard_legal_entity_stripped_name",
        )
    return None


def _fix_plan_row(
    row: DpcHospitalCoefficientRegistryAuditRow,
    *,
    fix_category: str,
    recommended_action: str,
    candidate_source: str,
    candidate_count: int,
    candidate_regional_bureau: str,
    candidate_medical_institution_code: str,
    candidate_institution_name: str,
    candidate_basis: str,
) -> DpcHospitalCoefficientRegistryFixPlanRow:
    return DpcHospitalCoefficientRegistryFixPlanRow(
        source_id=row.source_id,
        row_index=row.row_index,
        prefecture_name=row.prefecture_name,
        expected_regional_bureau=row.expected_regional_bureau,
        institution_name=row.institution_name,
        hospital_group=row.hospital_group,
        total_coefficient=row.total_coefficient,
        current_match_status=row.match_status,
        fix_category=fix_category,
        recommended_action=recommended_action,
        candidate_source=candidate_source,
        candidate_count=candidate_count,
        candidate_regional_bureau=candidate_regional_bureau,
        candidate_medical_institution_code=candidate_medical_institution_code,
        candidate_institution_name=candidate_institution_name,
        candidate_basis=candidate_basis,
    )


def _canonical_institution_name(value: str | None) -> str:
    text = normalize_institution_name(value)
    for token in _LEGAL_ENTITY_TOKENS:
        text = text.replace(token, "")
    text = re.sub(r"[・･,，、.．]", "", text)
    return text


def _join_candidate_field(candidates: list[dict[str, str]], field_name: str) -> str:
    return ";".join(candidate[field_name] for candidate in candidates)


def _audit_candidate_summary(row: DpcHospitalCoefficientRegistryAuditRow) -> str:
    if not row.candidate_count:
        return ""
    codes = row.candidate_medical_institution_code.split(";")
    names = row.candidate_institution_name.split(";")
    bureaus = row.candidate_regional_bureau.split(";")
    return "; ".join(
        f"{bureau}:{code}:{name}"
        for bureau, code, name in zip(bureaus, codes, names, strict=False)
    )


def _fix_plan_candidate_summary(row: DpcHospitalCoefficientRegistryFixPlanRow) -> str:
    if not row.candidate_count:
        return ""
    codes = row.candidate_medical_institution_code.split(";")
    names = row.candidate_institution_name.split(";")
    bureaus = row.candidate_regional_bureau.split(";")
    return "; ".join(
        f"{bureau}:{code}:{name}"
        for bureau, code, name in zip(bureaus, codes, names, strict=False)
    )


def _audit_rows_to_delimited(
    rows: list[DpcHospitalCoefficientRegistryAuditRow],
    *,
    delimiter: str,
) -> str:
    fieldnames = list(DpcHospitalCoefficientRegistryAuditRow.__dataclass_fields__)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, delimiter=delimiter)
    writer.writeheader()
    for row in rows:
        writer.writerow(row.to_dict())
    return output.getvalue()


def _fix_plan_rows_to_delimited(
    rows: list[DpcHospitalCoefficientRegistryFixPlanRow],
    *,
    delimiter: str,
) -> str:
    fieldnames = list(DpcHospitalCoefficientRegistryFixPlanRow.__dataclass_fields__)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, delimiter=delimiter)
    writer.writeheader()
    for row in rows:
        writer.writerow(row.to_dict())
    return output.getvalue()


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ")


def _notice_row_from_match(
    match: re.Match[str],
    *,
    current_group: str | None,
    line_number: int,
    raw_text: str,
    effective_from: str | None,
    effective_to: str | None,
) -> DpcCoefficientNoticeRow:
    base = float(match.group("base"))
    function_ii = float(match.group("function_ii"))
    emergency = float(match.group("emergency"))
    mitigation = float(match.group("mitigation"))
    return DpcCoefficientNoticeRow(
        notice_code=match.group("notice_code"),
        prefecture_name=match.group("prefecture"),
        institution_name=match.group("institution_name").strip(),
        hospital_group=current_group,
        base_coefficient=base,
        functional_evaluation_coefficient_ii=function_ii,
        emergency_correction_coefficient=emergency,
        mitigation_coefficient=mitigation,
        total_coefficient=round(base + function_ii + emergency + mitigation, 6),
        effective_from=_compact_date(effective_from or "") or effective_from,
        effective_to=_compact_date(effective_to or "") or effective_to,
        source_line=line_number,
        raw_text=raw_text,
    )


def _extract_text_from_pdf(pdf_path: Path) -> tuple[str, str]:
    converters = (
        ("pdftotext", ("pdftotext", "-layout", str(pdf_path), "-")),
        ("mutool", ("mutool", "draw", "-F", "text", "-o", "-", str(pdf_path))),
        ("mdls", ("mdls", "-raw", "-name", "kMDItemTextContent", str(pdf_path))),
    )
    errors: list[str] = []
    for name, command in converters:
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except FileNotFoundError:
            errors.append(f"{name}: command not found")
            continue
        except subprocess.SubprocessError as exc:
            errors.append(f"{name}: {exc}")
            continue
        if completed.returncode == 0 and completed.stdout.strip() and completed.stdout.strip() != "(null)":
            return completed.stdout, name
        errors.append(
            f"{name}: exit={completed.returncode} stderr={completed.stderr.strip()[:200]}"
        )

    try:
        text = _extract_text_from_pdf_with_cmaps(pdf_path)
    except (OSError, ValueError, zlib.error) as exc:
        errors.append(f"python-cmap: {exc}")
    else:
        if text.strip():
            return text, "python-cmap"
        errors.append("python-cmap: extracted text was empty")

    raise RuntimeError("could not extract text from PDF: " + " / ".join(errors))


def _extract_text_from_pdf_with_cmaps(pdf_path: Path) -> str:
    data = pdf_path.read_bytes()
    objects = _read_pdf_objects(data)
    if not objects:
        raise ValueError("no PDF objects found")

    cmaps = _parse_to_unicode_cmaps(objects)
    if not cmaps:
        raise ValueError("no ToUnicode CMaps found")

    font_to_cmap_object = _font_to_cmap_objects(objects)
    chunks: list[tuple[int, float, float, str]] = []
    for page_index, contents, resources in _pdf_pages(objects):
        font_cmaps = _resource_font_cmaps(
            objects.get(resources, b""),
            font_to_cmap_object=font_to_cmap_object,
            cmaps=cmaps,
        )
        for content_id in contents:
            try:
                content = _decode_pdf_stream(objects.get(content_id, b""))
            except zlib.error:
                continue
            if content is None:
                continue
            chunks.extend(_pdf_text_chunks(content, page_index, font_cmaps))

    return "\n".join(_pdf_chunks_to_lines(chunks))


def _read_pdf_objects(data: bytes) -> dict[int, bytes]:
    return {int(match.group(1)): match.group(2) for match in _PDF_OBJECT_RE.finditer(data)}


def _decode_pdf_stream(body: bytes) -> bytes | None:
    match = _PDF_STREAM_RE.search(body)
    if match is None:
        return None
    stream = match.group(1)
    if stream.startswith(b"\r\n"):
        stream = stream[2:]
    elif stream.startswith(b"\n") or stream.startswith(b"\r"):
        stream = stream[1:]
    if stream.endswith(b"\r\n"):
        stream = stream[:-2]
    elif stream.endswith(b"\n") or stream.endswith(b"\r"):
        stream = stream[:-1]

    if b"/FlateDecode" in body:
        return zlib.decompress(stream)
    return stream


def _parse_to_unicode_cmaps(objects: dict[int, bytes]) -> dict[int, dict[str, str]]:
    cmaps: dict[int, dict[str, str]] = {}
    for object_id, body in objects.items():
        try:
            decoded = _decode_pdf_stream(body)
        except zlib.error:
            continue
        if decoded is None or b"begincmap" not in decoded:
            continue
        cmap = _parse_to_unicode_cmap_text(decoded.decode("latin1", errors="replace"))
        if cmap:
            cmaps[object_id] = cmap
    return cmaps


def _parse_to_unicode_cmap_text(text: str) -> dict[str, str]:
    cmap: dict[str, str] = {}
    for block_match in re.finditer(r"beginbfchar(.*?)endbfchar", text, re.S):
        block = block_match.group(1)
        for source, target in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            decoded = _decode_utf16_hex(target)
            if decoded:
                cmap[source.upper()] = decoded

    for block_match in re.finditer(r"beginbfrange(.*?)endbfrange", text, re.S):
        block = block_match.group(1)
        for line in block.splitlines():
            range_match = re.search(
                r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[.*\]|<[0-9A-Fa-f]+>)",
                line,
            )
            if range_match is None:
                continue
            start_hex, end_hex, target = range_match.groups()
            start = int(start_hex, 16)
            end = int(end_hex, 16)
            width = len(start_hex)
            if target.startswith("["):
                targets = re.findall(r"<([0-9A-Fa-f]+)>", target)
                for offset, target_hex in enumerate(targets):
                    decoded = _decode_utf16_hex(target_hex)
                    if decoded:
                        cmap[f"{start + offset:0{width}X}"] = decoded
            else:
                first = _decode_utf16_hex(target.strip("<>"))
                if not first or len(first) != 1:
                    continue
                for code in range(start, end + 1):
                    cmap[f"{code:0{width}X}"] = chr(ord(first) + code - start)
    return cmap


def _decode_utf16_hex(hex_text: str) -> str:
    try:
        return bytes.fromhex(hex_text).decode("utf-16-be")
    except UnicodeDecodeError:
        return ""


def _font_to_cmap_objects(objects: dict[int, bytes]) -> dict[int, int]:
    font_to_cmap: dict[int, int] = {}
    for object_id, body in objects.items():
        match = re.search(rb"/ToUnicode\s+(\d+)\s+0\s+R", body)
        if match is not None:
            font_to_cmap[object_id] = int(match.group(1))
    return font_to_cmap


def _pdf_pages(objects: dict[int, bytes]) -> list[tuple[int, tuple[int, ...], int]]:
    pages: list[tuple[int, tuple[int, ...], int]] = []
    for object_id in sorted(objects):
        body = objects[object_id]
        if b"/Type/Page" not in body or b"/Contents" not in body:
            continue
        resources_match = re.search(rb"/Resources\s+(\d+)\s+0\s+R", body)
        if resources_match is None:
            continue
        contents: list[int] = []
        array_match = re.search(rb"/Contents\s*\[(.*?)\]", body, re.S)
        if array_match is not None:
            contents.extend(
                int(match.group(1))
                for match in re.finditer(rb"(\d+)\s+0\s+R", array_match.group(1))
            )
        else:
            content_match = re.search(rb"/Contents\s+(\d+)\s+0\s+R", body)
            if content_match is not None:
                contents.append(int(content_match.group(1)))
        if contents:
            pages.append((len(pages) + 1, tuple(contents), int(resources_match.group(1))))
    return pages


def _resource_font_cmaps(
    resource_body: bytes,
    *,
    font_to_cmap_object: dict[int, int],
    cmaps: dict[int, dict[str, str]],
) -> dict[str, dict[str, str]]:
    font_cmaps: dict[str, dict[str, str]] = {}
    font_section_match = re.search(rb"/Font\s*<<(.*?)>>", resource_body, re.S)
    if font_section_match is None:
        return font_cmaps
    for match in re.finditer(rb"/([A-Za-z0-9_.#]+)\s+(\d+)\s+0\s+R", font_section_match.group(1)):
        alias = match.group(1).decode("ascii", errors="ignore")
        font_object_id = int(match.group(2))
        cmap_object_id = font_to_cmap_object.get(font_object_id)
        if cmap_object_id is None:
            continue
        cmap = cmaps.get(cmap_object_id)
        if cmap:
            font_cmaps[alias] = cmap
    return font_cmaps


def _pdf_text_chunks(
    content: bytes,
    page_index: int,
    font_cmaps: dict[str, dict[str, str]],
) -> list[tuple[int, float, float, str]]:
    chunks: list[tuple[int, float, float, str]] = []
    stack: list[bytes] = []
    current_font: str | None = None
    x = 0.0
    y = 0.0

    for token_match in _PDF_TOKEN_RE.finditer(content):
        token = token_match.group(0)
        if _is_pdf_operator(token):
            if token == b"Tf":
                font = _last_pdf_name(stack)
                if font:
                    current_font = font
            elif token == b"Tm":
                numbers = _last_pdf_numbers(stack, 6)
                if numbers is not None:
                    x = numbers[4]
                    y = numbers[5]
            elif token == b"Td":
                numbers = _last_pdf_numbers(stack, 2)
                if numbers is not None:
                    x += numbers[0]
                    y += numbers[1]
            elif token == b"Tj":
                text = _decode_pdf_text_operand(_last_pdf_hex(stack), current_font, font_cmaps)
                if text:
                    chunks.append((page_index, y, x, text))
            elif token == b"TJ":
                text = _decode_pdf_text_array(_last_pdf_array(stack), current_font, font_cmaps)
                if text:
                    chunks.append((page_index, y, x, text))
            stack.clear()
            continue
        stack.append(token)
    return chunks


def _is_pdf_operator(token: bytes) -> bool:
    if not token or token[:1] in {b"/", b"<", b"[", b"]"}:
        return False
    return re.match(rb"^[A-Za-z][A-Za-z0-9*']*$", token) is not None


def _last_pdf_name(stack: list[bytes]) -> str | None:
    for token in reversed(stack):
        if token.startswith(b"/"):
            return token[1:].decode("ascii", errors="ignore")
    return None


def _last_pdf_numbers(stack: list[bytes], count: int) -> tuple[float, ...] | None:
    numbers: list[float] = []
    for token in reversed(stack):
        try:
            numbers.append(float(token.decode("ascii")))
        except ValueError:
            continue
        if len(numbers) == count:
            return tuple(reversed(numbers))
    return None


def _last_pdf_hex(stack: list[bytes]) -> bytes | None:
    for token in reversed(stack):
        if token.startswith(b"<") and token.endswith(b">") and not token.startswith(b"<<"):
            return token
    return None


def _last_pdf_array(stack: list[bytes]) -> bytes | None:
    for token in reversed(stack):
        if token.startswith(b"[") and token.endswith(b"]"):
            return token
    return None


def _decode_pdf_text_operand(
    hex_token: bytes | None,
    current_font: str | None,
    font_cmaps: dict[str, dict[str, str]],
) -> str:
    if hex_token is None or current_font is None:
        return ""
    cmap = font_cmaps.get(current_font)
    if not cmap:
        return ""
    hex_text = re.sub(rb"\s+", b"", hex_token.strip(b"<>")).decode("ascii", errors="ignore")
    return _decode_pdf_hex_text(hex_text, cmap)


def _decode_pdf_text_array(
    array_token: bytes | None,
    current_font: str | None,
    font_cmaps: dict[str, dict[str, str]],
) -> str:
    if array_token is None:
        return ""
    parts = [
        _decode_pdf_text_operand(match.group(0), current_font, font_cmaps)
        for match in re.finditer(rb"<[0-9A-Fa-f\s]+>", array_token)
    ]
    return "".join(parts)


def _decode_pdf_hex_text(hex_text: str, cmap: dict[str, str]) -> str:
    if not hex_text:
        return ""
    widths = sorted({len(code) for code in cmap}, reverse=True)
    if not widths:
        return ""

    i = 0
    decoded: list[str] = []
    while i < len(hex_text):
        for width in widths:
            code = hex_text[i : i + width].upper()
            if len(code) == width and code in cmap:
                decoded.append(cmap[code])
                i += width
                break
        else:
            i += widths[-1]
    return "".join(decoded)


def _pdf_chunks_to_lines(chunks: list[tuple[int, float, float, str]]) -> list[str]:
    grouped: dict[tuple[int, float], list[tuple[float, str]]] = {}
    for page_index, y, x, text in chunks:
        if not text:
            continue
        key = (page_index, round(y, 1))
        grouped.setdefault(key, []).append((x, text))

    lines: list[str] = []
    current_page = 0
    for page_index, y in sorted(grouped, key=lambda item: (item[0], -item[1])):
        if page_index != current_page:
            if lines:
                lines.append("")
            current_page = page_index
        line = "".join(text for _, text in sorted(grouped[(page_index, y)], key=lambda item: item[0]))
        lines.append(line.rstrip())
    return lines


def _clean_notice_text_line(line: str) -> str:
    text = line.strip()
    text = re.sub(r"^L\d+@P[\d-]+:\s*", "", text)
    text = text.replace("\u3000", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _line_starts_notice_row(line: str) -> bool:
    return re.match(rf"^\d{{4,5}}\s*(?:{_PREFECTURE_PATTERN})", line) is not None


def _maybe_update_table_label(current_group: str | None, line: str) -> str | None:
    if not line or "から" in line:
        return current_group
    match = _TABLE_LABEL_RE.search(line)
    if match is None:
        return current_group
    return _TABLE_LABELS.get(match.group(1), current_group)


def _format_coefficient(value: float) -> str:
    return f"{value:.4f}"
