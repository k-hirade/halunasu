from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    ChargeInput,
    ClaimItemStatus,
)


@dataclass(frozen=True)
class ProcedureResolveResult:
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...]


def resolve_medical_procedure_lines(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    service_date: date,
    source_id: int | None = None,
) -> ProcedureResolveResult:
    """Resolve input medical procedure codes to point lines."""

    lines: list[CalculationLine] = []
    messages: list[CalculationMessage] = []

    for code in _unique_codes(tuple(procedure_codes)):
        row = _find_medical_procedure(conn, code, service_date, source_id)
        if row is None:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message=f"Medical procedure code not found for service date: {code}",
                    source="medical_procedure_master",
                )
            )
            continue

        lines.append(
            CalculationLine(
                code=str(row["code"]),
                name=str(row["short_name"]),
                points=float(row["points"]),
                quantity=1,
                status=ClaimItemStatus.CONFIRMED,
                reason="Input medical procedure code",
                source="medical_procedure_master",
            )
        )

    return ProcedureResolveResult(lines=tuple(lines), messages=tuple(messages))


def resolve_drug_lines(
    conn: sqlite3.Connection,
    drug_inputs: tuple[ChargeInput, ...] | list[ChargeInput],
    service_date: date,
    source_id: int | None = None,
) -> ProcedureResolveResult:
    lines: list[CalculationLine] = []
    messages: list[CalculationMessage] = []

    for charge_input in _aggregate_charge_inputs(tuple(drug_inputs)):
        row = _find_drug(conn, charge_input.code, service_date, source_id)
        if row is None:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=charge_input.code,
                    message=f"Drug code not found for service date: {charge_input.code}",
                    source="drug_master",
                )
            )
            continue

        lines.append(_drug_line_from_row(row, charge_input.quantity))

    return ProcedureResolveResult(lines=tuple(lines), messages=tuple(messages))


def _drug_line_from_row(row: sqlite3.Row, quantity: float) -> CalculationLine:
    unit_amount_yen = float(row["unit_amount_yen"])
    total_amount_yen = unit_amount_yen * quantity
    return CalculationLine(
        code=str(row["code"]),
        name=str(row["name"]),
        points=_yen_to_points(unit_amount_yen),
        quantity=quantity,
        status=ClaimItemStatus.CONFIRMED,
        reason=(
            "Input drug code; medical drug fee rounded from total drug price "
            f"{total_amount_yen:.2f} yen"
        ),
        source="drug_master",
        calculated_total_points=_medical_drug_points_from_yen(total_amount_yen),
    )


def resolve_specific_material_lines(
    conn: sqlite3.Connection,
    material_inputs: tuple[ChargeInput, ...] | list[ChargeInput],
    service_date: date,
    source_id: int | None = None,
) -> ProcedureResolveResult:
    lines: list[CalculationLine] = []
    messages: list[CalculationMessage] = []

    for charge_input in _aggregate_charge_inputs(tuple(material_inputs)):
        row = _find_specific_material(conn, charge_input.code, service_date, source_id)
        if row is None:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=charge_input.code,
                    message=f"Specific material code not found for service date: {charge_input.code}",
                    source="specific_material_master",
                )
            )
            continue

        lines.append(_specific_material_line_from_row(row, charge_input.quantity))

    return ProcedureResolveResult(lines=tuple(lines), messages=tuple(messages))


def _specific_material_line_from_row(row: sqlite3.Row, quantity: float) -> CalculationLine:
    unit_amount_yen = float(row["unit_amount_yen"])
    total_amount_yen = unit_amount_yen * quantity
    return CalculationLine(
        code=str(row["code"]),
        name=str(row["name"]),
        points=_yen_to_points(unit_amount_yen),
        quantity=quantity,
        status=ClaimItemStatus.CONFIRMED,
        reason=(
            "Input specific material code; material fee rounded from total material price "
            f"{total_amount_yen:.2f} yen"
        ),
        source="specific_material_master",
        calculated_total_points=_material_points_from_yen(total_amount_yen),
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


def _find_drug(
    conn: sqlite3.Connection,
    drug_code: str,
    service_date: date,
    source_id: int | None,
) -> sqlite3.Row | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, drug_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    return conn.execute(
        f"""
        SELECT code, name, unit_amount_yen
        FROM drugs
        WHERE (changed_at IS NULL OR changed_at <= ?)
          AND (discontinued_at IS NULL OR discontinued_at >= ?)
          AND code = ?
          {source_filter}
        ORDER BY source_id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _find_specific_material(
    conn: sqlite3.Connection,
    material_code: str,
    service_date: date,
    source_id: int | None,
) -> sqlite3.Row | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, material_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    return conn.execute(
        f"""
        SELECT code, name, unit_amount_yen
        FROM specific_materials
        WHERE (changed_at IS NULL OR changed_at <= ?)
          AND (discontinued_at IS NULL OR discontinued_at >= ?)
          AND code = ?
          {source_filter}
        ORDER BY source_id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _aggregate_charge_inputs(inputs: tuple[ChargeInput, ...]) -> tuple[ChargeInput, ...]:
    quantities_by_code: dict[str, float] = {}
    order: list[str] = []
    for charge_input in inputs:
        code = str(charge_input.code or "").strip()
        if not code:
            continue
        if code not in quantities_by_code:
            order.append(code)
            quantities_by_code[code] = 0
        quantities_by_code[code] += float(charge_input.quantity)
    return tuple(ChargeInput(code=code, quantity=quantities_by_code[code]) for code in order)


def _yen_to_points(amount_yen: float) -> float:
    return amount_yen / 10


def _medical_drug_points_from_yen(amount_yen: float) -> float:
    amount = Decimal(str(amount_yen))
    if amount <= Decimal("15"):
        return 0.0
    points = ((amount - Decimal("15")) / Decimal("10")).to_integral_value(rounding=ROUND_CEILING)
    return float(points + Decimal("1"))


def _material_points_from_yen(amount_yen: float) -> float:
    points = (Decimal(str(amount_yen)) / Decimal("10")).to_integral_value(rounding=ROUND_HALF_UP)
    return float(points)


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
