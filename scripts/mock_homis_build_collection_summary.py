#!/usr/bin/env python3
import csv
import json
import sys
import zipfile
from pathlib import Path


ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tmp/dataset_recalculation_diff_diagnosis/mock_homis_collection")


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def count_csv_rows(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8", newline="") as f:
        return max(0, sum(1 for _ in csv.reader(f)) - 1)


def count_jsonl_rows(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def zip_dir(source: Path, dest: Path) -> None:
    if dest.exists():
        dest.unlink()
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in sorted(source.rglob("*")):
            if file.is_file():
                zf.write(file, file.relative_to(source))


def main() -> None:
    direct_summary = read_json(ROOT / "direct_export" / "summary.json", {})
    screen_summary = read_json(ROOT / "screen_scrape" / "summary.json", {})
    standard = ROOT / "direct_export" / "standard_files"
    patient_dirs = sorted((ROOT / "direct_export" / "patients").glob("*")) if (ROOT / "direct_export" / "patients").exists() else []
    screen_patient_dirs = sorted((ROOT / "screen_scrape" / "patients").glob("*")) if (ROOT / "screen_scrape" / "patients").exists() else []

    summary = {
        "schemaVersion": "mock-homis-collection-summary.v1",
        "directExport": direct_summary,
        "screenScrape": screen_summary,
        "standardFiles": {
            "patients": count_csv_rows(standard / "patients.csv"),
            "charts": count_jsonl_rows(standard / "charts.jsonl"),
            "visits": count_csv_rows(standard / "visits.csv"),
            "problemList": count_csv_rows(standard / "problem_list.csv"),
            "documents": count_csv_rows(standard / "documents.csv"),
            "plans": count_csv_rows(standard / "plans.csv"),
            "devices": count_csv_rows(standard / "devices.csv"),
            "prescriptions": count_jsonl_rows(standard / "prescriptions.jsonl"),
            "goldActions": count_csv_rows(standard / "gold_actions.csv"),
        },
        "patientDirectoryCount": {
            "direct": len(patient_dirs),
            "screenScrape": len(screen_patient_dirs),
        }
    }
    (ROOT / "collection_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    unknowns = []
    for file in [ROOT / "direct_export" / "unknowns.md", ROOT / "screen_scrape" / "unknowns.md"]:
        if file.exists():
            unknowns.append(file.read_text(encoding="utf-8").strip())
    (ROOT / "UNKNOWN_ITEMS.md").write_text("\n\n".join(unknowns) + "\n", encoding="utf-8")

    readme = f"""# mock_homis collection

Source: `tmp/mock_homis`

This folder contains two collection paths:

- `screen_scrape/`: data collected from the running HOMIS-compatible UI via Playwright.
- `direct_export/`: data exported directly from `tmp/mock_homis/data/patients.py`.

No billing calculation was run in this step. Values that were not present in the mock UI or source data were not inferred.

## Counts

- Direct patients: {direct_summary.get('patientCount', 0)}
- Direct visits: {direct_summary.get('visitCount', 0)}
- Direct gold actions: {direct_summary.get('goldActionCount', 0)}
- Screen patients: {screen_summary.get('patientCount', 0)}
- Screen visits: {screen_summary.get('visitCount', 0)}
- Screen gold actions: {screen_summary.get('actionCount', 0)}

## Important unknowns

See `UNKNOWN_ITEMS.md`.

The most important limitation is that `action_list` contains billing item names only. It does not contain medical fee codes or points, so it is a gold action list for evaluation, not a directly uploadable receipt CSV for the current recalculation-diff endpoint.
"""
    (ROOT / "README.md").write_text(readme, encoding="utf-8")

    zip_dir(ROOT / "direct_export" / "standard_files", ROOT / "mock_homis_standard_files.zip")


if __name__ == "__main__":
    main()
