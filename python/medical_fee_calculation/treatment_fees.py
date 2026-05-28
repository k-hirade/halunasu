from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    ClaimItemStatus,
    TreatmentAreaSizeKind,
    TreatmentKind,
    TreatmentOrder,
)


@dataclass(frozen=True)
class TreatmentFeeResult:
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...]


AREA_TREATMENT_FEE_CODES = {
    TreatmentKind.WOUND: {
        TreatmentAreaSizeKind.LT_100_CM2: "140000610",
        TreatmentAreaSizeKind.GE_100_LT_500_CM2: "140000710",
        TreatmentAreaSizeKind.GE_500_LT_3000_CM2: "140000810",
        TreatmentAreaSizeKind.GE_3000_LT_6000_CM2: "140000910",
        TreatmentAreaSizeKind.GE_6000_CM2: "140001010",
    },
    TreatmentKind.BURN: {
        TreatmentAreaSizeKind.LT_100_CM2: "140032010",
        TreatmentAreaSizeKind.GE_100_LT_500_CM2: "140032110",
        TreatmentAreaSizeKind.GE_500_LT_3000_CM2: "140032210",
        TreatmentAreaSizeKind.GE_3000_LT_6000_CM2: "140036510",
        TreatmentAreaSizeKind.GE_6000_CM2: "140036610",
    },
    TreatmentKind.DERMATOLOGY_OINTMENT: {
        TreatmentAreaSizeKind.GE_100_LT_500_CM2: "140011610",
        TreatmentAreaSizeKind.GE_500_LT_3000_CM2: "140011710",
        TreatmentAreaSizeKind.GE_3000_LT_6000_CM2: "140011810",
        TreatmentAreaSizeKind.GE_6000_CM2: "140011910",
    },
}

SIMPLE_TREATMENT_FEE_CODES = {
    TreatmentKind.ANTI_INFLAMMATORY_MANUAL: "140029610",
    TreatmentKind.ANTI_INFLAMMATORY_DEVICE: "140040310",
    TreatmentKind.ANTI_INFLAMMATORY_PATCH: "140002210",
    TreatmentKind.NASAL_FEEDING: "140023210",
    TreatmentKind.INDWELLING_URINARY_CATHETER: "140013810",
    TreatmentKind.URETHRAL_DILATION_CATHETERIZATION: "140014010",
    TreatmentKind.INTERMITTENT_CATHETERIZATION: "140037110",
    TreatmentKind.VAGINAL_IRRIGATION: "140015210",
    TreatmentKind.NAIL_REMOVAL: "140032750",
}

TREATMENT_FEE_CODE_SET = frozenset(
    (
        *(code for codes_by_area in AREA_TREATMENT_FEE_CODES.values() for code in codes_by_area.values()),
        *SIMPLE_TREATMENT_FEE_CODES.values(),
    )
)


def calculate_treatment_fees(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    treatment_orders: tuple[TreatmentOrder, ...] | list[TreatmentOrder],
    service_date: date,
    *,
    source_id: int | None = None,
) -> TreatmentFeeResult:
    """Return treatment procedure fee candidates from explicit treatment orders."""

    if not treatment_orders:
        return TreatmentFeeResult(lines=(), messages=())

    current_codes = set(_unique_codes(tuple(procedure_codes)))
    selected_codes: set[str] = set()
    lines: list[CalculationLine] = []
    messages: list[CalculationMessage] = []

    for order in treatment_orders:
        code, validation_message = _select_treatment_fee_code(order)
        if validation_message is not None:
            messages.append(validation_message)
        if code is None:
            continue

        if code in current_codes:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=code,
                    message=f"Treatment fee skipped: already present in claim {code}",
                    source="treatment_fee",
                )
            )
            continue

        if code in selected_codes:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=code,
                    message=f"Treatment fee skipped: duplicate treatment order {code}",
                    source="treatment_fee",
                )
            )
            continue
        selected_codes.add(code)

        row = _find_medical_procedure(conn, code, service_date, source_id)
        if row is None:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message=f"Treatment fee code not found for service date: {code}",
                    source="treatment_fee",
                )
            )
            continue

        lines.append(
            CalculationLine(
                code=str(row["code"]),
                name=str(row["short_name"]),
                points=float(row["points"]),
                quantity=1,
                status=ClaimItemStatus.CANDIDATE,
                reason=f"Treatment fee candidate for {order.kind.value}",
                source="treatment_fee",
            )
        )

    return TreatmentFeeResult(lines=tuple(lines), messages=tuple(messages))


def _select_treatment_fee_code(order: TreatmentOrder) -> tuple[str | None, CalculationMessage | None]:
    codes_by_area = AREA_TREATMENT_FEE_CODES.get(order.kind)
    if codes_by_area is not None:
        if order.area_size is None:
            return (
                None,
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=None,
                    message=f"Treatment fee not added: area size is required for {order.kind.value}",
                    source="treatment_fee",
                ),
            )
        code = codes_by_area.get(order.area_size)
        if code is None:
            return (
                None,
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=None,
                    message=f"Treatment fee not added: area size is not supported for {order.kind.value}",
                    source="treatment_fee",
                ),
            )
        return code, None

    code = SIMPLE_TREATMENT_FEE_CODES.get(order.kind)
    if code is not None:
        return code, None

    return (
        None,
        CalculationMessage(
            status=ClaimItemStatus.NEEDS_REVIEW,
            code=None,
            message=f"Treatment fee not added: treatment kind is not supported {order.kind.value}",
            source="treatment_fee",
        ),
    )


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
