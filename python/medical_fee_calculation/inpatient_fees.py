from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    ClaimItemStatus,
    DpcOptionContext,
    InpatientBasicFeeOptionContext,
)
from medical_fee_calculation.hospital_profile import HospitalProfile
from medical_fee_calculation.facility_standard_dictionary import (
    has_facility_standard_rule,
    resolve_facility_standard_rule_key,
)


@dataclass(frozen=True)
class InpatientFeeResult:
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...]


@dataclass(frozen=True)
class _DpcCodeResolution:
    dpc_code: str | None
    reason: str | None
    messages: tuple[CalculationMessage, ...] = ()


_DPC_CONVERSION_CONDITION_FIELDS = (
    ("disease_state_classification", "disease_state_classification"),
    ("age_condition", "age_condition"),
    ("month_age_condition", "month_age_condition"),
    ("weight_condition", "weight_condition"),
    ("jcs_condition", "jcs_condition"),
    ("burn_index_condition", "burn_index_condition"),
    ("gaf_condition", "gaf_condition"),
    ("pregnancy_weeks_condition", "pregnancy_weeks_condition"),
    ("delivery_bleeding_amount_condition", "delivery_bleeding_amount_condition"),
    ("surgery_procedure_1_flag", "surgery_procedure_1_flag"),
    ("surgery_procedure_2_flag", "surgery_procedure_2_flag"),
    ("defined_comorbidity_flag", "defined_comorbidity_flag"),
    ("severity_age_condition", "severity_age_condition"),
    ("severity_jcs_condition", "severity_jcs_condition"),
    ("unilateral_bilateral_condition", "unilateral_bilateral_condition"),
    ("first_reoperation_condition", "first_reoperation_condition"),
    ("one_eye_both_eyes_condition", "one_eye_both_eyes_condition"),
    ("one_side_both_sides_condition", "one_side_both_sides_condition"),
    ("rehabilitation_condition", "rehabilitation_condition"),
    ("mild_severe_condition", "mild_severe_condition"),
    ("pre_onset_rankin_scale_condition", "pre_onset_rankin_scale_condition"),
    ("a_drop_score_condition", "a_drop_score_condition"),
    ("transfer_from_other_hospital_ward_condition", "transfer_from_other_hospital_ward_condition"),
    ("stroke_onset_timing_condition", "stroke_onset_timing_condition"),
    ("child_pugh_classification_condition", "child_pugh_classification_condition"),
)


def calculate_inpatient_fees(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    service_date: date,
    context: InpatientBasicFeeOptionContext,
    dpc_context: DpcOptionContext,
    *,
    is_outpatient: bool,
    admission_date: date | None = None,
    facility_standard_keys: frozenset[str] | tuple[str, ...] | list[str] = frozenset(),
    source_id: int | None = None,
    electronic_fee_source_id: int | None = None,
    dpc_electronic_table_source_id: int | None = None,
    hospital_profile: HospitalProfile | None = None,
) -> InpatientFeeResult:
    """Return inpatient basic fee candidates and DPC advisory messages.

    Inpatient fee selection is intentionally explicit: the caller must provide a
    medical procedure code for the basic fee. DPC claims are routed to review
    until a DPC-specific master and grouping engine are present.
    """

    if not _has_inpatient_input(context, dpc_context):
        return InpatientFeeResult(lines=(), messages=())

    messages: list[CalculationMessage] = []
    lines: list[CalculationLine] = []

    if is_outpatient:
        return InpatientFeeResult(
            lines=(),
            messages=(
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=context.basic_fee_code or dpc_context.dpc_code,
                    message="Inpatient fee skipped: inpatient encounter is required",
                    source="inpatient_basic_fee",
                ),
            ),
        )

    if context.basic_fee_code:
        basic_fee_line, basic_fee_messages = _calculate_inpatient_basic_fee(
            conn,
            procedure_codes,
            service_date,
            context,
            facility_standard_keys=facility_standard_keys,
            source_id=source_id,
            electronic_fee_source_id=electronic_fee_source_id,
        )
        messages.extend(basic_fee_messages)
        if basic_fee_line is not None:
            lines.append(basic_fee_line)

    if dpc_context.dpc_claim or dpc_context.dpc_code or _has_dpc_grouping_input(dpc_context):
        dpc_line, dpc_messages = _calculate_dpc_estimate(
            conn,
            service_date,
            dpc_context,
            admission_date=admission_date,
            source_id=dpc_electronic_table_source_id,
            hospital_profile=hospital_profile,
        )
        messages.extend(dpc_messages)
        if dpc_line is not None:
            lines.append(dpc_line)

    return InpatientFeeResult(lines=tuple(lines), messages=tuple(messages))


def _calculate_inpatient_basic_fee(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    service_date: date,
    context: InpatientBasicFeeOptionContext,
    *,
    facility_standard_keys: frozenset[str] | tuple[str, ...] | list[str],
    source_id: int | None,
    electronic_fee_source_id: int | None,
) -> tuple[CalculationLine | None, tuple[CalculationMessage, ...]]:
    code = str(context.basic_fee_code or "").strip()
    messages: list[CalculationMessage] = []

    if context.basic_fee_days < 1:
        return (
            None,
            (
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message="Inpatient basic fee not added: basic_fee_days must be 1 or greater",
                    source="inpatient_basic_fee",
                ),
            ),
        )

    if code in _unique_codes(tuple(procedure_codes)):
        return (
            None,
            (
                CalculationMessage(
                    status=ClaimItemStatus.BLOCKED,
                    code=code,
                    message=f"Inpatient basic fee skipped: already present in claim {code}",
                    source="inpatient_basic_fee",
                ),
            ),
        )

    standard_rule_key = resolve_facility_standard_rule_key(
        context.facility_standard_key or context.ward_kind or ""
    )
    if standard_rule_key is not None and not has_facility_standard_rule(
        facility_standard_keys,
        standard_rule_key,
    ):
        return (
            None,
            (
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message=(
                        "Inpatient basic fee not added: required facility standard "
                        f"{context.facility_standard_key or context.ward_kind} not found"
                    ),
                    source="inpatient_basic_fee",
                ),
            ),
        )

    if context.inpatient_basic_code:
        linked = _inpatient_basic_table_has_code(
            conn,
            context.inpatient_basic_code,
            code,
            service_date,
            electronic_fee_source_id,
        )
        if linked is False:
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message=(
                        "Inpatient basic fee table does not link inpatient_basic_code "
                        f"{context.inpatient_basic_code} to procedure code {code}"
                    ),
                    source="inpatient_basic_fee",
                )
            )

    row = _find_medical_procedure(conn, code, service_date, source_id)
    if row is None:
        return (
            None,
            (
                *messages,
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=code,
                    message=f"Inpatient basic fee code not found for service date: {code}",
                    source="inpatient_basic_fee",
                ),
            ),
        )

    return (
        CalculationLine(
            code=str(row["code"]),
            name=str(row["short_name"]),
            points=float(row["points"]),
            quantity=float(context.basic_fee_days),
            status=ClaimItemStatus.CANDIDATE,
            reason="Inpatient basic fee candidate",
            source="inpatient_basic_fee",
        ),
        tuple(messages),
    )


def _calculate_dpc_estimate(
    conn: sqlite3.Connection,
    service_date: date,
    context: DpcOptionContext,
    *,
    admission_date: date | None,
    source_id: int | None,
    hospital_profile: HospitalProfile | None,
) -> tuple[CalculationLine | None, tuple[CalculationMessage, ...]]:
    code_resolution = _resolve_dpc_code_candidate(
        conn,
        service_date,
        context,
        source_id=source_id,
    )
    dpc_code = context.dpc_code or code_resolution.dpc_code
    hospital_coefficient = _effective_hospital_coefficient(context, hospital_profile)
    messages: list[CalculationMessage] = list(code_resolution.messages)

    missing = []
    if not dpc_code:
        missing.append("dpc_code")
    if hospital_coefficient is None:
        missing.append("hospital_coefficient")
    if admission_date is None:
        missing.append("admission_date")
    if missing:
        return (
            None,
            (
                *messages,
                _dpc_review_message(
                    context,
                    "DPC estimate not added",
                    f"Missing inputs: {', '.join(missing)}.",
                    code=dpc_code,
                ),
            ),
        )

    if hospital_coefficient is None or hospital_coefficient <= 0:
        return (
            None,
            (
                *messages,
                _dpc_review_message(
                    context,
                    "DPC estimate not added",
                    "hospital_coefficient must be greater than 0.",
                    code=dpc_code,
                ),
            ),
        )

    inpatient_day = (service_date - admission_date).days + 1
    if inpatient_day < 1:
        return (
            None,
            (
                *messages,
                _dpc_review_message(
                    context,
                    "DPC estimate not added",
                    "service_date is before admission_date.",
                    code=dpc_code,
                ),
            ),
        )

    row = _find_dpc_point_row(conn, str(dpc_code), service_date, source_id)
    if row is None:
        return (
            None,
            (
                *messages,
                _dpc_review_message(
                    context,
                    "DPC estimate not added",
                    "DPC point table row was not found for service_date.",
                    code=dpc_code,
                ),
            ),
        )

    period = _select_dpc_period(row, inpatient_day)
    if period is None:
        return (
            None,
            (
                *messages,
                _dpc_review_message(
                    context,
                    "DPC estimate not added",
                    "inpatient day is outside supported DPC period I/II/III.",
                    code=dpc_code,
                ),
            ),
        )

    period_label, base_points = period
    estimated_points = _round_positive_points(base_points * hospital_coefficient)
    resolution_reason = (
        f"; {code_resolution.reason}" if code_resolution.reason and not context.dpc_code else ""
    )
    coefficient_reason = _hospital_coefficient_reason(context, hospital_profile)
    line = CalculationLine(
        code=str(row["dpc_code"]),
        name=_dpc_line_name(row),
        points=float(base_points),
        quantity=1.0,
        status=ClaimItemStatus.CANDIDATE,
        reason=(
            f"DPC estimate period {period_label} for inpatient day {inpatient_day}; "
            f"hospital coefficient {hospital_coefficient:g}{coefficient_reason}{resolution_reason}"
        ),
        source="dpc_estimate",
        calculated_total_points=float(estimated_points),
    )
    return (
        line,
        (
            *messages,
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=dpc_code,
                message=(
                    "DPC estimate added for review: verify grouping, hospital coefficient, "
                    "and bundled/fee-for-service split before final receipt."
                ),
                source="dpc_claim",
            ),
        ),
    )


def _dpc_review_message(
    context: DpcOptionContext,
    prefix: str = "DPC claim not calculated",
    suffix: str = "",
    *,
    code: str | None = None,
) -> CalculationMessage:
    detail = (
        "DPC finalization, hospital coefficient validation, and bundled/fee-for-service "
        "split require the DPC engine."
    )
    tail = f" {suffix}" if suffix else ""
    return CalculationMessage(
        status=ClaimItemStatus.NEEDS_REVIEW,
        code=code or context.dpc_code,
        message=f"{prefix}: {detail}{tail}",
        source="dpc_claim",
    )


def _resolve_dpc_code_candidate(
    conn: sqlite3.Connection,
    service_date: date,
    context: DpcOptionContext,
    *,
    source_id: int | None,
) -> _DpcCodeResolution:
    if context.dpc_code:
        return _DpcCodeResolution(dpc_code=str(context.dpc_code), reason=None)
    if not _has_dpc_grouping_input(context):
        return _DpcCodeResolution(dpc_code=None, reason=None)

    classification = _resolve_dpc_classification(conn, service_date, context, source_id=source_id)
    if classification.dpc_code is None:
        return classification
    mdc_code, classification_code = classification.dpc_code.split(":", maxsplit=1)

    surgery_flag_resolution = _resolve_dpc_surgery_flag(
        conn,
        service_date,
        context,
        mdc_code=mdc_code,
        classification_code=classification_code,
        source_id=source_id,
    )
    if surgery_flag_resolution.dpc_code is None:
        return surgery_flag_resolution

    candidate = _find_dpc_conversion_candidate(
        conn,
        service_date,
        context,
        mdc_code=mdc_code,
        classification_code=classification_code,
        surgery_flag=surgery_flag_resolution.dpc_code,
        source_id=source_id,
    )
    if candidate.dpc_code is None:
        return candidate
    return _DpcCodeResolution(
        dpc_code=candidate.dpc_code,
        reason=(
            "DPC code resolved from ICD/MDC classification, surgery flag, "
            "and structured DPC conditions"
        ),
        messages=candidate.messages,
    )


def _resolve_dpc_classification(
    conn: sqlite3.Connection,
    service_date: date,
    context: DpcOptionContext,
    *,
    source_id: int | None,
) -> _DpcCodeResolution:
    mdc_code = _optional_text(context.mdc_code)
    classification_code = _optional_text(context.classification_code)
    if mdc_code and classification_code:
        return _DpcCodeResolution(dpc_code=f"{mdc_code}:{classification_code}", reason=None)

    icd_code = _normalize_icd_code(context.icd_code)
    if not icd_code:
        return _DpcCodeResolution(
            dpc_code=None,
            reason=None,
            messages=(
                _dpc_review_message(
                    context,
                    "DPC code candidate not determined",
                    "Missing mdc_code/classification_code or icd_code.",
                ),
            ),
        )

    rows = _find_dpc_icd_rows(conn, icd_code, service_date, source_id)
    classifications = sorted(
        {
            (str(row["mdc_code"]), str(row["classification_code"]))
            for row in rows
            if _icd_pattern_matches(str(row["icd_code"]), icd_code)
        }
    )
    if len(classifications) == 1:
        mdc, classification = classifications[0]
        return _DpcCodeResolution(dpc_code=f"{mdc}:{classification}", reason=None)
    if not classifications:
        suffix = f"ICD code was not found in DPC ICD table: {icd_code}."
    else:
        suffix = (
            f"ICD code maps to {len(classifications)} DPC classifications; "
            "provide mdc_code and classification_code."
        )
    return _DpcCodeResolution(
        dpc_code=None,
        reason=None,
        messages=(
            _dpc_review_message(
                context,
                "DPC code candidate not determined",
                suffix,
            ),
        ),
    )


def _resolve_dpc_surgery_flag(
    conn: sqlite3.Connection,
    service_date: date,
    context: DpcOptionContext,
    *,
    mdc_code: str,
    classification_code: str,
    source_id: int | None,
) -> _DpcCodeResolution:
    surgery_flag = _optional_text(context.surgery_flag)
    if surgery_flag:
        return _DpcCodeResolution(dpc_code=surgery_flag, reason=None)

    surgery_code = _optional_text(context.surgery_code)
    if surgery_code and _is_no_surgery_marker(surgery_code):
        return _DpcCodeResolution(dpc_code="99", reason=None)
    if not surgery_code:
        return _DpcCodeResolution(
            dpc_code=None,
            reason=None,
            messages=(
                _dpc_review_message(
                    context,
                    "DPC code candidate not determined",
                    "Missing surgery_flag or surgery_code.",
                ),
            ),
        )

    flags = _find_dpc_surgery_flags(
        conn,
        surgery_code,
        service_date,
        mdc_code=mdc_code,
        classification_code=classification_code,
        source_id=source_id,
    )
    if len(flags) == 1:
        return _DpcCodeResolution(dpc_code=flags[0], reason=None)
    if not flags:
        suffix = f"surgery_code was not found in DPC surgery table: {surgery_code}."
    else:
        suffix = (
            f"surgery_code maps to multiple surgery flags ({', '.join(flags[:5])}); "
            "provide surgery_flag."
        )
    return _DpcCodeResolution(
        dpc_code=None,
        reason=None,
        messages=(
            _dpc_review_message(
                context,
                "DPC code candidate not determined",
                suffix,
            ),
        ),
    )


def _find_dpc_conversion_candidate(
    conn: sqlite3.Connection,
    service_date: date,
    context: DpcOptionContext,
    *,
    mdc_code: str,
    classification_code: str,
    surgery_flag: str,
    source_id: int | None,
) -> _DpcCodeResolution:
    rows = _find_dpc_conversion_rows(
        conn,
        service_date,
        mdc_code=mdc_code,
        classification_code=classification_code,
        source_id=source_id,
    )
    condition_values = {
        column: _optional_text(getattr(context, attr))
        for attr, column in _DPC_CONVERSION_CONDITION_FIELDS
    }
    condition_values["surgery_flag"] = surgery_flag

    candidates = sorted(
        {
            str(row["dpc_code"])
            for row in rows
            if all(
                _condition_matches(row[column], value)
                for column, value in condition_values.items()
            )
        }
    )
    if len(candidates) == 1:
        return _DpcCodeResolution(dpc_code=candidates[0], reason=None)
    if not candidates:
        suffix = "No DPC conversion row matched the supplied structured conditions."
    else:
        sample = ", ".join(candidates[:5])
        suffix = (
            f"Structured conditions still match {len(candidates)} DPC codes "
            f"({sample}); provide additional DPC condition flags."
        )
    return _DpcCodeResolution(
        dpc_code=None,
        reason=None,
        messages=(
            _dpc_review_message(
                context,
                "DPC code candidate not determined",
                suffix,
            ),
        ),
    )


def _find_dpc_point_row(
    conn: sqlite3.Connection,
    dpc_code: str,
    service_date: date,
    source_id: int | None,
) -> sqlite3.Row | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, dpc_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    return conn.execute(
        f"""
        SELECT
            source_id,
            dpc_code,
            diagnosis_name,
            surgery_name,
            period_1_days,
            period_2_days,
            period_3_days,
            period_1_points,
            period_2_points,
            period_3_points
        FROM dpc_point_table
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          AND dpc_code = ?
          {source_filter}
        ORDER BY source_id DESC, row_index DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _find_dpc_icd_rows(
    conn: sqlite3.Connection,
    icd_code: str,
    service_date: date,
    source_id: int | None,
) -> tuple[sqlite3.Row, ...]:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    rows = conn.execute(
        f"""
        SELECT source_id, mdc_code, classification_code, icd_code
        FROM dpc_icd_table
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          {source_filter}
        ORDER BY source_id DESC, row_index ASC
        """,
        params,
    ).fetchall()
    return tuple(
        row for row in rows if _icd_pattern_matches(str(row["icd_code"]), icd_code)
    )


def _find_dpc_surgery_flags(
    conn: sqlite3.Connection,
    surgery_code: str,
    service_date: date,
    *,
    mdc_code: str,
    classification_code: str,
    source_id: int | None,
) -> tuple[str, ...]:
    service_date_text = service_date.isoformat()
    normalized_code = _normalize_surgery_code(surgery_code)
    params: list[object] = [
        service_date_text,
        service_date_text,
        mdc_code,
        classification_code,
        normalized_code,
        normalized_code,
        normalized_code,
        normalized_code,
        normalized_code,
    ]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    rows = conn.execute(
        f"""
        SELECT DISTINCT
            CASE
                WHEN corresponding_code IS NOT NULL AND TRIM(corresponding_code) <> ''
                THEN corresponding_code
                ELSE surgery_flag
            END AS conversion_surgery_flag
        FROM dpc_surgery_table
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          AND mdc_code = ?
          AND classification_code = ?
          AND (
              surgery_1_code = ?
              OR surgery_2_code = ?
              OR surgery_3_code = ?
              OR surgery_4_code = ?
              OR surgery_5_code = ?
          )
          {source_filter}
        ORDER BY conversion_surgery_flag
        """,
        params,
    ).fetchall()
    return tuple(
        str(row["conversion_surgery_flag"])
        for row in rows
        if row["conversion_surgery_flag"] is not None
    )


def _find_dpc_conversion_rows(
    conn: sqlite3.Connection,
    service_date: date,
    *,
    mdc_code: str,
    classification_code: str,
    source_id: int | None,
) -> tuple[sqlite3.Row, ...]:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, mdc_code, classification_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    rows = conn.execute(
        f"""
        SELECT *
        FROM dpc_conversion_table
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          AND mdc_code = ?
          AND classification_code = ?
          {source_filter}
        ORDER BY source_id DESC, row_index ASC
        """,
        params,
    ).fetchall()
    return tuple(rows)


def _select_dpc_period(row: sqlite3.Row, inpatient_day: int) -> tuple[str, int] | None:
    period_fields = (
        ("I", row["period_1_days"], row["period_1_points"]),
        ("II", row["period_2_days"], row["period_2_points"]),
        ("III", row["period_3_days"], row["period_3_points"]),
    )
    for label, days, points in period_fields:
        if days is None or points is None:
            continue
        if inpatient_day <= int(days):
            return label, int(points)
    return None


def _dpc_line_name(row: sqlite3.Row) -> str:
    diagnosis = str(row["diagnosis_name"] or "").strip()
    surgery = str(row["surgery_name"] or "").strip()
    if diagnosis and surgery:
        return f"{diagnosis} / {surgery}"
    return diagnosis or surgery or str(row["dpc_code"])


def _round_positive_points(value: float) -> int:
    return int(value + 0.5)


def _effective_hospital_coefficient(
    context: DpcOptionContext,
    hospital_profile: HospitalProfile | None,
) -> float | None:
    if context.hospital_coefficient is not None:
        return context.hospital_coefficient
    if hospital_profile is None or hospital_profile.dpc_hospital_coefficient is None:
        return None
    return hospital_profile.dpc_hospital_coefficient.total_coefficient


def _hospital_coefficient_reason(
    context: DpcOptionContext,
    hospital_profile: HospitalProfile | None,
) -> str:
    if context.hospital_coefficient is not None:
        return ""
    if hospital_profile is None or hospital_profile.dpc_hospital_coefficient is None:
        return ""
    return " from hospital_profile"


def _optional_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _condition_matches(raw_table_value: object, raw_context_value: str | None) -> bool:
    if raw_context_value is None:
        return True
    return _normalize_condition(raw_table_value) == _normalize_condition(raw_context_value)


def _normalize_condition(value: object | None) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_icd_code(value: object | None) -> str | None:
    text = _optional_text(value)
    if text is None:
        return None
    return text.replace(".", "").replace(" ", "").replace("　", "").upper()


def _icd_pattern_matches(pattern: str, icd_code: str) -> bool:
    normalized_pattern = _normalize_icd_code(pattern)
    if normalized_pattern is None:
        return False
    if normalized_pattern.endswith("$"):
        return icd_code.startswith(normalized_pattern[:-1])
    return normalized_pattern == icd_code


def _normalize_surgery_code(value: object | None) -> str:
    return str(value or "").strip().replace(" ", "").replace("　", "").upper()


def _is_no_surgery_marker(value: object | None) -> bool:
    normalized = _normalize_surgery_code(value)
    return normalized in {"KKK0", "NONE", "NO", "NA", "N/A", "ナシ", "なし", "手術なし"}


def _has_inpatient_input(
    context: InpatientBasicFeeOptionContext,
    dpc_context: DpcOptionContext,
) -> bool:
    return bool(
        context.basic_fee_code
        or context.facility_standard_key
        or context.ward_kind
        or context.inpatient_basic_code
        or dpc_context.dpc_claim
        or dpc_context.dpc_code
        or _has_dpc_grouping_input(dpc_context)
    )


def _has_dpc_grouping_input(dpc_context: DpcOptionContext) -> bool:
    return bool(
        dpc_context.icd_code
        or dpc_context.mdc_code
        or dpc_context.classification_code
        or dpc_context.surgery_code
        or dpc_context.surgery_flag
        or dpc_context.surgery_procedure_1_flag
        or dpc_context.surgery_procedure_2_flag
        or dpc_context.defined_comorbidity_flag
    )


def _inpatient_basic_table_has_code(
    conn: sqlite3.Connection,
    inpatient_basic_code: str,
    procedure_code: str,
    service_date: date,
    source_id: int | None,
) -> bool | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, inpatient_basic_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    rows = conn.execute(
        f"""
        SELECT procedure_code
        FROM electronic_inpatient_basic
        WHERE (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
          AND inpatient_basic_code = ?
          {source_filter}
        """,
        params,
    ).fetchall()
    if not rows:
        return None
    return procedure_code in {str(row["procedure_code"]) for row in rows}


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
