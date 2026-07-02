#!/usr/bin/env python3
import csv
import json
import sys
from pathlib import Path


MOCK_ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tmp/mock_homis")
OUT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("tmp/dataset_recalculation_diff_diagnosis/mock_homis_direct_export")

sys.path.insert(0, str(MOCK_ROOT.resolve()))

from data.patients import (  # noqa: E402
    CLINIC_NAME,
    PATIENTS,
    PREV_MONTH,
    PREV_YEAR,
    TARGET_MONTH,
    TARGET_YEAR,
)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, value) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows) -> None:
    ensure_dir(path.parent)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def write_csv(path: Path, fieldnames, rows) -> None:
    ensure_dir(path.parent)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fieldnames})


def visit_iso(ym: str, visit: dict) -> str:
    return f"{ym}-{int(visit['day']):02d}"


def patient_base(patient: dict) -> dict:
    return {
        "patient_id": patient.get("id", ""),
        "display_name": patient.get("name", ""),
        "kana": patient.get("kana", ""),
        "sex": patient.get("sex", ""),
        "birth_date": patient.get("birth", ""),
        "age": patient.get("age", ""),
        "is_facility": patient.get("is_facility", False),
        "facility_name": patient.get("facility_name", ""),
        "facility_count": patient.get("facility_count", ""),
        "postal": patient.get("postal", ""),
        "address": patient.get("address", ""),
        "phone": patient.get("phone", ""),
        "insurance_kind": (patient.get("hoken") or {}).get("kind", ""),
        "insurance_number": (patient.get("hoken") or {}).get("number", ""),
        "insurance_copay": (patient.get("hoken") or {}).get("futan", ""),
        "start_date": patient.get("start_date", ""),
        "care_text": patient.get("kaigo", ""),
        "visiting_nurse_text": patient.get("houkan", ""),
        "disability_text": patient.get("shougai", ""),
        "plan": patient.get("plan", ""),
    }


def flatten_prescription(patient_id: str, service_date: str, visit: dict) -> list[dict]:
    rows = []
    for block_index, block in enumerate(visit.get("shohou") or [], start=1):
        rows.append({
            "patient_id": patient_id,
            "service_date": service_date,
            "claim_month": service_date[:7],
            "block_index": block_index,
            "rp": block.get("rp", ""),
            "type": block.get("type", ""),
            "lines": "\n".join(block.get("lines") or []),
            "source": "patients.py:visits[].shohou",
        })
    return rows


def main() -> None:
    ensure_dir(OUT_DIR)
    standard_dir = OUT_DIR / "standard_files"
    patient_rows = []
    chart_rows = []
    visit_rows = []
    problem_rows = []
    document_rows = []
    plan_rows = []
    device_rows = []
    prescription_rows = []
    action_rows = []

    for patient in PATIENTS:
        pid = patient.get("id", "")
        pdir = OUT_DIR / "patients" / pid
        ensure_dir(pdir)
        base = patient_base(patient)
        patient_rows.append(base)
        plan_rows.append({
            "patient_id": pid,
            "plan": patient.get("plan", ""),
            "target_year": TARGET_YEAR,
            "target_month": TARGET_MONTH,
            "source": "patients.py:plan",
        })
        for index, problem in enumerate(patient.get("problems") or [], start=1):
            problem_rows.append({
                "patient_id": pid,
                "problem_index": index,
                "diagnosis_name": problem.get("name", ""),
                "since": problem.get("since", ""),
                "is_primary": problem.get("main", False),
                "source": "patients.py:problems",
            })
        for index, doc in enumerate(patient.get("docs") or [], start=1):
            period = doc.get("period") or ["", ""]
            document_rows.append({
                "patient_id": pid,
                "document_index": index,
                "kind": doc.get("kind", ""),
                "period_from": period[0] if len(period) > 0 else "",
                "period_to": period[1] if len(period) > 1 else "",
                "written": doc.get("written", ""),
                "source": "patients.py:docs",
            })
        for index, device in enumerate(patient.get("devices") or [], start=1):
            device_rows.append({
                "patient_id": pid,
                "device_index": index,
                "device_text": device,
                "source": "patients.py:devices",
            })

        patient_visits = []
        patient_actions = []
        for ym, visits in sorted((patient.get("visits") or {}).items()):
            for visit in visits:
                service_date = visit_iso(ym, visit)
                visit_record = {
                    "patient_id": pid,
                    "claim_month": ym,
                    "service_date": service_date,
                    "day": visit.get("day", ""),
                    "visit_type": visit.get("type", ""),
                    "time": visit.get("time", ""),
                    "status": visit.get("status", ""),
                    "single_building_patient_count": visit.get("tatemono", ""),
                    "source": "patients.py:visits",
                }
                visit_rows.append(visit_record)
                patient_visits.append({
                    **visit_record,
                    "soap": visit.get("soap", ""),
                    "prescriptions": visit.get("shohou") or [],
                    "action_list": visit.get("action_list") or [],
                })
                chart_rows.append({
                    "patient_id": pid,
                    "claim_month": ym,
                    "service_date": service_date,
                    "clinical_text": visit.get("soap", ""),
                    "visit_type": visit.get("type", ""),
                    "status": visit.get("status", ""),
                    "source": "patients.py:visits[].soap",
                })
                prescription_rows.extend(flatten_prescription(pid, service_date, visit))
                for action_index, action in enumerate(visit.get("action_list") or [], start=1):
                    row = {
                        "patient_id": pid,
                        "claim_month": ym,
                        "service_date": service_date,
                        "action_index": action_index,
                        "action_name": action,
                        "source": "patients.py:visits[].action_list",
                    }
                    action_rows.append(row)
                    patient_actions.append(row)

        write_json(pdir / "direct_patient.json", patient)
        write_jsonl(pdir / "direct_visits.jsonl", patient_visits)
        write_csv(pdir / "direct_gold_actions.csv", ["patient_id", "claim_month", "service_date", "action_index", "action_name", "source"], patient_actions)

    write_csv(standard_dir / "patients.csv", [
        "patient_id", "display_name", "kana", "sex", "birth_date", "age", "is_facility", "facility_name",
        "facility_count", "postal", "address", "phone", "insurance_kind", "insurance_number", "insurance_copay",
        "start_date", "care_text", "visiting_nurse_text", "disability_text", "plan"
    ], patient_rows)
    write_jsonl(standard_dir / "charts.jsonl", chart_rows)
    write_csv(standard_dir / "visits.csv", [
        "patient_id", "claim_month", "service_date", "day", "visit_type", "time", "status",
        "single_building_patient_count", "source"
    ], visit_rows)
    write_csv(standard_dir / "problem_list.csv", [
        "patient_id", "problem_index", "diagnosis_name", "since", "is_primary", "source"
    ], problem_rows)
    write_csv(standard_dir / "documents.csv", [
        "patient_id", "document_index", "kind", "period_from", "period_to", "written", "source"
    ], document_rows)
    write_csv(standard_dir / "plans.csv", ["patient_id", "plan", "target_year", "target_month", "source"], plan_rows)
    write_csv(standard_dir / "devices.csv", ["patient_id", "device_index", "device_text", "source"], device_rows)
    write_jsonl(standard_dir / "prescriptions.jsonl", prescription_rows)
    write_csv(standard_dir / "gold_actions.csv", [
        "patient_id", "claim_month", "service_date", "action_index", "action_name", "source"
    ], action_rows)
    write_json(standard_dir / "manifest.json", {
        "schemaVersion": "mock-homis-collection.v1",
        "source": "tmp/mock_homis/data/patients.py",
        "clinicName": CLINIC_NAME,
        "targetMonth": f"{TARGET_YEAR}-{TARGET_MONTH:02d}",
        "previousMonth": f"{PREV_YEAR}-{PREV_MONTH:02d}",
        "patientCount": len(PATIENTS),
        "visitCount": len(visit_rows),
        "goldActionCount": len(action_rows),
        "files": {
            "patients": "patients.csv",
            "charts": "charts.jsonl",
            "visits": "visits.csv",
            "problemList": "problem_list.csv",
            "documents": "documents.csv",
            "plans": "plans.csv",
            "devices": "devices.csv",
            "prescriptions": "prescriptions.jsonl",
            "goldActions": "gold_actions.csv"
        }
    })
    unknowns = [
        "direct: action_list は算定項目名のみで、診療行為コード・薬剤コード・材料コード・点数は patients.py にありません。",
        "direct: shohou は処方欄の表示テキストであり、薬剤コード・単位・用量の標準構造は patients.py にありません。",
        "direct: problems は開始日付きプロブレム一覧であり、訪問日ごとの病名確定データではありません。",
        "direct: docs は書類種別・期間・記入日のみで、文書本文は patients.py にありません。",
        "direct: HOMIS画面上のXPath取得可否はこの経路では検証していません。"
    ]
    (OUT_DIR / "unknowns.md").write_text("# Direct export unknowns\n\n" + "\n".join(f"- {item}" for item in unknowns) + "\n", encoding="utf-8")
    write_json(OUT_DIR / "summary.json", {
        "source": "patients.py",
        "patientCount": len(PATIENTS),
        "visitCount": len(visit_rows),
        "goldActionCount": len(action_rows),
        "targetMonth": f"{TARGET_YEAR}-{TARGET_MONTH:02d}",
        "previousMonth": f"{PREV_YEAR}-{PREV_MONTH:02d}"
    })


if __name__ == "__main__":
    main()
