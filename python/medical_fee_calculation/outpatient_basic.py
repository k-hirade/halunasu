from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    ClaimItemStatus,
    OutpatientBasicFeeKind,
    OutpatientBasicFeeOptionContext,
)


@dataclass(frozen=True)
class OutpatientBasicFeeResult:
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...]


OUTPATIENT_BASIC_FEE_CODES = {
    (OutpatientBasicFeeKind.INITIAL, False, False, False, False): "111000110",
    (OutpatientBasicFeeKind.INITIAL, True, False, False, False): "111014210",
    (OutpatientBasicFeeKind.INITIAL, False, True, False, False): "111011810",
    (OutpatientBasicFeeKind.INITIAL, True, True, False, False): "111014510",
    (OutpatientBasicFeeKind.INITIAL, False, False, False, True): "111012510",
    (OutpatientBasicFeeKind.INITIAL, True, False, False, True): "111014310",
    (OutpatientBasicFeeKind.INITIAL, False, True, False, True): "111012610",
    (OutpatientBasicFeeKind.INITIAL, True, True, False, True): "111014610",
    (OutpatientBasicFeeKind.REVISIT, False, False, False, False): "112007410",
    (OutpatientBasicFeeKind.REVISIT, True, False, False, False): "112024210",
    (OutpatientBasicFeeKind.REVISIT, False, False, True, False): "112008350",
    (OutpatientBasicFeeKind.REVISIT, True, False, True, False): "112024950",
    (OutpatientBasicFeeKind.REVISIT, False, True, False, False): "112015810",
    (OutpatientBasicFeeKind.REVISIT, True, True, False, False): "112025210",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, False, False, False, False): "112011310",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, True, False, False, False): "112024710",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, False, False, True, False): "112011710",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, True, False, True, False): "112025450",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, False, True, False, False): "112016210",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, True, True, False, False): "112025910",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, False, False, False, True): "112016310",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, True, False, False, True): "112025510",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, False, False, True, True): "112016550",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, True, False, True, True): "112025650",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, False, True, False, True): "112016410",
    (OutpatientBasicFeeKind.OUTPATIENT_CLINIC, True, True, False, True): "112026010",
}

OUTPATIENT_BASIC_FEE_CODE_SET = frozenset(OUTPATIENT_BASIC_FEE_CODES.values())
OUTPATIENT_MANAGEMENT_ADD_ON_CODE = "112011010"
OUTPATIENT_MANAGEMENT_BLOCKING_LINE_SOURCES = frozenset(
    {
        "d026",
        "lab_management",
        "collection_fee",
        "outpatient_rapid_lab",
        "injection_fee",
        "treatment_fee",
        "imaging_fee",
        "inpatient_basic_fee",
        "dpc_estimate",
        "dpc_claim",
    }
)
OUTPATIENT_MANAGEMENT_BLOCKING_CODE_PREFIXES = ("13", "14", "15", "16", "17")


def calculate_outpatient_basic_fee(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    service_date: date,
    context: OutpatientBasicFeeOptionContext,
    *,
    is_outpatient: bool,
    source_id: int | None = None,
) -> OutpatientBasicFeeResult:
    """Return an outpatient initial/revisit/basic visit fee candidate."""

    if context.fee_kind is None:
        return OutpatientBasicFeeResult(lines=(), messages=())

    if not is_outpatient:
        return OutpatientBasicFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=None,
                    message="Outpatient basic fee skipped: outpatient encounter is required",
                    source="outpatient_basic_fee",
                ),
            ),
        )

    present_basic_fee_codes = sorted(
        code for code in _unique_codes(tuple(procedure_codes)) if code in OUTPATIENT_BASIC_FEE_CODE_SET
    )
    if present_basic_fee_codes:
        return OutpatientBasicFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=present_basic_fee_codes[0],
                    message=f"Outpatient basic fee skipped: already present in claim {present_basic_fee_codes[0]}",
                    source="outpatient_basic_fee",
                ),
            ),
        )

    procedure_code = _select_outpatient_basic_fee_code(context)
    if procedure_code is None:
        return OutpatientBasicFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=None,
                    message="Outpatient basic fee combination is not supported yet",
                    source="outpatient_basic_fee",
                ),
            ),
        )

    row = _find_medical_procedure(conn, procedure_code, service_date, source_id)
    if row is None:
        return OutpatientBasicFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=procedure_code,
                    message=f"Outpatient basic fee code not found for service date: {procedure_code}",
                    source="outpatient_basic_fee",
                ),
            ),
        )

    return OutpatientBasicFeeResult(
        lines=(
            CalculationLine(
                code=str(row["code"]),
                name=str(row["short_name"]),
                points=float(row["points"]),
                quantity=1,
                status=ClaimItemStatus.CANDIDATE,
                reason=f"Outpatient basic fee candidate for {context.fee_kind.value}",
                source="outpatient_basic_fee",
            ),
        ),
        messages=(),
    )


def calculate_outpatient_management_add_on(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    service_date: date,
    context: OutpatientBasicFeeOptionContext,
    *,
    is_outpatient: bool,
    existing_lines: tuple[CalculationLine, ...] = (),
    same_day_blocking_service_present: bool = False,
    source_id: int | None = None,
) -> OutpatientBasicFeeResult:
    """Return the outpatient management add-on when same-day structure allows it."""

    if (
        not is_outpatient
        or context.fee_kind != OutpatientBasicFeeKind.REVISIT
        or not context.management_explanation_performed
    ):
        return OutpatientBasicFeeResult(lines=(), messages=())

    if any(line.code == OUTPATIENT_MANAGEMENT_ADD_ON_CODE for line in existing_lines):
        return OutpatientBasicFeeResult(lines=(), messages=())

    if OUTPATIENT_MANAGEMENT_ADD_ON_CODE in _unique_codes(tuple(procedure_codes)):
        return OutpatientBasicFeeResult(lines=(), messages=())

    if same_day_blocking_service_present or _has_same_day_management_blocking_service(
        conn,
        procedure_codes,
        service_date,
        existing_lines=existing_lines,
        source_id=source_id,
    ):
        return OutpatientBasicFeeResult(lines=(), messages=())

    row = _find_medical_procedure(conn, OUTPATIENT_MANAGEMENT_ADD_ON_CODE, service_date, source_id)
    if row is None:
        return OutpatientBasicFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=OUTPATIENT_MANAGEMENT_ADD_ON_CODE,
                    message=f"Outpatient management add-on code not found for service date: {OUTPATIENT_MANAGEMENT_ADD_ON_CODE}",
                    source="outpatient_management_add_on",
                ),
            ),
        )

    return OutpatientBasicFeeResult(
        lines=(
            CalculationLine(
                code=str(row["code"]),
                name=str(row["short_name"]),
                points=float(row["points"]),
                quantity=1,
                status=ClaimItemStatus.CANDIDATE,
                reason="Outpatient management add-on candidate for revisit with documented management explanation",
                source="outpatient_management_add_on",
            ),
        ),
        messages=(),
    )


def _select_outpatient_basic_fee_code(context: OutpatientBasicFeeOptionContext) -> str | None:
    if context.fee_kind is None:
        return None
    if context.fee_kind == OutpatientBasicFeeKind.INITIAL and context.same_day_revisit:
        return None
    if context.fee_kind == OutpatientBasicFeeKind.REVISIT and context.large_hospital_no_referral:
        return None
    key = (
        context.fee_kind,
        context.information_communication_equipment,
        context.same_day_second_department,
        context.same_day_revisit,
        context.large_hospital_no_referral,
    )
    return OUTPATIENT_BASIC_FEE_CODES.get(key)


def _has_same_day_management_blocking_service(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    service_date: date,
    *,
    existing_lines: tuple[CalculationLine, ...],
    source_id: int | None,
) -> bool:
    for line in existing_lines:
        if line.source in OUTPATIENT_MANAGEMENT_BLOCKING_LINE_SOURCES:
            return True
        if (
            line.source == "medical_procedure_master"
            and _procedure_code_blocks_outpatient_management_add_on(
                conn,
                line.code,
                service_date,
                source_id,
            )
        ):
            return True

    for code in _unique_codes(tuple(procedure_codes)):
        if _procedure_code_blocks_outpatient_management_add_on(conn, code, service_date, source_id):
            return True
    return False


def _procedure_code_blocks_outpatient_management_add_on(
    conn: sqlite3.Connection,
    procedure_code: str,
    service_date: date,
    source_id: int | None,
) -> bool:
    code = str(procedure_code or "").strip()
    if not code or code in OUTPATIENT_BASIC_FEE_CODE_SET or code == OUTPATIENT_MANAGEMENT_ADD_ON_CODE:
        return False
    row = _find_medical_procedure(conn, code, service_date, source_id)
    if row is None:
        return False
    return code.startswith(OUTPATIENT_MANAGEMENT_BLOCKING_CODE_PREFIXES)


def _find_medical_procedure(
    conn: sqlite3.Connection,
    procedure_code: str,
    service_date: date,
    source_id: int | None,
) -> sqlite3.Row | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, procedure_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    return conn.execute(
        f"""
        SELECT code, short_name, points
        FROM medical_procedures
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          AND code = ?
          {source_filter}
        ORDER BY source_id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _unique_codes(codes: tuple[str, ...]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for code in codes:
        normalized = str(code or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return tuple(result)
