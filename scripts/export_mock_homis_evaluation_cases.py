#!/usr/bin/env python3
"""Export synthetic mock HOMIS visits for coverage evaluation.

The output is transient input to the evaluator. The evaluator persists only
hashes and aggregate metrics, never patient names or chart text.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import unicodedata


RECORD_KEY_SEPARATOR = "\x1f"
RECORD_KEY_VERSION = "homis-visible-record-v1"
MAX_SOURCE_RECORD_ID_BYTES = 256


def load_patients(mock_root: Path) -> list[dict]:
    source = mock_root / "data" / "patients.py"
    if not source.is_file():
        raise SystemExit(f"mock patients file not found: {source}")
    spec = importlib.util.spec_from_file_location("halunasu_mock_homis_patients", source)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load mock patients file: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.PATIENTS)


def visit_setting(visit_type: str) -> tuple[str, str | None]:
    if visit_type == "定期":
        return "home_visit", None
    if visit_type == "臨時":
        return "house_call", None
    if visit_type == "電話":
        return "outpatient", "telephone_revisit"
    return "outpatient", None


def patient_residence_type(patient: dict) -> str:
    return "facility" if patient.get("is_facility") else "private"


def build_visible_record_key(
    patient_id: object,
    service_date: object,
    displayed_chart_id: object,
    reception_time: object,
) -> str:
    values = [
        normalize_record_component(RECORD_KEY_VERSION, 32),
        normalize_record_component("homis", 16),
        normalize_record_component(patient_id, 64),
        normalize_record_component(service_date, 10),
        normalize_record_component(displayed_chart_id, 96),
        normalize_record_component(reception_time, 5),
    ]
    if any(not value for value in values):
        raise ValueError("visible HOMIS record key is incomplete")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", values[3]):
        raise ValueError("service date must use YYYY-MM-DD")
    if not re.fullmatch(r"\d{2}:\d{2}", values[5]):
        raise ValueError("reception time must use HH:MM")
    key = RECORD_KEY_SEPARATOR.join(values)
    if len(key.encode("utf-8")) > MAX_SOURCE_RECORD_ID_BYTES:
        raise ValueError("visible HOMIS record key is too long")
    return key


def normalize_record_component(value: object, maximum_length: int) -> str:
    normalized = unicodedata.normalize("NFC", str(value or "")).strip()
    if (
        not normalized
        or len(normalized) > maximum_length
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        return ""
    return normalized


def prescription_rows(blocks: object) -> list[str]:
    rows: list[str] = []
    if not isinstance(blocks, list) or not blocks:
        return ["（処方なし・Do）"]
    for block in blocks:
        if not isinstance(block, dict):
            continue
        rows.append(
            " ".join(
                value
                for value in (
                    str(block.get("rp") or "").strip(),
                    str(block.get("type") or "").strip(),
                    "カルテ入力",
                )
                if value
            )
        )
        rows.extend(
            str(line).strip()
            for line in block.get("lines", [])
            if str(line).strip()
        )
    return rows


def document_rows(documents: object) -> list[dict]:
    rows: list[dict] = []
    if not isinstance(documents, list):
        return rows
    for document in documents:
        if not isinstance(document, dict) or not document.get("kind"):
            continue
        period = document.get("period")
        if isinstance(period, (tuple, list)) and len(period) == 2:
            period_text = f"{period[0]} - {period[1]}"
        else:
            period_text = str(period or "")
        rows.append(
            {
                "kind": str(document.get("kind") or ""),
                "period": period_text,
                "writtenDate": str(document.get("written") or ""),
                "status": "作成済",
            }
        )
    return rows


def current_chart_surface_raw(patient: dict, visit: dict, month: str) -> dict:
    visit_dates = sorted(
        f"{month}-{int(entry['day']):02d}"
        for entry in patient.get("visits", {}).get(month, [])
        if entry.get("day")
    )
    devices = [
        str(value).strip()
        for value in patient.get("devices", [])
        if str(value).strip()
    ]
    return {
        "careInsuranceText": str(patient.get("kaigo") or ""),
        "visitingNurseText": str(patient.get("houkan") or ""),
        "deviceManagementText": "\n".join(devices) or "（在宅医療機器の登録なし）",
        "prescriptionRows": prescription_rows(visit.get("shohou")),
        "patientStartDate": str(patient.get("start_date") or "") or None,
        "calendarMonth": month,
        "calendarVisitDates": visit_dates,
    }


def export_cases(mock_root: Path, claim_month: str | None) -> dict:
    cases = []
    for patient in load_patients(mock_root):
        for month, visits in patient.get("visits", {}).items():
            if claim_month and month != claim_month:
                continue
            for visit in visits:
                day = int(visit["day"])
                service_date = f"{month}-{day:02d}"
                setting, visit_kind = visit_setting(str(visit.get("type") or ""))
                count = int(visit.get("tatemono") or patient.get("facility_count") or 1)
                same_building = bool(patient.get("is_facility") or count > 1)
                reception_time = str(visit.get("time") or "")
                displayed_chart_id = f"{patient['id']}{int(month[5:7]):02d}{day:02d}"
                source_record_id = build_visible_record_key(
                    patient["id"],
                    service_date,
                    displayed_chart_id,
                    reception_time,
                )
                cases.append({
                    "caseId": f"{patient['id']}-{service_date}-{reception_time}",
                    "patientId": str(patient["id"]),
                    "serviceDate": service_date,
                    "receptionTime": reception_time,
                    "setting": setting,
                    "visitKind": visit_kind,
                    "sameBuilding": same_building,
                    "singleBuildingPatientCount": count if same_building else 1,
                    "residenceType": patient_residence_type(patient),
                    "sourceRecordId": source_record_id,
                    "sourceRecordDisplayId": displayed_chart_id,
                    "clinicalText": str(visit.get("soap") or ""),
                    "diagnoses": [
                        {"name": str(problem.get("name") or "")}
                        for problem in patient.get("problems", [])
                        if problem.get("name")
                    ],
                    "actionList": [
                        str(action)
                        for action in visit.get("action_list", [])
                        if str(action).strip()
                    ],
                    "sourceSurfaceRaw": {
                        "currentChart": current_chart_surface_raw(patient, visit, month),
                        "documents": {
                            "rows": document_rows(patient.get("docs")),
                        },
                    },
                })
    return {
        "schemaVersion": "mock-homis-act-coverage-cases-v1",
        "syntheticDataOnly": True,
        "source": str(mock_root / "data" / "patients.py"),
        "claimMonth": claim_month,
        "caseCount": len(cases),
        "cases": cases,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock-root", default="tmp/mock_homis")
    parser.add_argument("--claim-month")
    args = parser.parse_args()
    payload = export_cases(Path(args.mock_root), args.claim_month)
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
