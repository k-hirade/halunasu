# Mock HOMIS Dataset Specification

Last updated: 2026-07-02

## Purpose

`tmp/mock_homis` is a HOMIS-compatible mock EHR used to validate two things separately:

1. **Screen collection path**: whether we can collect patient, chart, problem, document, plan, prescription, and `#action_list` data from HOMIS-like DOM.
2. **Direct export path**: whether the same source data can be exported into stable files for downstream evaluation.

This is not a billing calculation step. The collection scripts must not infer missing codes, points, drug quantities, or document contents.

## Output Location

Collection output should be written under:

```text
tmp/dataset_recalculation_diff_diagnosis/<timestamp>_mock_homis/
```

Patient-specific files are stored under both paths:

```text
direct_export/patients/<patient_id>/
screen_scrape/patients/<patient_id>/
```

## Standard Files

The direct export creates `direct_export/standard_files/`.

| File | Source | Description |
| --- | --- | --- |
| `manifest.json` | `patients.py` constants | Dataset metadata, target month, previous month, file names, and counts. |
| `patients.csv` | patient master | Patient demographics, address, insurance display fields, care/disability text, and visit plan. |
| `charts.jsonl` | `visits[].soap` | One row per visit. Contains `patient_id`, `claim_month`, `service_date`, `clinical_text`, visit type/status, and source. |
| `visits.csv` | `visits[]` | One row per visit with date, type, time, status, and single-building count. |
| `problem_list.csv` | `problems[]` | Registered problems. These are not visit-specific confirmed diagnoses. |
| `documents.csv` | `docs[]` | Document kind, period, written date, and source. Document body is not present in mock source. |
| `plans.csv` | `plan` | Visit schedule pattern per patient. |
| `devices.csv` | `devices[]` | Home medical device display text. |
| `prescriptions.jsonl` | `visits[].shohou` | Prescription display blocks. Drug code, unit, and normalized dose are not inferred. |
| `gold_actions.csv` | `visits[].action_list` | Gold action display names from HOMIS action list. This is evaluation gold, not a receipt CSV. |

## Gold Action Mapping

`gold_actions.csv` contains display names only. It does not contain medical procedure codes, drug codes, material codes, or points.

To build a non-inferential mapping table:

```bash
python3 scripts/mock_homis_build_action_map.py \
  tmp/dataset_recalculation_diff_diagnosis/<timestamp>_mock_homis/direct_export/standard_files/gold_actions.csv \
  python/data/master/standard-master.sqlite \
  tmp/dataset_recalculation_diff_diagnosis/<timestamp>_mock_homis/homis_action_master_map.csv
```

Mapping statuses:

| Status | Meaning |
| --- | --- |
| `exact_master_name` | The normalized action name exactly matched one current local master row. Code and points/yen are filled. |
| `ambiguous_exact_master_name` | Multiple exact master rows matched. Manual selection is required. |
| `manual_required` | No exact local master name matched. Code is intentionally blank. |
| `comment_or_nonclaim` | The action is a date comment, free-text comment, transport fee display, or other non-claim/comment item in this mock source. |

The script deliberately does not use semantic guessing. For example, `往診` is not automatically mapped to `往診料`, and `超音波検査（断層撮影法）` is not mapped to a body-part-specific ultrasound code.

## Collection Scripts

Formal scripts live under `scripts/`:

```text
scripts/mock_homis_export_direct.py
scripts/mock_homis_scrape.cjs
scripts/mock_homis_build_collection_summary.py
scripts/mock_homis_build_action_map.py
```

Recommended run sequence:

```bash
OUT=tmp/dataset_recalculation_diff_diagnosis/$(date +%Y%m%d_%H%M%S)_mock_homis
mkdir -p "$OUT"

python3 scripts/mock_homis_export_direct.py \
  tmp/mock_homis \
  "$OUT/direct_export"

node scripts/mock_homis_scrape.cjs \
  http://127.0.0.1:8899/homic/ \
  "$OUT/screen_scrape"

python3 scripts/mock_homis_build_action_map.py \
  "$OUT/direct_export/standard_files/gold_actions.csv" \
  python/data/master/standard-master.sqlite \
  "$OUT/homis_action_master_map.csv"

python3 scripts/mock_homis_build_collection_summary.py "$OUT"
```

`mock_homis_scrape.cjs` requires the mock HOMIS server to be running and Playwright browser access.

## Known Unknowns

Do not fill these by inference during collection:

- `action_list` code and points
- Prescription drug codes, units, and normalized doses
- Visit-specific confirmed diagnoses
- Document body text
- Ambiguous material codes with the same display name

Record these in `UNKNOWN_ITEMS.md` for each collection run.

## Relationship To Recalculation Diff

This dataset is closer to a **gold evaluation dataset** than a real receipt upload:

- `gold_actions.csv` is the answer list by display name.
- It is not directly equivalent to `receipt.csv` until codes/points are confirmed.
- After mapping is reviewed, a future gold-evaluation mode can compare company-calculated actions against this gold action list.

