from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from medical_fee_calculation.claim_models import (
    CTEquipmentKind,
    CalculationLine,
    CalculationMessage,
    ClaimItemStatus,
    ImagingAcquisitionKind,
    ImagingKind,
    ImagingOrder,
    MRIEquipmentKind,
    RadiographyDiagnosticKind,
)
from medical_fee_calculation.facility_standard_dictionary import (
    FACILITY_STANDARD_RULE_BY_KEY,
    has_facility_standard_rule,
    select_facility_standard_rule_key,
)


@dataclass(frozen=True)
class ImagingFeeResult:
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...]


SIMPLE_RADIOGRAPHY_DIAGNOSIS_CODES = {
    RadiographyDiagnosticKind.SIMPLE_I: "170000410",
    RadiographyDiagnosticKind.SIMPLE_RO: "170000510",
}

SIMPLE_RADIOGRAPHY_ACQUISITION_CODES = {
    ImagingAcquisitionKind.ANALOG: "170001910",
    ImagingAcquisitionKind.DIGITAL: "170027910",
}

CONTRAST_RADIOGRAPHY_ACQUISITION_CODES = {
    ImagingAcquisitionKind.ANALOG: "170002110",
    ImagingAcquisitionKind.DIGITAL: "170028110",
}

MAMMOGRAPHY_ACQUISITION_CODES = {
    ImagingAcquisitionKind.ANALOG: "170027010",
    ImagingAcquisitionKind.DIGITAL: "170028210",
}

SIMPLE_RADIOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE = "170000210"
CONTRAST_RADIOGRAPHY_DIAGNOSIS_CODE = "170000810"
CONTRAST_RADIOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE = "170017010"
MAMMOGRAPHY_DIAGNOSIS_CODE = "170026910"
MAMMOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE = "170026710"

CT_CONTRAST_ADD_ON_CODE = "170012070"
MRI_CONTRAST_ADD_ON_CODE = "170020470"
CT_MRI_ELECTRONIC_IMAGE_MANAGEMENT_CODE = "170028810"

IMAGE_DIAGNOSTIC_MANAGEMENT_RULE_PRIORITY = (
    "image_diagnostic_management_4",
    "image_diagnostic_management_3",
    "image_diagnostic_management_2",
    "image_diagnostic_management_1",
)

IMAGE_DIAGNOSTIC_MANAGEMENT_CODES = {
    "image_diagnostic_management_1": {
        "radiography": "170025210",
        "ct_mri": "170025510",
    },
    "image_diagnostic_management_2": {
        "ct_mri": "170025710",
    },
    "image_diagnostic_management_3": {
        "ct_mri": "170702410",
    },
    "image_diagnostic_management_4": {
        "ct_mri": "170035810",
    },
}

REMOTE_IMAGE_DIAGNOSTIC_MANAGEMENT_CODES = {
    "image_diagnostic_management_1": {
        "radiography": "170025810",
        "ct_mri": "170026110",
    },
    "image_diagnostic_management_2": {
        "ct_mri": "170026310",
    },
    "image_diagnostic_management_3": {
        "ct_mri": "170702810",
    },
    "image_diagnostic_management_4": {
        "ct_mri": "170036010",
    },
}

CT_EQUIPMENT_CODES = {
    CTEquipmentKind.OTHER: {
        (False, False): "170011710",
        (True, False): "170039110",
    },
    CTEquipmentKind.MULTISLICE_4_TO_16: {
        (False, False): "170028610",
        (True, False): "170039010",
    },
    CTEquipmentKind.MULTISLICE_16_TO_64: {
        (False, False): "170011810",
        (True, False): "170038910",
    },
    CTEquipmentKind.MULTISLICE_64_TO_128: {
        (False, False): "170033410",
        (True, False): "170038810",
        (False, True): "170034910",
        (True, True): "170038710",
    },
    CTEquipmentKind.MULTISLICE_128_OR_MORE: {
        (False, False): "170901710",
        (True, False): "170901810",
        (False, True): "170901310",
        (True, True): "170901410",
    },
}

MRI_EQUIPMENT_CODES = {
    MRIEquipmentKind.OTHER: {
        False: "170015210",
    },
    MRIEquipmentKind.TESLA_1_5_TO_3: {
        False: "170020110",
    },
    MRIEquipmentKind.TESLA_3_OR_MORE: {
        False: "170033510",
        True: "170035010",
    },
}

IMAGING_FEE_CODE_SET = frozenset(
    (
        *SIMPLE_RADIOGRAPHY_DIAGNOSIS_CODES.values(),
        *SIMPLE_RADIOGRAPHY_ACQUISITION_CODES.values(),
        SIMPLE_RADIOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE,
        CONTRAST_RADIOGRAPHY_DIAGNOSIS_CODE,
        *CONTRAST_RADIOGRAPHY_ACQUISITION_CODES.values(),
        CONTRAST_RADIOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE,
        MAMMOGRAPHY_DIAGNOSIS_CODE,
        *MAMMOGRAPHY_ACQUISITION_CODES.values(),
        MAMMOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE,
        *(code for codes_by_key in CT_EQUIPMENT_CODES.values() for code in codes_by_key.values()),
        CT_CONTRAST_ADD_ON_CODE,
        *(code for codes_by_key in MRI_EQUIPMENT_CODES.values() for code in codes_by_key.values()),
        MRI_CONTRAST_ADD_ON_CODE,
        CT_MRI_ELECTRONIC_IMAGE_MANAGEMENT_CODE,
        *(
            code
            for codes_by_category in IMAGE_DIAGNOSTIC_MANAGEMENT_CODES.values()
            for code in codes_by_category.values()
        ),
        *(
            code
            for codes_by_category in REMOTE_IMAGE_DIAGNOSTIC_MANAGEMENT_CODES.values()
            for code in codes_by_category.values()
        ),
    )
)


def calculate_imaging_fees(
    conn: sqlite3.Connection,
    procedure_codes: tuple[str, ...] | list[str],
    imaging_orders: tuple[ImagingOrder, ...] | list[ImagingOrder],
    service_date: date,
    *,
    source_id: int | None = None,
    facility_standard_keys: frozenset[str] | tuple[str, ...] | list[str] = frozenset(),
) -> ImagingFeeResult:
    """Return imaging fee candidates from explicit imaging orders."""

    if not imaging_orders:
        return ImagingFeeResult(lines=(), messages=())

    current_codes = set(_unique_codes(tuple(procedure_codes)))
    selected_codes: set[str] = set()
    lines: list[CalculationLine] = []
    messages: list[CalculationMessage] = []

    for order in imaging_orders:
        candidate_codes, validation_messages = _candidate_imaging_fee_codes(order)
        messages.extend(validation_messages)
        if candidate_codes:
            add_on_codes, add_on_messages = _candidate_imaging_management_add_on_codes(
                order,
                facility_standard_keys,
            )
            candidate_codes = _unique_codes((*candidate_codes, *add_on_codes))
            messages.extend(add_on_messages)

        for code in candidate_codes:
            if code in current_codes:
                messages.append(
                    CalculationMessage(
                        status=ClaimItemStatus.BLOCKED,
                        code=code,
                        message=f"Imaging fee skipped: already present in claim {code}",
                        source="imaging_fee",
                    )
                )
                continue

            if code in selected_codes:
                messages.append(
                    CalculationMessage(
                        status=ClaimItemStatus.BLOCKED,
                        code=code,
                        message=f"Imaging fee skipped: duplicate imaging order {code}",
                        source="imaging_fee",
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
                        message=f"Imaging fee code not found for service date: {code}",
                        source="imaging_fee",
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
                    reason=f"Imaging fee candidate for {order.kind.value}",
                    source="imaging_fee",
                )
            )

    return ImagingFeeResult(lines=tuple(lines), messages=tuple(messages))


def _candidate_imaging_management_add_on_codes(
    order: ImagingOrder,
    facility_standard_keys: frozenset[str] | tuple[str, ...] | list[str],
) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    codes: list[str] = []
    messages: list[CalculationMessage] = []
    category = _image_management_category(order)

    if order.diagnostic_management_add_on:
        code, message = _management_add_on_code(
            order,
            facility_standard_keys,
            category,
            code_by_rule=IMAGE_DIAGNOSTIC_MANAGEMENT_CODES,
            remote=False,
        )
        if code is not None:
            codes.append(code)
        if message is not None:
            messages.append(message)

    if order.remote_diagnostic_management_add_on:
        code, message = _management_add_on_code(
            order,
            facility_standard_keys,
            category,
            code_by_rule=REMOTE_IMAGE_DIAGNOSTIC_MANAGEMENT_CODES,
            remote=True,
        )
        if code is not None:
            codes.append(code)
        if message is not None:
            messages.append(message)

    return _unique_codes(tuple(codes)), tuple(messages)


def _management_add_on_code(
    order: ImagingOrder,
    facility_standard_keys: frozenset[str] | tuple[str, ...] | list[str],
    category: str | None,
    *,
    code_by_rule: dict[str, dict[str, str]],
    remote: bool,
) -> tuple[str | None, CalculationMessage | None]:
    source_name = "remote image diagnostic management add-on" if remote else "image diagnostic management add-on"
    if category is None:
        return (
            None,
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=None,
                message=f"Imaging fee not added: {source_name} is not supported for {order.kind.value}",
                source="imaging_fee",
            ),
        )

    if remote and not has_facility_standard_rule(facility_standard_keys, "remote_image_diagnostic"):
        return (
            None,
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=None,
                message="Remote image diagnostic management add-on not added: facility standard 遠画 not found",
                source="imaging_fee",
            ),
        )

    rule_key = select_facility_standard_rule_key(
        facility_standard_keys,
        IMAGE_DIAGNOSTIC_MANAGEMENT_RULE_PRIORITY,
    )
    if rule_key is None:
        return (
            None,
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=None,
                message="Image diagnostic management add-on not added: facility standard 画1-画4 not found",
                source="imaging_fee",
            ),
        )

    code = code_by_rule.get(rule_key, {}).get(category)
    if code is None:
        standard_name = FACILITY_STANDARD_RULE_BY_KEY[rule_key].display_name
        return (
            None,
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=None,
                message=(
                    f"Imaging fee not added: {source_name} code is not supported for "
                    f"{order.kind.value} and {standard_name}"
                ),
                source="imaging_fee",
            ),
        )
    return code, None


def _image_management_category(order: ImagingOrder) -> str | None:
    if order.kind in {
        ImagingKind.SIMPLE_RADIOGRAPHY,
        ImagingKind.CONTRAST_RADIOGRAPHY,
        ImagingKind.MAMMOGRAPHY,
    }:
        return "radiography"
    if order.kind in {ImagingKind.CT, ImagingKind.MRI}:
        return "ct_mri"
    return None


def _candidate_imaging_fee_codes(order: ImagingOrder) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    if order.kind == ImagingKind.SIMPLE_RADIOGRAPHY:
        return _simple_radiography_codes(order)
    if order.kind == ImagingKind.CONTRAST_RADIOGRAPHY:
        return _contrast_radiography_codes(order)
    if order.kind == ImagingKind.MAMMOGRAPHY:
        return _mammography_codes(order)
    if order.kind == ImagingKind.CT:
        return _ct_codes(order)
    if order.kind == ImagingKind.MRI:
        return _mri_codes(order)
    return (
        (),
        (
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=None,
                message=f"Imaging fee not added: imaging kind is not supported {order.kind.value}",
                source="imaging_fee",
            ),
        ),
    )


def _simple_radiography_codes(order: ImagingOrder) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    messages: list[CalculationMessage] = []
    codes: list[str] = []

    if order.radiography_diagnostic_kind is None:
        messages.append(_missing_field_message(order, "radiography diagnostic kind"))
    else:
        codes.append(SIMPLE_RADIOGRAPHY_DIAGNOSIS_CODES[order.radiography_diagnostic_kind])

    if order.acquisition_kind is None:
        messages.append(_missing_field_message(order, "acquisition kind"))
    else:
        codes.append(SIMPLE_RADIOGRAPHY_ACQUISITION_CODES[order.acquisition_kind])

    if messages:
        return (), tuple(messages)

    if order.electronic_image_management:
        codes.append(SIMPLE_RADIOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE)

    return _unique_codes(tuple(codes)), tuple(messages)


def _contrast_radiography_codes(order: ImagingOrder) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    messages: list[CalculationMessage] = []
    codes = [CONTRAST_RADIOGRAPHY_DIAGNOSIS_CODE]

    if order.acquisition_kind is None:
        messages.append(_missing_field_message(order, "acquisition kind"))
    else:
        codes.append(CONTRAST_RADIOGRAPHY_ACQUISITION_CODES[order.acquisition_kind])

    if messages:
        return (), tuple(messages)

    if order.electronic_image_management:
        codes.append(CONTRAST_RADIOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE)

    return _unique_codes(tuple(codes)), tuple(messages)


def _mammography_codes(order: ImagingOrder) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    messages: list[CalculationMessage] = []
    codes = [MAMMOGRAPHY_DIAGNOSIS_CODE]

    if order.acquisition_kind is None:
        messages.append(_missing_field_message(order, "acquisition kind"))
    else:
        codes.append(MAMMOGRAPHY_ACQUISITION_CODES[order.acquisition_kind])

    if messages:
        return (), tuple(messages)

    if order.electronic_image_management:
        codes.append(MAMMOGRAPHY_ELECTRONIC_IMAGE_MANAGEMENT_CODE)

    return _unique_codes(tuple(codes)), tuple(messages)


def _ct_codes(order: ImagingOrder) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    messages: list[CalculationMessage] = []
    codes: list[str] = []

    if order.ct_equipment_kind is None:
        messages.append(_missing_field_message(order, "CT equipment kind"))
    else:
        code = CT_EQUIPMENT_CODES[order.ct_equipment_kind].get((order.head, order.joint_use))
        if code is None:
            messages.append(_unsupported_combination_message(order))
        else:
            codes.append(code)

    if messages:
        return (), tuple(messages)

    if order.contrast:
        codes.append(CT_CONTRAST_ADD_ON_CODE)
    if order.electronic_image_management:
        codes.append(CT_MRI_ELECTRONIC_IMAGE_MANAGEMENT_CODE)

    return _unique_codes(tuple(codes)), tuple(messages)


def _mri_codes(order: ImagingOrder) -> tuple[tuple[str, ...], tuple[CalculationMessage, ...]]:
    messages: list[CalculationMessage] = []
    codes: list[str] = []

    if order.mri_equipment_kind is None:
        messages.append(_missing_field_message(order, "MRI equipment kind"))
    else:
        code = MRI_EQUIPMENT_CODES[order.mri_equipment_kind].get(order.joint_use)
        if code is None:
            messages.append(_unsupported_combination_message(order))
        else:
            codes.append(code)

    if messages:
        return (), tuple(messages)

    if order.contrast:
        codes.append(MRI_CONTRAST_ADD_ON_CODE)
    if order.electronic_image_management:
        codes.append(CT_MRI_ELECTRONIC_IMAGE_MANAGEMENT_CODE)

    return _unique_codes(tuple(codes)), tuple(messages)


def _missing_field_message(order: ImagingOrder, field_name: str) -> CalculationMessage:
    return CalculationMessage(
        status=ClaimItemStatus.NEEDS_REVIEW,
        code=None,
        message=f"Imaging fee not added: {field_name} is required for {order.kind.value}",
        source="imaging_fee",
    )


def _unsupported_combination_message(order: ImagingOrder) -> CalculationMessage:
    return CalculationMessage(
        status=ClaimItemStatus.NEEDS_REVIEW,
        code=None,
        message=f"Imaging fee not added: combination is not supported for {order.kind.value}",
        source="imaging_fee",
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
