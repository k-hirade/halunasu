# Order CSV Contracts

This directory stores hospital-specific order CSV mapping contracts.

See `docs/implementation/order-csv-intake-checklist.md` for the full intake checklist.

Recommended layout:

```text
contracts/order-csv/
  manifest.example.json
  manifest.backlog.example.json
  manifest.outpatient-mixed.example.json
  manifest.inpatient.example.json
  manifest.step7.example.json
  manifest.step7-backlog.example.json
  <regional_bureau>/
    <medical_institution_code>/
      order-contract.json
```

Each `order-contract.json` defines the CSV columns that must be present before an order CSV can be converted into claim JSONL. The contract is used by:

- `validate-order-csv-contract`
- `run-order-csv-claim-pipeline`
- `run-order-csv-claim-pipeline-batch`

## 1. Generate A Draft

Generate the first draft from a real CSV.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli generate-order-csv-contract-template \
  --csv <orders.csv> \
  --column-map-preset japanese \
  --contract-id <regional_bureau>-<medical_institution_code>-orders-v1 \
  --hospital-name <hospital-name> \
  --regional-bureau <regional_bureau> \
  --medical-institution-code <medical_institution_code> \
  --output contracts/order-csv/<regional_bureau>/<medical_institution_code>/order-contract.json
```

## 2. Review The Contract

Review these fields before using a generated contract:

| Field | Review point |
| --- | --- |
| `required_target_fields` | Standard fields that must exist after column mapping. Keep `record_id`, patient/service/hospital keys, `item_kind`, and code fields for real-order runs. Add `expected_*` fields only when gold evaluation is required. |
| `required_source_columns` | Original CSV column names that must remain stable for this hospital. Use this to catch vendor/export layout changes. |
| `allowed_unmapped_columns` | Columns intentionally ignored by calculation. Remove columns from this list if they should be mapped instead. |
| `require_gold_labels` | Set to `true` for confirmed-claim/gold datasets. Set to `false` for pure prospective calculation. |
| `minimum_row_count` | Minimum accepted row count for the file. Keep this low for sample files, higher for scheduled production batches. |

The repository includes example contracts under `contracts/order-csv/tohoku/0410001/`.
It also includes non-PHI CSV examples:

- `data/work/example-orders/tohoku-0410001/orders.csv`: happy-path gold match.
- `data/work/example-orders/tohoku-0410001/orders-missing-comments.csv`: intentional `required_comment_input` backlog case.
- `data/work/example-orders/tohoku-0410001/outpatient-mixed-orders.csv`: initial visit, medication, injection, treatment, imaging, and lab mixed outpatient case.
- `data/work/example-orders/tohoku-0410001/inpatient-orders.csv`: inpatient basic fee and DPC review case.
- `data/work/example-orders/tohoku-0410001/inpatient-gold-orders.csv`: inpatient basic fee gold match and expected DPC review.
- `data/work/example-orders/tohoku-0410001/inpatient-gold-backlog-orders.csv`: intentional inpatient facility standard backlog case.

## 3. Validate One CSV

Validate a CSV against a reviewed contract.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-contract \
  --csv <orders.csv> \
  --contract contracts/order-csv/<regional_bureau>/<medical_institution_code>/order-contract.json \
  --output <orders-contract-validation.md> \
  --fail-on-error
```

## 4. Run One Pipeline

Run profile, contract validation, conversion, claim calculation, audit, and optional gold evaluation for one CSV.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline \
  --db data/work/standard-master.sqlite \
  --csv <orders.csv> \
  --contract contracts/order-csv/<regional_bureau>/<medical_institution_code>/order-contract.json \
  --template-jsonl data/work/nationwide-claim-contexts-2026-06-01.jsonl \
  --profile-output <profile.md> \
  --contract-output <contract-validation.md> \
  --converted-output <converted.jsonl> \
  --conversion-report-output <conversion.md> \
  --output <claim-results.md> \
  --audit-output <claim-audit.csv> \
  --gold-output <gold-evaluation.md>
```

## 5. Run Batch

Run a batch manifest and write a review index:

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.example.json \
  --output-root data/work/order-csv-pipeline \
  --output data/work/order-csv-pipeline/summary.md \
  --review-index-output data/work/order-csv-pipeline/review-index.md \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch \
  --fail-on-batch-error
```

Use `--summary-format csv` or `--summary-format tsv` when the result needs to be inspected in a spreadsheet.

## 6. Run The Backlog Example

Use the backlog manifest to verify the improvement loop without PHI. The manifest passes contract validation but intentionally omits required comment inputs, so `gold-backlog.md` and `gold-action-plan.md` should contain `required_comment_input`.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.backlog.example.json \
  --output-root data/work/order-csv-backlog-example \
  --output data/work/order-csv-backlog-example/summary.md \
  --review-index-output data/work/order-csv-backlog-example/review-index.md
```

## 7. Run The Mixed Outpatient Example

Use the mixed outpatient manifest to verify Step4 input coverage without PHI.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.outpatient-mixed.example.json \
  --output data/work/order-csv-outpatient-mixed/manifest-validation.md \
  --fail-on-error
```

For a single CSV, the direct alias is:

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-outpatient-claim-batch \
  --db data/work/standard-master.sqlite \
  --csv data/work/example-orders/tohoku-0410001/outpatient-mixed-orders.csv \
  --column-map-preset japanese \
  --converted-output data/work/order-csv-outpatient-mixed/converted.jsonl \
  --conversion-report-output data/work/order-csv-outpatient-mixed/conversion.md \
  --output data/work/order-csv-outpatient-mixed/claim-results.md \
  --audit-output data/work/order-csv-outpatient-mixed/claim-audit.csv
```

## 8. Run The Inpatient/DPC Example

Use the inpatient manifest to verify Step6 without PHI. The example intentionally has one inpatient basic fee record that can be calculated and one DPC record that must remain `needs_review`.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli validate-order-csv-pipeline-manifest \
  --manifest contracts/order-csv/manifest.inpatient.example.json \
  --output data/work/order-csv-inpatient-example/manifest-validation.md \
  --fail-on-error
```

For a single CSV, the direct alias is:

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-inpatient-claim-batch \
  --db data/work/standard-master.sqlite \
  --csv data/work/example-orders/tohoku-0410001/inpatient-orders.csv \
  --column-map-preset japanese \
  --converted-output data/work/order-csv-inpatient-example/converted.jsonl \
  --conversion-report-output data/work/order-csv-inpatient-example/conversion.md \
  --output data/work/order-csv-inpatient-example/claim-results.md \
  --audit-output data/work/order-csv-inpatient-example/claim-audit.csv
```

## 9. Run The Step7 Gold Example

Use the Step7 manifest to verify outpatient gold, inpatient basic fee gold, and expected DPC review in one non-PHI batch.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.step7.example.json \
  --output-root data/work/order-csv-step7-example \
  --output data/work/order-csv-step7-example/summary.md \
  --review-index-output data/work/order-csv-step7-example/review-index.md \
  --fail-on-contract-error \
  --fail-on-error \
  --fail-on-mismatch
```

Use the Step7 backlog manifest to verify that gold differences are routed into action plans.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m medical_fee_calculation.cli run-order-csv-claim-pipeline-batch \
  --db data/work/standard-master.sqlite \
  --manifest contracts/order-csv/manifest.step7-backlog.example.json \
  --output-root data/work/order-csv-step7-backlog-example \
  --output data/work/order-csv-step7-backlog-example/summary.md \
  --review-index-output data/work/order-csv-step7-backlog-example/review-index.md
```
