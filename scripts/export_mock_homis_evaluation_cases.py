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
                source_record_id = f"{patient['id']}-{service_date.replace('-', '')}"
                cases.append({
                    "caseId": source_record_id,
                    "patientId": str(patient["id"]),
                    "serviceDate": service_date,
                    "receptionTime": str(visit.get("time") or ""),
                    "setting": setting,
                    "visitKind": visit_kind,
                    "sameBuilding": same_building,
                    "singleBuildingPatientCount": count if same_building else 1,
                    "residenceType": patient_residence_type(patient),
                    "sourceRecordId": source_record_id,
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
