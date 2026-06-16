from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from medical_fee_calculation.claim_batch import run_outpatient_lab_claim_payload
from medical_fee_calculation.db import connect, initialize_schema


def calculate_fee_session(payload: dict[str, Any]) -> dict[str, Any]:
    db_path = payload.get("db_path") or os.environ.get("FEE_MASTER_DB_PATH")
    if not db_path:
        raise ValueError("db_path or FEE_MASTER_DB_PATH is required")

    session = _dict_value(payload, "session")
    calculation_input = _dict_value(payload, "input")
    claim_payload = build_claim_payload(session, calculation_input)

    conn = connect(Path(str(db_path)))
    try:
        initialize_schema(conn)
        result = run_outpatient_lab_claim_payload(
            conn,
            claim_payload,
            sequence_number=1,
            auto_master_sources=True,
        )
    finally:
        conn.close()

    result_dict = result.to_dict()
    line_items = _fee_line_items(result_dict["lines"])
    return {
        "calculationResult": {
            "provider": "medical_fee_calculation",
            "source": "python.medical_fee_calculation",
            "status": "failed" if result.status == "error" else "completed",
            "engineStatus": result.status,
            "totalPoints": result_dict["total_points"] or 0,
            "lineItems": line_items,
            "warnings": _warning_messages(result_dict),
            "messages": result_dict["messages"],
            "inputCodes": result_dict["input_codes"],
            "candidateCodes": result_dict["candidate_codes"],
            "coverage": _calculation_coverage(result_dict, line_items),
            "rawResult": result_dict,
        },
        "claimPayload": claim_payload,
    }


def build_claim_payload(session: dict[str, Any], calculation_input: dict[str, Any]) -> dict[str, Any]:
    explicit = _optional_object(calculation_input, "claimContext", "claim_context")
    if explicit is None:
        explicit = _optional_object(session, "claimContext", "claim_context")
    if explicit is not None:
        if not isinstance(explicit, dict):
            raise ValueError("claimContext must be an object")
        return explicit

    orders = calculation_input.get("orders")
    if not isinstance(orders, list):
        orders = session.get("orders") if isinstance(session.get("orders"), list) else []
    session_options = _optional_object(session, "calculationOptions", "calculation_options") or {}
    input_options = _optional_object(calculation_input, "calculationOptions", "calculation_options") or {}
    options = {}
    if isinstance(session_options, dict):
        options.update(session_options)
    if isinstance(input_options, dict):
        options.update(input_options)

    facility = session.get("facilitySnapshot") if isinstance(session.get("facilitySnapshot"), dict) else {}
    patient = session.get("patientSnapshot") if isinstance(session.get("patientSnapshot"), dict) else {}
    procedure_codes: list[str] = []
    drug_inputs: list[dict[str, str]] = []
    injection_drug_inputs: list[dict[str, str]] = []
    material_inputs: list[dict[str, str]] = []

    for order in orders:
        if not isinstance(order, dict):
            continue
        code = _order_code(order)
        if not code:
            continue
        quantity = str(order.get("quantity") or "1")
        order_type = str(order.get("orderType") or order.get("order_type") or "unknown")
        if order_type == "drug":
            drug_inputs.append({"code": code, "quantity": quantity})
        elif order_type == "injection":
            injection_drug_inputs.append({"code": code, "quantity": quantity})
        elif order_type == "material":
            material_inputs.append({"code": code, "quantity": quantity})
        else:
            procedure_codes.append(code)

    procedure_codes.extend(_string_list(options.get("procedure_codes")))

    claim_payload: dict[str, Any] = {
        "record_id": session.get("feeSessionId") or session.get("sessionId"),
        "patient": {
            "patient_id": session.get("patientRef") or session.get("patientId") or patient.get("patientId"),
            "birth_date": patient.get("birthDate"),
            "sex": patient.get("sex"),
        },
        "encounter": {
            "service_date": session.get("serviceDate"),
            "medical_institution_code": facility.get("medicalInstitutionCode"),
            "regional_bureau": facility.get("regionalBureau"),
            "is_outpatient": session.get("setting") != "inpatient",
        },
        "procedure_codes": _unique_strings(procedure_codes),
        "drug_inputs": drug_inputs,
        "injection_drug_inputs": injection_drug_inputs,
        "material_inputs": material_inputs,
    }

    for key in (
        "master_sources",
        "history",
        "lab_options",
        "outpatient_basic",
        "medication",
        "injection",
        "inpatient_basic",
        "dpc",
        "data_completeness",
        "facility_standard_keys",
        "comment_inputs",
        "medication_orders",
        "injection_orders",
        "treatment_orders",
        "imaging_orders",
    ):
        if key in options:
            claim_payload[key] = options[key]

    if "facility_standard_keys" not in claim_payload:
        facility_standard_keys = _unique_strings(
            _string_list(facility.get("facilityStandardKeys"))
            + _string_list(facility.get("facility_standard_keys"))
        )
        if facility_standard_keys:
            claim_payload["facility_standard_keys"] = facility_standard_keys

    _drop_none(claim_payload["patient"])
    _drop_none(claim_payload["encounter"])
    return claim_payload


def _optional_object(source: dict[str, Any], camel_key: str, snake_key: str) -> Any:
    if camel_key in source:
        return source[camel_key]
    if snake_key in source:
        return source[snake_key]
    return None


def _string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _fee_line_items(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        coverage = _line_coverage(line)
        result.append(
            {
                "lineId": f"line_{index + 1}",
                "code": line.get("code"),
                "name": line.get("name"),
                "orderType": _order_type_for_source(line.get("source")),
                "points": line.get("points") or 0,
                "quantity": line.get("quantity") or 1,
                "totalPoints": line.get("total_points") or 0,
                "status": line.get("status") or "candidate",
                "reason": line.get("reason"),
                "source": line.get("source") or "medical_fee_calculation",
                "coverage": coverage,
                "supportLevel": coverage["supportLevel"],
                "reviewRequired": coverage["reviewRequired"],
            }
        )
    return result


def _calculation_coverage(result: dict[str, Any], line_items: list[dict[str, Any]]) -> dict[str, Any]:
    review_line_count = sum(1 for line in line_items if line.get("reviewRequired"))
    review_message_count = sum(
        1
        for message in result.get("messages") or []
        if str(message.get("status") or "") in {"warning", "blocked", "needs_review"}
    )
    review_required = review_line_count > 0 or review_message_count > 0 or result.get("status") != "ok"
    return {
        "scope": "candidate_review_support",
        "chapter": "multi",
        "supportLevel": "partial",
        "support_level": "partial",
        "reviewRequired": review_required,
        "review_required": review_required,
        "lineCount": len(line_items),
        "reviewLineCount": review_line_count,
        "reviewMessageCount": review_message_count,
        "description": (
            "This result is a billing candidate and review-support draft. "
            "It is not a finalized claim calculation."
        ),
    }


def _line_coverage(line: dict[str, Any]) -> dict[str, Any]:
    raw = line.get("coverage") if isinstance(line.get("coverage"), dict) else {}
    status = str(line.get("status") or "candidate")
    source = str(line.get("source") or "medical_fee_calculation")
    support_level = str(
        raw.get("supportLevel")
        or raw.get("support_level")
        or _default_line_support_level(status, source)
    )
    review_required = _raw_bool(
        raw.get("reviewRequired", raw.get("review_required")),
        default=status in {"candidate", "needs_review", "warning", "blocked"} or source == "medical_procedure_master",
    )
    return {
        "scope": str(raw.get("scope") or _default_line_coverage_scope(status, source)),
        "chapter": str(raw.get("chapter") or _default_line_coverage_chapter(source)),
        "supportLevel": support_level,
        "support_level": support_level,
        "reviewRequired": review_required,
        "review_required": review_required,
    }


def _default_line_support_level(status: str, source: str) -> str:
    if source == "medical_procedure_master":
        return "review_required"
    if status == "confirmed":
        return "supported"
    if status == "candidate":
        return "candidate"
    return "review_required"


def _default_line_coverage_scope(status: str, source: str) -> str:
    if source == "medical_procedure_master":
        return "master_lookup_only"
    if status == "confirmed":
        return "deterministic_rule"
    if status == "candidate":
        return "candidate_rule"
    return "review_required"


def _default_line_coverage_chapter(source: str) -> str:
    return {
        "outpatient_basic_fee": "A_basic_fee",
        "outpatient_price_support_add_on": "A_basic_fee",
        "outpatient_management_add_on": "A_basic_fee",
        "inpatient_basic_fee": "A_inpatient_fee",
        "drug_master": "F_drug",
        "medication_fee": "F_drug",
        "injection_fee": "G_injection",
        "treatment_fee": "J_treatment",
        "imaging_fee": "E_imaging",
        "specific_material_master": "specific_material",
        "medical_procedure_master": "procedure_code_master",
    }.get(source, "unknown")


def _raw_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    return default


def _warning_messages(result: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    for message in result.get("messages") or []:
        status = str(message.get("status") or "")
        if status in {"warning", "blocked", "needs_review"}:
            warnings.append(str(message.get("message") or ""))
    if result.get("error"):
        warnings.append(str(result["error"]))
    return [item for item in warnings if item]


def _order_type_for_source(source: object) -> str:
    return {
        "drug_master": "drug",
        "specific_material_master": "material",
        "outpatient_basic_fee": "basic",
        "outpatient_price_support_add_on": "basic",
        "outpatient_management_add_on": "basic",
        "inpatient_basic_fee": "basic",
        "injection_fee": "injection",
        "medication_fee": "drug",
        "treatment_fee": "treatment",
        "imaging_fee": "imaging",
    }.get(str(source or ""), "procedure")


def _order_code(order: dict[str, Any]) -> str | None:
    for key in ("standardCode", "standard_code", "localCode", "local_code", "code"):
        value = order.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _dict_value(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        return {}
    return value


def _drop_none(value: dict[str, Any]) -> None:
    for key in list(value.keys()):
        if value[key] is None:
            del value[key]


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = calculate_fee_session(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc

    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
