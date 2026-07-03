#!/usr/bin/env python3
"""Build an uploadable recalculation-diff dataset from mock HOMIS exports.

The conversion is intentionally conservative:

- Only exact procedure master matches with a code and points are exported to
  receipt.csv and orders.csv.
- Comment rows, ambiguous rows, unmatched rows, and inputs without structured
  code/quantity data are written to unknowns.csv.
- Patient folders are included for review, while root-level aggregate files are
  kept so the current STG recalculation-diff UI can ingest the ZIP.
"""

from __future__ import annotations

import csv
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


SOURCE_DIR = Path("tmp/dataset_recalculation_diff_diagnosis/20260702_185214_mock_homis")
OUTPUT_ROOT = Path("tmp/dataset_recalculation_diff_diagnosis")

DATE_RE = re.compile(r"令和\s*[0-9０-９]+\s*年\s*[0-9０-９]+\s*月\s*[0-9０-９]+\s*日")

RECEIPT_FIELDS = [
    "patient_id",
    "claim_month",
    "code",
    "name",
    "points",
    "count",
    "medical_institution_code",
]
ORDER_FIELDS = [
    "patient_id",
    "service_date",
    "order_type",
    "code",
    "name",
    "quantity",
    "total_quantity",
    "quantity_per_day",
    "days",
    "dose_quantity",
    "doses_per_day",
    "status",
    "kind",
    "area_size",
    "medical_institution_code",
    "regional_bureau",
    "source",
]
DIAGNOSIS_FIELDS = [
    "patient_id",
    "service_date",
    "diagnosis_name",
    "icd10_code",
    "is_primary",
    "source",
]
UNKNOWN_FIELDS = [
    "patient_id",
    "claim_month",
    "service_date",
    "source",
    "item_name",
    "reason",
    "match_status",
    "candidate_codes",
    "note",
]


def normalize_action_name(value: str) -> str:
    text = str(value or "").strip()
    text = DATE_RE.sub("{date}", text)
    text = re.sub(r"単一建物診療患者数（施医総管）；\d+", "単一建物診療患者数（施医総管）；{count}", text)
    text = re.sub(r"同一患家\s*[0-9０-９日、,・\\s]+", "同一患家 {dates}", text)
    return text


def action_key(value: str) -> str:
    return re.sub(r"\s+", "", normalize_action_name(value))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def is_safe_procedure_match(row: dict[str, str]) -> bool:
    return (
        row.get("match_status") == "exact_master_name"
        and row.get("master_kind") == "procedure"
        and bool(str(row.get("code") or "").strip())
        and bool(str(row.get("points") or "").strip())
    )


def points_text(value: str) -> str:
    number = float(value)
    return str(int(number)) if number.is_integer() else str(number)


def reason_for_unconverted_action(map_row: dict[str, str] | None) -> str:
    if not map_row:
        return "action map に存在しないため、コードを推測せず除外しました。"
    status = map_row.get("match_status") or "unknown"
    if status == "manual_required":
        return "現行マスターに完全一致する名称がなく、コードを推測せず除外しました。"
    if status == "ambiguous_exact_master_name":
        return "同名の候補コードが複数あり、手動選択が必要なため除外しました。"
    if status == "comment_or_nonclaim":
        return "コメントまたは非請求行のため、receipt/orders 明細には変換しませんでした。"
    if status == "exact_master_name":
        return "完全一致しましたが、点数付き診療行為として安全に出力できないため除外しました。"
    return f"{status} のため、コードを推測せず除外しました。"


def row_claim_month(row: dict, fallback: str = "") -> str:
    return str(row.get("claim_month") or row.get("claimMonth") or fallback or "").strip()


def row_patient_id(row: dict) -> str:
    return str(row.get("patient_id") or row.get("patientId") or "").strip()


def row_service_date(row: dict) -> str:
    return str(row.get("service_date") or row.get("serviceDate") or "").strip()


def safe_action_rows(gold_actions: list[dict[str, str]], action_map: dict[str, dict[str, str]], target_month: str):
    receipt_counter: Counter[tuple[str, str, str, str, str]] = Counter()
    order_rows: list[dict[str, str]] = []
    unknown_rows: list[dict[str, str]] = []

    for action in gold_actions:
        claim_month = row_claim_month(action)
        if target_month and claim_month != target_month:
            continue
        patient_id = row_patient_id(action)
        service_date = row_service_date(action)
        action_name = str(action.get("action_name") or "").strip()
        map_row = action_map.get(action_key(action_name))
        if is_safe_procedure_match(map_row or {}):
            code = str(map_row["code"]).strip()
            name = str(map_row["master_name"] or action_name).strip()
            points = points_text(str(map_row["points"]))
            receipt_counter[(patient_id, claim_month, code, name, points)] += 1
            order_rows.append({
                "patient_id": patient_id,
                "service_date": service_date,
                "order_type": "procedure_code",
                "code": code,
                "name": name,
                "quantity": "1",
                "status": "performed",
                "source": f"gold_actions.csv:{action.get('action_index', '')}",
            })
            continue

        unknown_rows.append({
            "patient_id": patient_id,
            "claim_month": claim_month,
            "service_date": service_date,
            "source": "gold_actions.csv",
            "item_name": action_name,
            "reason": reason_for_unconverted_action(map_row),
            "match_status": (map_row or {}).get("match_status", "missing_action_map"),
            "candidate_codes": (map_row or {}).get("candidate_codes", ""),
            "note": (map_row or {}).get("note", ""),
        })

    receipt_rows = [
        {
            "patient_id": patient_id,
            "claim_month": claim_month,
            "code": code,
            "name": name,
            "points": points,
            "count": str(count),
            "medical_institution_code": "",
        }
        for (patient_id, claim_month, code, name, points), count in sorted(receipt_counter.items())
    ]
    order_rows.sort(key=lambda row: (row["patient_id"], row["service_date"], row["code"], row["name"]))
    unknown_rows.sort(key=lambda row: (row["patient_id"], row["service_date"], row["source"], row["item_name"]))
    return receipt_rows, order_rows, unknown_rows


def build_context_unknowns(
    prescriptions: list[dict],
    problem_list: list[dict[str, str]],
    devices: list[dict[str, str]],
    target_month: str,
) -> list[dict[str, str]]:
    unknowns: list[dict[str, str]] = []
    for row in prescriptions:
        if target_month and row_claim_month(row) != target_month:
            continue
        unknowns.append({
            "patient_id": row_patient_id(row),
            "claim_month": row_claim_month(row),
            "service_date": row_service_date(row),
            "source": "prescriptions.jsonl",
            "item_name": str(row.get("lines") or "").replace("\n", " / "),
            "reason": "処方テキストに薬剤コード・標準化された用量/日数フィールドがないため、薬剤明細へ推測変換しませんでした。",
            "match_status": "missing_structured_drug_code_quantity",
            "candidate_codes": "",
            "note": str(row.get("source") or ""),
        })

    for row in problem_list:
        unknowns.append({
            "patient_id": row_patient_id(row),
            "claim_month": target_month,
            "service_date": "",
            "source": "problem_list.csv",
            "item_name": str(row.get("diagnosis_name") or ""),
            "reason": "開始日付きプロブレム一覧であり、訪問日ごとの確定病名ではないため diagnoses.csv へ推測展開しませんでした。",
            "match_status": "not_service_date_diagnosis",
            "candidate_codes": "",
            "note": f"since={row.get('since', '')}; is_primary={row.get('is_primary', '')}",
        })

    for row in devices:
        unknowns.append({
            "patient_id": row_patient_id(row),
            "claim_month": target_month,
            "service_date": "",
            "source": "devices.csv",
            "item_name": str(row.get("device_text") or ""),
            "reason": "患者単位の機器・管理情報であり、訪問日別の実施明細として確定できないため orders.csv へ推測展開しませんでした。",
            "match_status": "not_service_date_order",
            "candidate_codes": "",
            "note": str(row.get("source") or ""),
        })
    return unknowns


def filter_rows_by_patients(rows: list[dict], patient_ids: set[str]) -> list[dict]:
    return [row for row in rows if row_patient_id(row) in patient_ids]


def filter_rows_by_month(rows: list[dict], target_month: str) -> list[dict]:
    if not target_month:
        return rows
    return [row for row in rows if row_claim_month(row) == target_month]


def patient_month_ids(rows: list[dict], target_month: str) -> set[str]:
    return {row_patient_id(row) for row in rows if row_patient_id(row) and row_claim_month(row) == target_month}


def write_dataset_files(output_dir: Path, rows: dict[str, list[dict]], manifest: dict) -> None:
    write_csv(output_dir / "receipt.csv", rows["receipt"], RECEIPT_FIELDS)
    write_csv(output_dir / "patients.csv", rows["patients"], list(rows["patient_fields"]))
    write_jsonl(output_dir / "charts.jsonl", rows["charts"])
    write_csv(output_dir / "orders.csv", rows["orders"], ORDER_FIELDS)
    write_csv(output_dir / "diagnoses.csv", rows["diagnoses"], DIAGNOSIS_FIELDS)
    (output_dir / "facility.json").write_text(json.dumps(rows["facility"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(output_dir / "unknowns.csv", rows["unknowns"], UNKNOWN_FIELDS)
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_readme(output_dir: Path, summary: dict) -> None:
    text = f"""# mock HOMIS 再算定差分診断データセット

作成日: {summary["createdAt"]}

## 使い方

STG の `再算定差分診断` 画面で `{summary["zipName"]}` を `診断データセット` としてアップロードします。

このZIPは、現行UIが読めるルート集約ファイルと、レビュー用の患者別フォルダを同梱しています。

## 変換ルール

- `receipt.csv` と `orders.csv` には、`gold_actions.csv` と `homis_action_master_map.csv` で完全一致し、かつ点数付き診療行為として確定できる行だけを入れています。
- コード未確定、候補複数、コメント/非請求、薬剤・材料数量不足、訪問日別病名として確定できない情報は `unknowns.csv` に出しています。
- 不明値は推測で補っていません。

## 件数

- 対象請求月: {summary["claimMonth"]}
- 患者数: {summary["patientCount"]}
- receipt.csv 明細: {summary["receiptRowCount"]}
- orders.csv 明細: {summary["orderRowCount"]}
- unknowns.csv 行: {summary["unknownRowCount"]}
- 患者別フォルダ: `patients/{{patient_id}}/`
"""
    (output_dir / "README.md").write_text(text, encoding="utf-8")


def zip_dir(source_dir: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(source_dir.rglob("*")):
            if path == zip_path or path.is_dir():
                continue
            zf.write(path, path.relative_to(source_dir).as_posix())


def main() -> None:
    source_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE_DIR
    output_root = Path(sys.argv[2]) if len(sys.argv) > 2 else OUTPUT_ROOT
    standard_dir = source_dir / "direct_export" / "standard_files"
    manifest = json.loads((standard_dir / "manifest.json").read_text(encoding="utf-8"))
    target_month = str(manifest.get("targetMonth") or manifest.get("claimMonth") or "").strip()
    if not target_month:
        raise SystemExit("targetMonth/claimMonth が manifest.json にありません。")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = output_root / f"{timestamp}_mock_homis_recalculation_diff"
    output_dir.mkdir(parents=True, exist_ok=False)

    patients = read_csv(standard_dir / "patients.csv")
    charts = read_jsonl(standard_dir / "charts.jsonl")
    visits = read_csv(standard_dir / "visits.csv")
    problem_list = read_csv(standard_dir / "problem_list.csv")
    devices = read_csv(standard_dir / "devices.csv")
    prescriptions = read_jsonl(standard_dir / "prescriptions.jsonl")
    gold_actions = read_csv(standard_dir / "gold_actions.csv")
    action_map_rows = read_csv(source_dir / "homis_action_master_map.csv")
    action_map = {row["action_key"]: row for row in action_map_rows if row.get("action_key")}

    receipt_rows, order_rows, action_unknowns = safe_action_rows(gold_actions, action_map, target_month)
    context_unknowns = build_context_unknowns(prescriptions, problem_list, devices, target_month)
    unknown_rows = sorted(action_unknowns + context_unknowns, key=lambda row: (
        row.get("patient_id", ""),
        row.get("service_date", ""),
        row.get("source", ""),
        row.get("item_name", ""),
    ))

    target_patient_ids = sorted(
        patient_month_ids(gold_actions, target_month)
        | patient_month_ids(charts, target_month)
        | patient_month_ids(visits, target_month)
        | {row["patient_id"] for row in receipt_rows if row.get("patient_id")}
        | {row["patient_id"] for row in order_rows if row.get("patient_id")}
    )
    target_patient_set = set(target_patient_ids)
    patient_fields = patients[0].keys() if patients else ["patient_id", "display_name"]
    patient_rows = [row for row in patients if row_patient_id(row) in target_patient_set]
    chart_rows = [row for row in charts if row_patient_id(row) in target_patient_set and row_claim_month(row) == target_month]

    rows = {
        "receipt": receipt_rows,
        "patients": patient_rows,
        "patient_fields": list(patient_fields),
        "charts": chart_rows,
        "orders": order_rows,
        "diagnoses": [],
        "facility": {
            "clinicName": manifest.get("clinicName", ""),
            "medicalInstitutionCode": "",
            "regionalBureau": "",
            "facilityStandardKeys": [],
        },
        "unknowns": unknown_rows,
    }
    upload_manifest = {
        "schemaVersion": "recalculation-diff.v1",
        "datasetName": "mock-homis-recalculation-diff",
        "sourceSchemaVersion": manifest.get("schemaVersion", ""),
        "source": str(source_dir),
        "claimMonth": target_month,
        "previousMonth": manifest.get("previousMonth", ""),
        "clinicName": manifest.get("clinicName", ""),
        "files": {
            "baselineReceipt": "receipt.csv",
            "patients": "patients.csv",
            "charts": "charts.jsonl",
            "orders": "orders.csv",
            "diagnoses": "diagnoses.csv",
            "facility": "facility.json",
        },
        "reviewFiles": {
            "unknowns": "unknowns.csv",
            "patientFolders": "patients/{patient_id}/",
        },
        "conversionPolicy": {
            "exportedToReceiptAndOrders": "exact procedure master matches with code and points only",
            "notInferred": True,
        },
    }
    write_dataset_files(output_dir, rows, upload_manifest)

    by_patient = defaultdict(lambda: {
        "receipt": [],
        "patients": [],
        "charts": [],
        "orders": [],
        "diagnoses": [],
        "unknowns": [],
    })
    for key in ["receipt", "patients", "charts", "orders", "unknowns"]:
        for row in rows[key]:
            patient_id = row_patient_id(row)
            if patient_id:
                by_patient[patient_id][key].append(row)

    for patient_id in target_patient_ids:
        patient_dir = output_dir / "patients" / patient_id
        patient_manifest = {
            **upload_manifest,
            "datasetName": f"mock-homis-recalculation-diff-{patient_id}",
            "patientId": patient_id,
            "files": upload_manifest["files"],
            "reviewFiles": {"unknowns": "unknowns.csv"},
        }
        patient_rows_bundle = {
            "receipt": by_patient[patient_id]["receipt"],
            "patients": by_patient[patient_id]["patients"],
            "patient_fields": list(patient_fields),
            "charts": by_patient[patient_id]["charts"],
            "orders": by_patient[patient_id]["orders"],
            "diagnoses": [],
            "facility": rows["facility"],
            "unknowns": by_patient[patient_id]["unknowns"],
        }
        write_dataset_files(patient_dir, patient_rows_bundle, patient_manifest)

    summary = {
        "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceDir": str(source_dir),
        "outputDir": str(output_dir),
        "zipName": f"mock-homis-recalculation-diff_{timestamp}.zip",
        "claimMonth": target_month,
        "patientCount": len(target_patient_ids),
        "receiptRowCount": len(receipt_rows),
        "orderRowCount": len(order_rows),
        "unknownRowCount": len(unknown_rows),
        "safeActionCount": len(order_rows),
        "goldActionTargetMonthCount": sum(1 for row in gold_actions if row_claim_month(row) == target_month),
        "unknownStatusCounts": dict(Counter(row["match_status"] for row in unknown_rows)),
        "patientIds": target_patient_ids,
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_readme(output_dir, summary)
    zip_path = output_dir / summary["zipName"]
    zip_dir(output_dir, zip_path)
    summary["zipPath"] = str(zip_path)
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
