from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    ClaimItemStatus,
    InjectionOptionContext,
    InjectionRouteKind,
)


@dataclass(frozen=True)
class InjectionFeeResult:
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...]


INJECTION_ROUTE_FEE_CODES = {
    InjectionRouteKind.INTRADERMAL_SUBCUTANEOUS_INTRAMUSCULAR: "130000510",
    InjectionRouteKind.INTRAVENOUS: "130003510",
    InjectionRouteKind.CENTRAL_VENOUS: "130004410",
    InjectionRouteKind.JOINT_CAVITY: "130005310",
    InjectionRouteKind.VITREOUS: "130012010",
}

OUTPATIENT_ONLY_ROUTE_KINDS = frozenset(
    (
        InjectionRouteKind.INTRADERMAL_SUBCUTANEOUS_INTRAMUSCULAR,
        InjectionRouteKind.INTRAVENOUS,
    )
)

DRIP_INFUSION_INFANT_CODE = "130003710"
DRIP_INFUSION_STANDARD_CODE = "130003810"
DRIP_INFUSION_OUTPATIENT_OTHER_CODE = "130009310"

INJECTION_ADD_ON_CODES = {
    "biologic_add_on": "130000110",
    "narcotic_add_on": "130000310",
    "precision_continuous_infusion_add_on": "130000210",
}

INJECTION_FEE_CODE_SET = frozenset(
    (
        *INJECTION_ROUTE_FEE_CODES.values(),
        DRIP_INFUSION_INFANT_CODE,
        DRIP_INFUSION_STANDARD_CODE,
        DRIP_INFUSION_OUTPATIENT_OTHER_CODE,
        *INJECTION_ADD_ON_CODES.values(),
    )
)


def calculate_injection_fees(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    service_date: date,
    context: InjectionOptionContext,
    *,
    is_outpatient: bool,
    source_id: int | None = None,
) -> InjectionFeeResult:
    """Return injection procedure fee candidates from explicit injection context."""

    candidate_codes, candidate_messages = _candidate_injection_fee_codes(
        context,
        is_outpatient=is_outpatient,
    )
    if not candidate_codes and not candidate_messages:
        return InjectionFeeResult(lines=(), messages=())

    current_codes = set(_unique_codes(tuple(procedure_codes)))
    lines: list[CalculationLine] = []
    messages: list[CalculationMessage] = list(candidate_messages)

    for code in candidate_codes:
        if code in current_codes:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=code,
                    message=f"Injection fee skipped: already present in claim {code}",
                    source="injection_fee",
                )
            )
            continue

        row = _find_medical_procedure(conn, code, service_date, source_id)
        if row is None:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message=f"Injection fee code not found for service date: {code}",
                    source="injection_fee",
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
                reason="Injection fee candidate",
                source="injection_fee",
            )
        )

    return InjectionFeeResult(lines=tuple(lines), messages=tuple(messages))


def _candidate_injection_fee_codes(
    context: InjectionOptionContext,
    *,
    is_outpatient: bool,
) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    codes: list[str] = []
    messages: list[CalculationMessage] = []

    if context.route_kind is not None:
        if context.route_kind in OUTPATIENT_ONLY_ROUTE_KINDS and not is_outpatient:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=INJECTION_ROUTE_FEE_CODES[context.route_kind],
                    message="Injection fee skipped: inpatient route is drug-fee only",
                    source="injection_fee",
                )
            )
            route_code = None
        else:
            route_code = _route_fee_code(context, is_outpatient=is_outpatient)
        if route_code is None:
            if not messages or messages[-1].status != ClaimItemStatus.BLOCKED:
                messages.append(
                    CalculationMessage(
                        status=ClaimItemStatus.NEEDS_REVIEW,
                        code=None,
                        message="Injection route combination is not supported yet",
                        source="injection_fee",
                    )
                )
        else:
            codes.append(route_code)

    if context.biologic_add_on:
        codes.append(INJECTION_ADD_ON_CODES["biologic_add_on"])
    if context.narcotic_add_on:
        codes.append(INJECTION_ADD_ON_CODES["narcotic_add_on"])
    if context.precision_continuous_infusion_add_on:
        codes.append(INJECTION_ADD_ON_CODES["precision_continuous_infusion_add_on"])

    return _unique_codes(tuple(codes)), tuple(messages)


def _route_fee_code(context: InjectionOptionContext, *, is_outpatient: bool) -> str | None:
    if context.route_kind == InjectionRouteKind.DRIP_INFUSION:
        if context.infant:
            return DRIP_INFUSION_INFANT_CODE
        if is_outpatient and context.drip_infusion_outpatient_other:
            return DRIP_INFUSION_OUTPATIENT_OTHER_CODE
        return DRIP_INFUSION_STANDARD_CODE
    return INJECTION_ROUTE_FEE_CODES.get(context.route_kind)


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
