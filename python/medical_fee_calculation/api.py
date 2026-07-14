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
        result_dict = result.to_dict()
        # 点検(算定もれ等)で使う診療行為メタ(検査判断区分・区分)を明細に付与する。conn を閉じる前に解決する。
        line_items = _fee_line_items(result_dict["lines"], conn=conn)
        coverage_warning = _master_coverage_warning(conn, claim_payload)
    finally:
        conn.close()
    warnings = _warning_messages(result_dict)
    if coverage_warning:
        # 適用期間外は「静かに0点」で最も誤解を生むため、警告先頭で明示する。
        warnings = [coverage_warning, *warnings]
    return {
        "calculationResult": {
            "provider": "medical_fee_calculation",
            "source": "python.medical_fee_calculation",
            "status": "failed" if result.status == "error" else "completed",
            "engineStatus": result.status,
            "totalPoints": result_dict["total_points"] or 0,
            "lineItems": line_items,
            "warnings": warnings,
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
        "kizami_quantities",
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


def _fee_line_items(lines: list[dict[str, Any]], conn: Any = None) -> list[dict[str, Any]]:
    codes = [str(line.get("code")) for line in lines if line.get("code")]
    procedure_meta = _procedure_meta_map(conn, codes) if conn is not None else {}
    result: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        coverage = _line_coverage(line)
        item = {
            "lineId": f"line_{index + 1}",
            "code": line.get("code"),
            "name": line.get("name"),
            "orderType": _order_type_for_source(line.get("source")),
            "points": line.get("points") or 0,
            "quantity": line.get("quantity") or 1,
            "totalPoints": line.get("total_points") or 0,
            "status": line.get("status") or "candidate",
            "excludedFromTotal": bool(line.get("excluded_from_total")),
            "reason": line.get("reason"),
            "source": line.get("source") or "medical_fee_calculation",
            "coverage": coverage,
            "supportLevel": coverage["supportLevel"],
            "reviewRequired": coverage["reviewRequired"],
        }
        meta = procedure_meta.get(str(line.get("code") or ""))
        if meta:
            # 算定もれ点検(検査判断料等)で使う診療行為メタ。存在する項目のみ付与。
            for key in ("judgementKind", "judgementGroup", "bundleLabGroup", "chapter", "section"):
                if meta.get(key):
                    item[key] = meta[key]
        result.append(item)
    return result


def _procedure_meta_map(conn: Any, codes: list[str]) -> dict[str, dict[str, str]]:
    """診療行為コード群のメタ(検査判断区分・グループ・区分)を1クエリで引く。"""
    unique = _unique_strings(codes)
    if not unique:
        return {}
    placeholders = ",".join("?" for _ in unique)
    try:
        rows = conn.execute(
            f"""
            SELECT code, judgement_kind, judgement_group, bundle_lab_group, chapter, section
            FROM medical_procedures
            WHERE code IN ({placeholders})
            """,
            unique,
        ).fetchall()
    except Exception:  # noqa: BLE001 - メタ付与は点検補助であり、失敗しても算定本体は返す。
        return {}
    meta: dict[str, dict[str, str]] = {}
    for row in rows:
        code = str(row["code"])
        if code in meta:
            continue
        meta[code] = {
            "judgementKind": (row["judgement_kind"] or "").strip(),
            "judgementGroup": (row["judgement_group"] or "").strip().lstrip("0"),
            "bundleLabGroup": (row["bundle_lab_group"] or "").strip(),
            "chapter": (row["chapter"] or "").strip(),
            "section": (row["section"] or "").strip(),
        }
    return meta


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
        "outpatient_pediatric_add_on": "A_basic_fee",
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


def _master_coverage_warning(conn: Any, claim_payload: dict[str, Any]) -> str:
    """診療日が取込済みマスタの適用期間外なら明示警告を返す。

    期間外は全コードが「not found for service date」になり静かに0点となるため、
    原因を利用者へ明示する(F3: mock_partner 2025-01 事象の恒久対応)。
    """
    encounter = claim_payload.get("encounter") if isinstance(claim_payload.get("encounter"), dict) else {}
    service_date = str(encounter.get("service_date") or "").strip()
    if not service_date:
        return ""
    try:
        row = conn.execute(
            """
            SELECT MIN(effective_from) AS min_from, MAX(effective_to) AS max_to
            FROM medical_procedures
            WHERE source_id = (
                SELECT id FROM master_sources
                WHERE source_type = 'medical_procedure_master'
                ORDER BY imported_at DESC, id DESC LIMIT 1
            )
            """
        ).fetchone()
    except Exception:  # noqa: BLE001 - 警告は補助。失敗しても算定は継続する。
        return ""
    if not row or not row["min_from"]:
        return ""
    min_from = str(row["min_from"])
    max_to = str(row["max_to"] or "9999-12-31")
    if service_date < min_from:
        return (
            f"マスタ適用期間外: 診療日{service_date}は取込済み診療行為マスタの適用開始({min_from})より前です。"
            "診療行為コードが解決できず0点となる可能性があります。対象年度のマスタ取込か診療日を確認してください。"
        )
    if service_date > max_to:
        return (
            f"マスタ適用期間外: 診療日{service_date}は取込済み診療行為マスタの適用終了({max_to})より後です。"
            "最新年度のマスタ取込を確認してください。"
        )
    return ""


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
        "outpatient_pediatric_add_on": "basic",
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
