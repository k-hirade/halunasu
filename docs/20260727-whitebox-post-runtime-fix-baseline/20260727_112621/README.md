# Fee White-box Three-lane STG Run

- run: `fee-whitebox-shadow-20260727022621634-44bab9`
- status: **complete**
- revision: `fee-api-stg-00192-fw7`
- measurement cases: 10 / 10
- total calculations: 10 / 10
- determinism controls: 0 / 0 exact
- cells: 10 / 32
- degraded runs: 0
- purpose: **diagnostic**
- holdout used: no
- eligible for promotion review: no
- promotion-review blockers: diagnostic_measurement_only, holdout_not_used, matrix_incomplete, determinism_controls_incomplete, determinism_mismatch
- exact span boundaries: 29/38 (76.3%)
- overlapping span detections: 36/38 (94.7%)
- boundary mismatches: 7/38 (18.4%)
- expected current-own spans detected: 29/30 (96.7%)
- expected code semantic top-1 / top-5: 10/30 (33.3%) / 13/30 (43.3%)
- expected code shadow top-1 / top-5: 10/30 (33.3%) / 13/30 (43.3%)
- strict / shadow joint eligible spans: 0/30 (0.0%) / 2/30 (6.7%)
- strict / shadow billable inclusion: 0/30 (0.0%) / 0/30 (0.0%)
- strict / shadow standing facts: n/a / n/a
- strict / shadow safe exclusions: 0/8 (0.0%) / 2/8 (25.0%)

This diagnostic run is for bottleneck discovery only. It cannot be used as promotion evidence, even when every sampled case succeeds.

The machine precheck compares runtime encoder code sets with the reviewed synthetic dataset. It is not independent human adjudication and must not be supplied to the promotion gate as `fee-whitebox-adjudication-v1`.

Use the raw Cloud Logging export filtered by the `feeSessionId` values in `result.json` with `scripts/report_fee_whitebox_shadow.py`.
