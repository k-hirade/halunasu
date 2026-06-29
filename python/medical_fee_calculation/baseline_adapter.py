"""既存レセ(レセ電UKE / レセコンCSV)を baselineClaim へ取り込む adapter。

- 両方式に対応(parse_uke / parse_receipt_csv)し、患者×暦月の BaselineClaim 群を返す。
- スコープ前処理: 請求月・医療機関コードでの絞り込みをサポート(他院/他月の混入除外)。
- コード正規化(code_map)はオプション。未指定なら生コードのまま(比較器側でも正規化可能)。

注意: レセ電の項目位置はレセ電バージョン・ベンダーで差があるため、UkeLayout で
フィールド位置を上書きできるようにしている(order-csv 契約と同じ「病院別に検証」の思想)。
既定値は当社 buildReceiptDenshin の出力レイアウトに合わせている。
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field

from medical_fee_calculation.baseline_diagnosis import BaselineClaim, ClaimLine


@dataclass(frozen=True)
class UkeLayout:
    """UKEレコードのフィールド位置(0始まり, index0=レコード識別)。"""

    line_records: frozenset[str] = field(default_factory=lambda: frozenset({"SI", "IY", "TO"}))
    line_code_index: int = 3
    line_points_index: int = 5
    line_count_index: int = 6
    re_record: str = "RE"
    re_name_index: int = 3
    ho_record: str = "HO"
    ho_days_index: int = 5
    ho_points_index: int = 6


def _num(value, fallback=0.0) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return fallback


def _apply_code_map(code: str, code_map: dict[str, str] | None) -> str:
    raw = str(code or "").strip()
    if code_map and raw in code_map:
        return str(code_map[raw]).strip()
    return raw


def parse_uke(
    uke_text: str,
    *,
    claim_month: str,
    layout: UkeLayout | None = None,
    patient_id_resolver=None,
    code_map: dict[str, str] | None = None,
) -> list[BaselineClaim]:
    """レセ電(UKE)テキストを BaselineClaim 群に変換する。

    RE レコードを患者(レセプト)境界として、次の RE までの SI/IY/TO 行を1レセに集約する。
    claim_month(診療月 YYYY-MM)はファイル文脈から既知である前提で必須指定。
    patient_id_resolver(re_fields)->str を渡すと患者IDを上書きできる(既定はRE氏名)。
    """
    layout = layout or UkeLayout()
    claims: list[BaselineClaim] = []
    current_pid: str | None = None
    current_lines: list[ClaimLine] = []
    current_total: float | None = None
    current_days: int | None = None
    seq = 0

    def flush():
        nonlocal current_pid, current_lines, current_total, current_days
        if current_pid is not None:
            claims.append(BaselineClaim(
                patient_id=current_pid,
                claim_month=claim_month,
                lines=tuple(current_lines),
                total_points=current_total,
                actual_days=current_days,
            ))
        current_pid, current_lines, current_total, current_days = None, [], None, None

    for raw_line in str(uke_text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not raw_line.strip():
            continue
        fields = raw_line.split(",")
        record = fields[0].strip()
        if record == layout.re_record:
            flush()
            seq += 1
            if patient_id_resolver is not None:
                current_pid = str(patient_id_resolver(fields) or f"receipt_{seq}")
            else:
                name = fields[layout.re_name_index].strip() if len(fields) > layout.re_name_index else ""
                current_pid = name or f"receipt_{seq}"
            current_lines = []
            current_total = None
            current_days = None
        elif record == layout.ho_record and current_pid is not None:
            if len(fields) > layout.ho_points_index:
                current_total = _num(fields[layout.ho_points_index], None) or None
            if len(fields) > layout.ho_days_index:
                days = _num(fields[layout.ho_days_index], None)
                current_days = int(days) if days else None
        elif record in layout.line_records and current_pid is not None:
            code = _apply_code_map(fields[layout.line_code_index] if len(fields) > layout.line_code_index else "", code_map)
            if not code:
                continue
            points = _num(fields[layout.line_points_index]) if len(fields) > layout.line_points_index else 0.0
            count = _num(fields[layout.line_count_index], 1.0) if len(fields) > layout.line_count_index else 1.0
            current_lines.append(ClaimLine(code=code, points=points, count=count or 1.0))
    flush()
    return claims


# レセコンCSVの論理列 → 実列名のマッピング(病院別に上書き)。
DEFAULT_CSV_COLUMN_MAP = {
    "patient_id": "patient_id",
    "claim_month": "claim_month",
    "code": "code",
    "name": "name",
    "points": "points",
    "count": "count",
    "medical_institution_code": "medical_institution_code",
}


def parse_receipt_csv(
    csv_text: str,
    *,
    column_map: dict[str, str] | None = None,
    only_claim_month: str | None = None,
    only_medical_institution_code: str | None = None,
    default_claim_month: str | None = None,
    code_map: dict[str, str] | None = None,
) -> list[BaselineClaim]:
    """レセコンCSVを BaselineClaim 群に変換する。

    column_map で論理列(patient_id/claim_month/code/name/points/count/medical_institution_code)を
    実CSV列名へマッピング。患者×請求月で集約する。
    スコープ前処理: only_claim_month / only_medical_institution_code で対象外行を除外。
    """
    cmap = {**DEFAULT_CSV_COLUMN_MAP, **(column_map or {})}
    reader = csv.DictReader(io.StringIO(csv_text))
    grouped: dict[tuple[str, str], list[ClaimLine]] = {}
    order: list[tuple[str, str]] = []

    def col(row, logical):
        actual = cmap.get(logical)
        return (row.get(actual, "") if actual else "").strip()

    for row in reader:
        mic = col(row, "medical_institution_code")
        if only_medical_institution_code and mic and mic != only_medical_institution_code:
            continue
        claim_month = col(row, "claim_month") or (default_claim_month or "")
        if only_claim_month and claim_month and claim_month != only_claim_month:
            continue
        patient_id = col(row, "patient_id")
        code = _apply_code_map(col(row, "code"), code_map)
        if not patient_id or not code:
            continue
        key = (patient_id, claim_month)
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(ClaimLine(
            code=code,
            name=col(row, "name"),
            points=_num(col(row, "points")),
            count=_num(col(row, "count"), 1.0) or 1.0,
        ))

    return [
        BaselineClaim(patient_id=pid, claim_month=month, lines=tuple(grouped[(pid, month)]))
        for (pid, month) in order
    ]
